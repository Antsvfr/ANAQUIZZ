/* ============================================================================
   Edge Function 1/6 : brightspace-connect — DÉMARRER OAUTH
   ----------------------------------------------------------------------------
   Appelée quand l'utilisateur clique sur « Connecter Brightspace ».
   Ne fait QUE construire l'URL d'autorisation officielle D2L.

   REV-EM ne demande JAMAIS d'identifiants Brightspace : l'authentification a
   lieu entièrement chez D2L, sur le domaine de l'établissement. Aucun mot de
   passe ne transite par REV-EM, n'y est saisi, ni n'y est stocké.

   Déploiement : JWT VÉRIFIÉ (comportement par défaut).
   ============================================================================ */

import { readEnv, requireUser, adminClient, json, errorResponse, corsHeaders, resolveOrigin, assertReadOnlyScopes } from "../_shared/lib.ts";
import { issueState, purgeExpiredStates } from "../_shared/oauth-state.ts";
import { authorizationUrl, callbackUrl } from "../_shared/brightspace.ts";

Deno.serve(async (req) => {
  let origin = "";
  try {
    const env = readEnv();
    origin = resolveOrigin(req.headers.get("Origin"), env.allowedOrigins, env.appUrl);
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

    /* Garde-fou : on refuse de construire une demande de consentement qui
       réclamerait autre chose que de la lecture. Une mauvaise configuration
       doit échouer AVANT d'envoyer l'utilisateur chez D2L. */
    assertReadOnlyScopes(env.scopes);

    // Identité prouvée par le JWT Supabase vérifié côté serveur.
    const userId = await requireUser(req, env);
    const db = adminClient(env);
    await purgeExpiredStates(db);

    /* Le state porte l'utilisateur, signé et daté, et son nonce est enregistré
       pour être consommé UNE seule fois par le callback (qui, lui, arrive sans
       session Supabase). */
    const state = await issueState(db, userId, env.clientSecret, { source: "brightspace" });

    return json({
      url: authorizationUrl(env, state, callbackUrl(env)),
      // Affiché à l'utilisateur avant la redirection : il doit savoir vers
      // quel établissement il part et ce qui sera demandé.
      tenantUrl: env.tenantUrl,
      scopes: env.scopes.split(/\s+/).filter(Boolean),
    }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
