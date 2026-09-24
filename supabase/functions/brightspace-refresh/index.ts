/* ============================================================================
   Edge Function 4/6 : brightspace-refresh — RAFRAÎCHIR LE TOKEN
   ----------------------------------------------------------------------------
   Échange le refresh token contre un nouveau couple access/refresh.

   Le rafraîchissement est normalement AUTOMATIQUE : brightspace-api le
   déclenche dès qu'un token approche de l'expiration. Cette fonction existe
   pour les deux cas où il doit pouvoir être provoqué explicitement :
     • remettre une connexion en état sans attendre la prochaine
       synchronisation (bouton de diagnostic) ;
     • réparer une connexion marquée `expired` à tort.

   Elle ne renvoie JAMAIS le token au navigateur : seulement l'échéance et le
   statut. Le token reste chiffré en base, dans des colonnes qu'aucun rôle
   exposé au navigateur n'a le droit de lire.

   Déploiement : JWT vérifié.
   ============================================================================ */

import { readEnv, requireUser, adminClient, json, errorResponse, corsHeaders, resolveOrigin } from "../_shared/lib.ts";
import { loadConnection, ensureAccessToken, ReconnectRequired } from "../_shared/connection.ts";
import { BrightspaceError } from "../_shared/brightspace.ts";

Deno.serve(async (req) => {
  let origin = "";
  try {
    const env = readEnv();
    origin = resolveOrigin(req.headers.get("Origin"), env.allowedOrigins, env.appUrl);
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

    const userId = await requireUser(req, env);
    const db = adminClient(env);

    const conn = await loadConnection(db, userId);
    if (!conn) {
      return json({ error: "not_connected", message: "Aucun compte Brightspace connecté." }, 409, origin);
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    /* `force` sert au diagnostic : il rafraîchit même si le token courant est
       encore valide. Sans lui, la fonction est idempotente et ne consomme pas
       inutilement un refresh token (ils sont à usage unique). */
    const force = body?.force === true;
    const conn2 = force ? { ...conn, token_expires_at: new Date(0).toISOString() } : conn;

    try {
      await ensureAccessToken(env, db, conn2);
    } catch (e) {
      if (e instanceof ReconnectRequired) {
        return json({
          error: "expired", reconnectRequired: true,
          message: "Ta session Brightspace a expiré. Reconnecte ton compte pour continuer.",
        }, 409, origin);
      }
      if (e instanceof BrightspaceError && e.status === 409) {
        return json({
          error: "busy", retryable: true,
          message: "Un rafraîchissement est déjà en cours. Réessaie dans un instant.",
        }, 409, origin);
      }
      throw e;
    }

    const fresh = await loadConnection(db, userId);
    return json({
      ok: true,
      status: fresh?.status ?? "connected",
      // Aucune valeur de token ici — uniquement de quoi diagnostiquer.
      tokenExpiresAt: fresh?.token_expires_at ?? null,
      tokenRotatedAt: fresh?.token_rotated_at ?? null,
      refreshCount: fresh?.refresh_count ?? 0,
    }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
