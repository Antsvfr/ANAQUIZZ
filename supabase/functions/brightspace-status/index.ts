/* ============================================================================
   Edge Function 5/6 : brightspace-status — VÉRIFIER LA CONNEXION
   ----------------------------------------------------------------------------
   « Connecté » n'est pas une case cochée en base : c'est un appel authentifié
   qui aboutit RÉELLEMENT chez Brightspace. Cette fonction en fait un (route
   whoami) et rapporte ce qu'elle a constaté — rien de plus.

   C'est ce qui permet à l'interface de n'afficher « Connecté » que si OAuth a
   réellement réussi, et de distinguer trois situations que l'utilisateur vit
   très différemment :
     • connecté et vérifié       → tout fonctionne, on nomme le compte relié ;
     • session expirée           → il faut se reconnecter, on le dit ;
     • permissions insuffisantes → ce n'est pas à l'utilisateur de le corriger,
                                   c'est l'administrateur : on ne lui propose
                                   donc pas une reconnexion qui ne réglerait rien.

   Le mode `{ probe: false }` se contente de rapporter l'état enregistré, sans
   appeler Brightspace : utile pour un affichage immédiat au chargement.

   Déploiement : JWT vérifié.
   ============================================================================ */

import { readEnv, requireUser, adminClient, json, errorResponse, corsHeaders, resolveOrigin } from "../_shared/lib.ts";
import { loadConnection, verifyConnection } from "../_shared/connection.ts";

Deno.serve(async (req) => {
  let origin = "";
  try {
    const env = readEnv();
    origin = resolveOrigin(req.headers.get("Origin"), env.allowedOrigins, env.appUrl);
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

    const userId = await requireUser(req, env);
    const db = adminClient(env);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const probe = body?.probe !== false;   // vérification réelle par défaut

    if (!probe) {
      const conn = await loadConnection(db, userId);
      return json({
        connected: !!conn && conn.status === "connected",
        verified: !!conn?.last_verified_at,
        status: conn?.status ?? "not_connected",
        tenantUrl: conn?.tenant_url ?? null,
        account: conn?.external_user_name ?? null,
        scopes: conn?.scopes ?? [],
        lastVerifiedAt: conn?.last_verified_at ?? null,
        lastSyncedAt: conn?.last_synced_at ?? null,
        probed: false,
      }, 200, origin);
    }

    const result = await verifyConnection(env, db, userId);
    return json({
      // `connected: true` n'est renvoyé QUE si un appel authentifié a abouti.
      connected: result.ok,
      verified: result.ok,
      status: result.status,
      tenantUrl: result.tenantUrl,
      account: result.identity?.displayName ?? null,
      externalUserId: result.identity?.externalUserId ?? null,
      scopes: result.scopes,
      lastVerifiedAt: result.lastVerifiedAt,
      reason: result.reason ?? null,
      reconnectRequired: result.status === "expired",
      probed: true,
    }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
