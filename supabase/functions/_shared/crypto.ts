/* ============================================================================
   REV-EM — primitives cryptographiques des Edge Functions
   ----------------------------------------------------------------------------
   AUCUNE dépendance : ni Supabase, ni Deno, ni réseau. C'est délibéré — ce
   fichier est le plus sensible du projet, il doit pouvoir être exécuté et
   testé tel quel (voir tests/edge-oauth.test.js).

   ⚠️ Code SERVEUR uniquement. Rien ici ne doit atteindre le navigateur.
   ============================================================================ */

export class AuthError extends Error {}
export class ConfigError extends Error {}

/* ---------- chiffrement des tokens (AES-256-GCM) ---------- */

async function aesKey(rawBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawBase64);
  if (raw.length !== 32) {
    throw new ConfigError("BRIGHTSPACE_TOKEN_ENC_KEY doit être 32 octets encodés en base64 (clé AES-256).");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* Format produit : base64url(iv) + "." + base64url(chiffré).
   L'IV est tiré au hasard à CHAQUE chiffrement et n'est jamais réutilisé —
   exigence absolue d'AES-GCM : réutiliser un IV avec la même clé casse la
   confidentialité ET l'authenticité. */
export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(buf))}`;
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const [ivB64, dataB64] = String(payload).split(".");
  if (!ivB64 || !dataB64) throw new Error("Format de secret chiffré invalide.");
  const key = await aesKey(keyB64);
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(dataB64),
  );
  return new TextDecoder().decode(buf);
}

/* ---------- paramètre `state` du flux d'autorisation ---------- */

/* Le callback OAuth arrive comme une simple redirection de navigateur, SANS
   session Supabase. L'identité de l'utilisateur doit donc voyager dans le
   paramètre `state`. Deux protections, indépendantes :

     • ici       : signature HMAC-SHA256 + expiration courte → un tiers ne peut
                   pas FORGER un state rattachant sa connexion Brightspace au
                   compte REV-EM de quelqu'un d'autre ;
     • en base   : le nonce est consommé à l'usage (oauth-state.ts) → un state
                   authentique ne peut pas être REJOUÉ dans sa fenêtre de
                   validité.

   La signature seule ne suffit pas, le nonce seul non plus. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface StatePayload {
  userId: string;
  nonce: string;
  expiresAt: number;
}

export async function signState(userId: string, nonce: string, secret: string, ttlMs = STATE_TTL_MS): Promise<string> {
  const payload = { u: userId, n: nonce, e: Date.now() + ttlMs };
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, secret);
  return `${body}.${sig}`;
}

export async function verifyState(state: string, secret: string): Promise<StatePayload> {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) throw new AuthError("Paramètre state invalide.");
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(sig, expected)) throw new AuthError("Signature du state invalide.");

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(new TextDecoder().decode(base64ToBytes(body))); }
  catch { throw new AuthError("State illisible."); }

  if (!payload?.u || !payload?.n) throw new AuthError("State incomplet.");
  if (typeof payload.e !== "number" || Date.now() > payload.e) throw new AuthError("Demande de connexion expirée.");
  return { userId: String(payload.u), nonce: String(payload.n), expiresAt: payload.e as number };
}

export function randomNonce(bytes = 24): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64(new Uint8Array(sig));
}

/* Comparaison à temps constant : une comparaison ordinaire s'arrête au premier
   octet différent, ce qui laisse deviner la signature attendue en mesurant le
   temps de réponse. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- base64url ---------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToBytes(b64: string): Uint8Array {
  const norm = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
