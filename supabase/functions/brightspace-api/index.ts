/* ============================================================================
   Edge Function : brightspace-api
   ------------------------------------------------------------------------
   Proxy authentifié vers l'API Brightspace. C'est le SEUL chemin par lequel
   REV-EM parle à Brightspace.

   Pourquoi un proxy plutôt qu'un appel direct depuis le navigateur :
     • le token Brightspace ne doit jamais atteindre le frontend (§19) ;
     • l'API Brightspace n'autorise pas les appels cross-origin depuis une
       page web — un fetch() direct échouerait de toute façon ;
     • le rafraîchissement de token est géré ici, de façon transparente.

   Pourquoi ce proxy ne NORMALISE pas et n'ÉCRIT pas en base :
     la normalisation vit dans content-sources.js, module pur déjà chargé par
     le frontend et testé unitairement. La dupliquer ici en TypeScript
     créerait deux implémentations à maintenir. Le client normalise, calcule
     le diff, puis écrit lui-même dans subjects/chapters — écritures
     protégées par RLS plutôt que par service_role (défense en profondeur :
     même cette fonction ne peut pas écrire dans les cours d'un autre).

   Opérations exposées (liste blanche stricte — jamais d'URL arbitraire
   transmise par le client) :
     { op: "courses" }
     { op: "content",   orgUnitId }
     { op: "topicText", orgUnitId, topicId }
   ============================================================================ */

import {
  readEnv, requireUser, adminClient, encryptSecret, decryptSecret,
  json, errorResponse, corsHeaders, AuthError,
} from "../_shared/lib.ts";
import {
  getMyCourses, getCourseContent, getTopicText, refreshTokens, BrightspaceError,
} from "../_shared/brightspace.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "*";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const env = readEnv();
    const userId = await requireUser(req, env);
    const db = adminClient(env);

    const { data: conn, error } = await db
      .from("brightspace_connections")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (!conn) return json({ error: "not_connected", message: "Aucun compte Brightspace connecté." }, 409, origin);
    if (conn.status === "revoked") {
      return json({ error: "revoked", message: "La connexion Brightspace a été révoquée. Reconnecte ton compte." }, 409, origin);
    }

    /* ---- token valide, rafraîchi si nécessaire ---- */
    let accessToken: string;
    try {
      accessToken = await ensureAccessToken(env, db, conn);
    } catch (e) {
      // Refresh impossible : on marque la connexion pour que l'UI propose
      // une reconnexion, sans jamais exposer le détail technique (§18).
      await db.from("brightspace_connections")
        .update({ status: "expired", last_error: String(e).slice(0, 500) })
        .eq("user_id", userId);
      return json({
        error: "expired",
        message: "Ta session Brightspace a expiré. Reconnecte ton compte pour continuer.",
      }, 409, origin);
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const op = String(body.op || "");

    switch (op) {
      case "courses": {
        const items = await getMyCourses(env, accessToken);
        return json({ op, items }, 200, origin);
      }
      case "content": {
        const orgUnitId = sanitizeId(body.orgUnitId);
        if (!orgUnitId) return json({ error: "bad_request", message: "orgUnitId manquant." }, 400, origin);
        const items = await getCourseContent(env, accessToken, orgUnitId);
        return json({ op, orgUnitId, items }, 200, origin);
      }
      case "topicText": {
        const orgUnitId = sanitizeId(body.orgUnitId);
        const topicId = sanitizeId(body.topicId);
        if (!orgUnitId || !topicId) return json({ error: "bad_request", message: "Identifiants manquants." }, 400, origin);
        // null = non extractible (binaire, trop gros, ou non autorisé).
        // On le dit explicitement plutôt que de renvoyer du vide ambigu.
        const text = await getTopicText(env, accessToken, orgUnitId, topicId);
        return json({ op, orgUnitId, topicId, text, extracted: text !== null }, 200, origin);
      }
      default:
        return json({ error: "bad_request", message: "Opération inconnue." }, 400, origin);
    }
  } catch (e) {
    if (e instanceof BrightspaceError) {
      const status = e.status === 403 ? 403 : e.retryable ? 503 : 502;
      return json({
        error: e.status === 403 ? "forbidden" : "upstream",
        retryable: e.retryable,
        message: e.status === 403
          ? "Certaines ressources ne sont pas accessibles avec les permissions accordées."
          : "Brightspace est momentanément indisponible. Tes cours déjà importés restent disponibles.",
      }, status, origin);
    }
    if (e instanceof AuthError) return errorResponse(e, origin);
    return errorResponse(e, origin);
  }
});

/* Identifiants Brightspace : entiers uniquement. Empêche qu'une valeur
   client ne serve à construire un chemin d'API arbitraire. */
function sanitizeId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[0-9]{1,20}$/.test(s) ? s : null;
}

/* Renvoie un access token valide, en rafraîchissant si l'expiration approche.
   Le nouveau refresh token (si Brightspace en émet un) remplace l'ancien ;
   s'il n'en renvoie pas, on conserve celui en place. */
async function ensureAccessToken(
  env: ReturnType<typeof readEnv>,
  db: ReturnType<typeof adminClient>,
  conn: Record<string, unknown>,
): Promise<string> {
  const expiresAt = conn.token_expires_at ? Date.parse(String(conn.token_expires_at)) : 0;
  const stillValid = expiresAt > Date.now() + 60_000;

  if (stillValid && conn.access_token_enc) {
    return await decryptSecret(String(conn.access_token_enc), env.encKey);
  }
  if (!conn.refresh_token_enc) {
    throw new Error("Aucun refresh token disponible : reconnexion nécessaire.");
  }

  const refreshToken = await decryptSecret(String(conn.refresh_token_enc), env.encKey);
  const tokens = await refreshTokens(env, refreshToken);

  const patch: Record<string, unknown> = {
    access_token_enc: await encryptSecret(tokens.accessToken, env.encKey),
    token_expires_at: new Date(tokens.expiresAt).toISOString(),
    status: "connected",
    last_error: null,
  };
  if (tokens.refreshToken) {
    patch.refresh_token_enc = await encryptSecret(tokens.refreshToken, env.encKey);
  }
  await db.from("brightspace_connections").update(patch).eq("user_id", conn.user_id as string);

  return tokens.accessToken;
}
