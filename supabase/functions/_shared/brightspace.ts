/* ============================================================================
   REV-EM — client API Brightspace (D2L Valence) côté serveur
   ------------------------------------------------------------------------
   Toute la communication avec Brightspace passe par ici. Le navigateur
   n'appelle JAMAIS Brightspace directement, pour deux raisons :
     1. le client_secret est requis à l'échange de token (Basic Auth) et ne
        peut pas vivre dans le frontend ;
     2. l'API Brightspace n'émet pas d'en-têtes CORS autorisant une origine
        arbitraire — un fetch() depuis GitHub Pages échouerait de toute façon.

   ⚠️ ENDPOINTS À CONFIRMER — la documentation D2L
   (docs.valence.desire2learn.com / community.d2l.com) était inaccessible
   depuis l'environnement de développement (blocage réseau). Les endpoints
   OAuth ci-dessous proviennent de sources secondaires concordantes ; les
   endpoints de CONTENU suivent les conventions Valence documentées mais
   n'ont pas pu être vérifiés contre un tenant réel.

   Avant mise en production, confirmer avec l'administrateur Brightspace :
     • la version d'API LP/LE du tenant (constantes LP_VERSION / LE_VERSION) ;
     • les chemins de contenu exacts ;
     • les scopes réellement accordés.
   Tout est centralisé ici pour qu'une correction tienne en quelques lignes.
   ============================================================================ */

import { Env } from "./lib.ts";

/* Versions d'API. À aligner sur ce que renvoie /d2l/api/versions/ du tenant. */
export const LP_VERSION = Deno.env.get("BRIGHTSPACE_LP_VERSION") || "1.31";
export const LE_VERSION = Deno.env.get("BRIGHTSPACE_LE_VERSION") || "1.67";

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export class BrightspaceError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    // 408/429/5xx : réessayables. 401/403 : non (token ou permissions).
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/* ---------- OAuth ---------- */

export function authorizationUrl(env: Env, state: string, redirectUri: string): string {
  const u = new URL(`${env.authBase}/oauth2/auth`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", env.scopes);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/* client_id/client_secret en Basic Auth, conformément aux exemples officiels
   D2L (Extensibility-Samples). C'est cette exigence qui impose un backend. */
async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const basic = btoa(`${env.clientId}:${env.clientSecret}`);

  const res = await fetch(`${env.authBase}/core/connect/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new BrightspaceError(`Échec de l'échange de token (${res.status}) : ${text.slice(0, 300)}`, res.status);
  }

  let data: Record<string, unknown>;
  try { data = JSON.parse(text); }
  catch { throw new BrightspaceError("Réponse de token illisible.", 502); }

  const accessToken = String(data.access_token || "");
  if (!accessToken) throw new BrightspaceError("Aucun access_token dans la réponse.", 502);

  const expiresIn = Number(data.expires_in || 3600);
  return {
    accessToken,
    // Brightspace peut ne pas renvoyer de nouveau refresh_token à chaque
    // rafraîchissement : l'appelant conserve alors l'ancien (voir sync).
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000, // marge d'1 min
    scopes: String(data.scope || "").split(" ").filter(Boolean),
  };
}

/* ---------- API ---------- */

async function apiGet<T>(env: Env, accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${env.tenantUrl}${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" },
  });
  if (res.status === 401) throw new BrightspaceError("Token Brightspace refusé.", 401);
  if (res.status === 403) throw new BrightspaceError("Permissions insuffisantes pour cette ressource.", 403);
  if (res.status === 404) throw new BrightspaceError("Ressource introuvable.", 404);
  if (!res.ok) {
    throw new BrightspaceError(`Appel Brightspace en échec (${res.status}) sur ${path}`, res.status);
  }
  return await res.json() as T;
}

/* Cours auxquels l'utilisateur a accès. La route "myenrollments" est paginée
   via un bookmark : on suit la pagination jusqu'au bout, avec une borne dure
   pour ne jamais boucler indéfiniment sur une réponse inattendue. */
export async function getMyCourses(env: Env, accessToken: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let bookmark = "";
  for (let page = 0; page < 50; page++) {
    const q = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : "";
    const data = await apiGet<Record<string, unknown>>(
      env, accessToken, `/d2l/api/lp/${LP_VERSION}/enrollments/myenrollments/${q}`,
    );
    const items = (data.Items || data.items || []) as unknown[];
    out.push(...items);
    const more = data.PagingInfo || data.pagingInfo;
    const hasMore = more && (more as Record<string, unknown>).HasMoreItems;
    bookmark = String((more as Record<string, unknown>)?.Bookmark || "");
    if (!hasMore || !bookmark) break;
  }
  return out;
}

/* Arborescence de contenu d'un cours (modules + topics, récursif). */
export async function getCourseContent(env: Env, accessToken: string, orgUnitId: string): Promise<unknown[]> {
  return await apiGet<unknown[]>(env, accessToken, `/d2l/api/le/${LE_VERSION}/${orgUnitId}/content/root/`);
}

/* Récupère le TEXTE d'un topic quand c'est possible et pertinent.
   Ne télécharge jamais un binaire volumineux ni un site externe (§8) :
     • lien externe            -> jamais téléchargé ;
     • fichier > maxBytes      -> ignoré, signalé non extrait ;
     • type non textuel        -> ignoré.
   Retourne null quand le contenu n'est pas extractible — jamais une
   invention. */
export async function getTopicText(
  env: Env, accessToken: string, orgUnitId: string, topicId: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const res = await fetch(
    `${env.tenantUrl}/d2l/api/le/${LE_VERSION}/${orgUnitId}/content/topics/${topicId}/file`,
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

function stripHtml(html: string): string {
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
