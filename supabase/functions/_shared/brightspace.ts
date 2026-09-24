/* ============================================================================
   REV-EM — client OAuth 2.0 + API Brightspace (D2L Valence), côté serveur
   ----------------------------------------------------------------------------
   Toute la communication avec Brightspace passe par ici. Le navigateur
   n'appelle JAMAIS Brightspace directement, pour deux raisons vérifiées :

     1. l'échange de token exige le `client_secret`, transmis en HTTP Basic
        Authentication (exemples officiels D2L, Extensibility-Samples/docs/
        authentication.md) — un secret ne peut pas vivre dans une page ;
     2. l'API Brightspace n'émet pas d'en-têtes CORS pour une origine
        arbitraire : un fetch() depuis GitHub Pages échouerait de toute façon.

   ── SOURCES ET NIVEAU DE CERTITUDE ─────────────────────────────────────────
   community.d2l.com et docs.valence.desire2learn.com sont INACCESSIBLES depuis
   l'environnement de développement (blocage réseau de l'hébergeur, vérifié :
   « EGRESS_BLOCKED »). Ce qui suit est donc étayé par des sources secondaires
   CONCORDANTES, et le niveau de certitude est indiqué point par point :

     • CONFIRMÉ (plusieurs sources indépendantes, dont le dépôt officiel
       Brightspace/Extensibility-Samples) :
         - autorisation : {authBase}/oauth2/auth
           paramètres response_type=code, client_id, redirect_uri, scope, state
         - token        : {authBase}/core/connect/token
         - client_id/client_secret en Basic Auth sur la requête de token
         - le `state` renvoyé doit être comparé à celui émis
         - format de scope : groupe:ressource:permission, jokers admis
     • CONFIRMÉ (documentation D2L « How to obtain an OAuth 2.0 Refresh
       Token ») : le refresh token est À USAGE UNIQUE et l'échange renvoie un
       NOUVEAU couple access/refresh. L'application doit cocher « Enable
       refresh tokens » à l'enregistrement.
     • NON VÉRIFIÉ : les versions d'API LP/LE du tenant, les chemins de contenu
       exacts, la liste des scopes réellement exposés, l'existence d'un
       endpoint de révocation. Tous sont donc CONFIGURABLES (voir env.ts) et
       centralisés ici : une correction tient en une ligne, sans redéploiement
       du reste.

   À confronter au tenant réel avant mise en production — voir
   BRIGHTSPACE_SETUP.md.
   ============================================================================ */

import type { Env } from "./env.ts";

export interface TokenSet {
  accessToken: string;
  /* Brightspace émet un NOUVEAU refresh token à chaque échange (rotation).
     null signifie que la réponse n'en contenait pas — cas anormal, traité
     explicitement par l'appelant, jamais silencieusement. */
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export interface Identity {
  externalUserId: string | null;
  displayName: string | null;
}

export class BrightspaceError extends Error {
  status: number;
  retryable: boolean;
  /* `invalid_grant` : le refresh token n'est plus valide (déjà échangé,
     expiré, ou révoqué côté Brightspace). C'est le seul cas qui impose une
     reconnexion de l'utilisateur — il est donc distingué des autres. */
  invalidGrant: boolean;
  constructor(message: string, status: number, invalidGrant = false) {
    super(message);
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
    this.invalidGrant = invalidGrant;
  }
}

/* `fetch` est injectable : les tests vérifient les requêtes RÉELLEMENT émises
   (URL, en-têtes, corps) sans appeler Brightspace. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/* ============================================================================
   OAuth 2.0 — code d'autorisation
   ============================================================================ */

export function authorizationUrl(env: Env, state: string, redirectUri: string): string {
  const u = new URL(`${env.authBase}/oauth2/auth`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", env.scopes);
  u.searchParams.set("state", state);
  return u.toString();
}

export function callbackUrl(env: Env): string {
  return `${env.supabaseUrl}/functions/v1/brightspace-callback`;
}

export function exchangeCode(env: Env, code: string, redirectUri: string, f: FetchLike = fetch): Promise<TokenSet> {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f);
}

export function refreshTokens(env: Env, refreshToken: string, f: FetchLike = fetch): Promise<TokenSet> {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken }, f);
}

