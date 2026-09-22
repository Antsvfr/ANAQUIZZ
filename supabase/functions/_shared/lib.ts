/* ============================================================================
   REV-EM — utilitaires partagés des Edge Functions Brightspace
   ------------------------------------------------------------------------
   Rien ici n'est spécifique à Brightspace : chiffrement des secrets, state
   OAuth signé, client Supabase admin, CORS, réponses d'erreur.

   ⚠️ Ce code s'exécute UNIQUEMENT côté serveur (Supabase Edge Functions,
   runtime Deno). Aucune de ces valeurs ne doit jamais atteindre le navigateur.
   ============================================================================ */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/* ---------- configuration ---------- */

export interface Env {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientId: string;
  clientSecret: string;
  tenantUrl: string;
  encKey: string;
  appUrl: string;
  authBase: string;
  scopes: string;
}

/* Lit et VALIDE la configuration. Échoue bruyamment et tôt : une Edge
   Function mal configurée doit être évidente immédiatement, pas produire un
   comportement à moitié fonctionnel. */
export function readEnv(): Env {
  const get = (k: string, required = true): string => {
    const v = Deno.env.get(k) ?? "";
    if (required && !v) throw new ConfigError(`Variable d'environnement manquante : ${k}`);
    return v;
  };
  return {
    supabaseUrl: get("SUPABASE_URL"),
    serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY"),
    clientId: get("BRIGHTSPACE_CLIENT_ID"),
    clientSecret: get("BRIGHTSPACE_CLIENT_SECRET"),
    tenantUrl: get("BRIGHTSPACE_TENANT_URL").replace(/\/+$/, ""),
    encKey: get("BRIGHTSPACE_TOKEN_ENC_KEY"),
    appUrl: get("BRIGHTSPACE_APP_URL").replace(/\/+$/, ""),
    // Surchargeables : les endpoints publics D2L sont les mêmes pour tous les
    // tenants, mais on ne les code pas en dur pour pouvoir les corriger sans
    // redéployer si D2L les fait évoluer.
    authBase: Deno.env.get("BRIGHTSPACE_AUTH_BASE") || "https://auth.brightspace.com",
    scopes: Deno.env.get("BRIGHTSPACE_SCOPES") || "core:*:read",
  };
}

export class ConfigError extends Error {}

/* ---------- client Supabase admin ---------- */

/* service_role : contourne RLS. N'est utilisé que par les Edge Functions,
   jamais exposé. C'est ce qui permet d'écrire dans brightspace_connections,
   table sur laquelle le client n'a AUCUNE policy d'écriture. */
export function adminClient(env: Env): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* Vérifie le JWT Supabase de l'appelant et retourne son user id.
   Utilisé par les fonctions appelées DEPUIS l'application (connect, sync,
   disconnect) — jamais par le callback OAuth, qui arrive sans session. */
export async function requireUser(req: Request, env: Env): Promise<string> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new AuthError("Authentification requise.");
  const { data, error } = await adminClient(env).auth.getUser(token);
  if (error || !data?.user) throw new AuthError("Session invalide ou expirée.");
  return data.user.id;
}

export class AuthError extends Error {}

/* ---------- chiffrement des tokens (AES-GCM) ---------- */

async function aesKey(rawBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawBase64);
  if (raw.length !== 32) {
    throw new ConfigError("BRIGHTSPACE_TOKEN_ENC_KEY doit être 32 octets encodés en base64 (clé AES-256).");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* Format produit : base64(iv) + "." + base64(ciphertext).
   L'IV est aléatoire à chaque chiffrement (jamais réutilisé) — exigence
   absolue d'AES-GCM. */
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

/* ---------- state OAuth signé ---------- */

/* Le callback OAuth arrive comme une simple redirection de navigateur, SANS
   session Supabase. L'identité de l'utilisateur doit donc voyager dans le
   paramètre `state` — et ce state doit être signé, sinon n'importe qui
   pourrait rattacher un compte Brightspace arbitraire au compte REV-EM d'un
   autre utilisateur. HMAC-SHA256 + expiration courte. */
const STATE_TTL_MS = 10 * 60 * 1000;

export async function signState(userId: string, secret: string): Promise<string> {
  const payload = { u: userId, n: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))), e: Date.now() + STATE_TTL_MS };
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, secret);
  return `${body}.${sig}`;
}

export async function verifyState(state: string, secret: string): Promise<string> {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) throw new AuthError("Paramètre state invalide.");
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(sig, expected)) throw new AuthError("Signature du state invalide.");
  const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (!payload?.u) throw new AuthError("State incomplet.");
  if (typeof payload.e !== "number" || Date.now() > payload.e) throw new AuthError("Demande de connexion expirée.");
  return payload.u as string;
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64(new Uint8Array(sig));
}

/* Comparaison à temps constant : évite de laisser fuiter la signature
   attendue par mesure du temps de réponse. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- base64 ---------- */

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const norm = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- HTTP ---------- */

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

export function json(body: unknown, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

/* Traduit une erreur interne en message utilisateur compréhensible, sans
   jamais exposer de détail technique brut au navigateur (§18). Le détail
   reste dans les logs de la fonction. */
export function errorResponse(e: unknown, origin = "*"): Response {
  console.error("[brightspace]", e);
  if (e instanceof AuthError) return json({ error: "auth", message: e.message }, 401, origin);
  if (e instanceof ConfigError) {
    return json({ error: "config", message: "L'intégration Brightspace n'est pas encore configurée sur ce serveur." }, 500, origin);
  }
  return json({ error: "unexpected", message: "Une erreur est survenue. Réessaie dans un instant." }, 500, origin);
}