async function tokenRequest(env: Env, params: Record<string, string>, f: FetchLike): Promise<TokenSet> {
  const res = await f(`${env.authBase}/core/connect/token`, {
    method: "POST",
    headers: {
      // Basic Auth : c'est cette exigence qui impose un backend.
      "Authorization": `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    let code = "";
    try { code = String((JSON.parse(text) as Record<string, unknown>).error || ""); } catch { /* corps non JSON */ }
    throw new BrightspaceError(
      `Échec de l'échange de token (${res.status}) : ${text.slice(0, 300)}`,
      res.status,
      code === "invalid_grant",
    );
  }

  let data: Record<string, unknown>;
  try { data = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new BrightspaceError("Réponse de token illisible.", 502); }

  const accessToken = String(data.access_token || "");
  if (!accessToken) throw new BrightspaceError("Aucun access_token dans la réponse.", 502);

  const expiresIn = Number(data.expires_in || 3600);
  return {
    accessToken,
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    // Marge d'une minute : on rafraîchit avant l'expiration réelle plutôt que
    // de découvrir un 401 en plein import.
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    scopes: String(data.scope || "").split(" ").filter(Boolean),
  };
}

/* Révocation côté fournisseur. NON APPELÉE tant que BRIGHTSPACE_REVOCATION_PATH
   n'est pas renseigné : l'endpoint n'a pas pu être confirmé dans la
   documentation D2L, et appeler une URL devinée n'a aucun sens.
   Retourne `false` si la révocation n'est pas configurée ou échoue — la
   déconnexion locale, elle, a toujours lieu. */
export async function revokeToken(env: Env, token: string, f: FetchLike = fetch): Promise<boolean> {
  if (!env.revocationPath) return false;
  try {
    const res = await f(`${env.authBase}${env.revocationPath}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, token_type_hint: "refresh_token" }).toString(),
    });
    return res.ok;
  } catch (e) {
    console.error("[brightspace] révocation impossible", e);
    return false;
  }
}

/* ============================================================================
   API Valence
   ============================================================================ */

async function apiGet<T>(env: Env, accessToken: string, path: string, f: FetchLike = fetch): Promise<T> {
  const res = await f(`${env.tenantUrl}${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" },
  });
  if (res.status === 401) throw new BrightspaceError("Token Brightspace refusé.", 401);
  if (res.status === 403) throw new BrightspaceError("Permissions insuffisantes pour cette ressource.", 403);
  if (res.status === 404) throw new BrightspaceError("Ressource introuvable.", 404);
  if (!res.ok) throw new BrightspaceError(`Appel Brightspace en échec (${res.status}) sur ${path}`, res.status);
  return await res.json() as T;
}

/* whoami — c'est LA vérification d'une connexion : un appel authentifié réel.
   Tant qu'il n'a pas abouti, REV-EM n'affirme pas être connecté. */
export async function whoami(env: Env, accessToken: string, f: FetchLike = fetch): Promise<Identity> {
  const data = await apiGet<Record<string, unknown>>(
    env, accessToken, `/d2l/api/lp/${env.lpVersion}/users/whoami`, f,
  );
  const id = data.Identifier ?? data.identifier ?? data.UserId ?? null;
  const name = data.FirstName && data.LastName
    ? `${data.FirstName} ${data.LastName}`
    : (data.UniqueName ?? data.uniqueName ?? data.DisplayName ?? null);
  return {
    externalUserId: id === null || id === undefined ? null : String(id),
    displayName: name === null || name === undefined ? null : String(name),
  };
}

/* Cours auxquels l'utilisateur a accès. Route paginée par bookmark : on suit
   la pagination jusqu'au bout, avec une borne dure pour ne jamais boucler
   indéfiniment sur une réponse inattendue. */
export async function getMyCourses(env: Env, accessToken: string, f: FetchLike = fetch): Promise<unknown[]> {
  const out: unknown[] = [];
  let bookmark = "";
  for (let page = 0; page < 50; page++) {
    const q = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : "";
    const data = await apiGet<Record<string, unknown>>(
      env, accessToken, `/d2l/api/lp/${env.lpVersion}/enrollments/myenrollments/${q}`, f,
    );
    const items = (data.Items || data.items || []) as unknown[];
    out.push(...items);
    const more = (data.PagingInfo || data.pagingInfo) as Record<string, unknown> | undefined;
    const hasMore = more && more.HasMoreItems;
    bookmark = String(more?.Bookmark || "");
    if (!hasMore || !bookmark) break;
  }
  return out;
}

export function getCourseContent(env: Env, accessToken: string, orgUnitId: string, f: FetchLike = fetch): Promise<unknown[]> {
  return apiGet<unknown[]>(env, accessToken, `/d2l/api/le/${env.leVersion}/${orgUnitId}/content/root/`, f);
}

/* Récupère le TEXTE d'un topic quand c'est possible et pertinent.
   Ne télécharge jamais un binaire volumineux ni un site externe :
     • lien externe       → jamais téléchargé ;
     • fichier > maxBytes → ignoré, signalé non extrait ;
     • type non textuel   → ignoré.
   Retourne null quand le contenu n'est pas extractible — jamais une invention. */
export async function getTopicText(
  env: Env, accessToken: string, orgUnitId: string, topicId: string,
  opts: { maxBytes?: number } = {}, f: FetchLike = fetch,
): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const res = await f(
    `${env.tenantUrl}/d2l/api/le/${env.leVersion}/${orgUnitId}/content/topics/${topicId}/file`,
    { headers: { "Authorization": `Bearer ${accessToken}` } },
  );
  if (res.status === 403 || res.status === 404) return null; // inaccessible : on ne contourne rien
  if (!res.ok) throw new BrightspaceError(`Téléchargement du topic ${topicId} en échec (${res.status})`, res.status);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) return null;

  // Seuls les formats textuels sont extraits ici. Les PDF/DOCX restent des
  // ressources téléchargeables côté appareil : leur extraction réutilise le
  // pipeline d'import existant du frontend, jamais une seconde implémentation.
  if (type.includes("text/") || type.includes("application/json") || type.includes("xhtml")) {
    const raw = await res.text();
    if (raw.length > maxBytes) return null;
    return type.includes("html") || type.includes("xhtml") ? stripHtml(raw) : raw;
  }
  return null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
