/* ============================================================================
   Edge Function : brightspace-connect
   ------------------------------------------------------------------------
   Appelée par REV-EM quand l'utilisateur clique sur « Connecter Brightspace ».
   Ne fait QUE construire l'URL d'autorisation : aucun identifiant Brightspace
   n'est demandé par REV-EM, l'authentification a lieu entièrement chez D2L.

   Retourne { url } — le frontend redirige vers cette URL.
   ============================================================================ */

import { readEnv, requireUser, signState, json, errorResponse, corsHeaders } from "../_shared/lib.ts";
import { authorizationUrl } from "../_shared/brightspace.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "*";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const env = readEnv();
    // Identité prouvée par le JWT Supabase : on ne se fie jamais à un user_id
    // transmis dans le corps de la requête.
    const userId = await requireUser(req, env);

    // Le state porte l'utilisateur, signé et daté : c'est lui qui permettra
    // au callback (qui arrive sans session) de savoir à QUI rattacher la
    // connexion, sans qu'un tiers puisse la détourner.
    const state = await signState(userId, env.clientSecret);
    const redirectUri = `${env.supabaseUrl}/functions/v1/brightspace-callback`;

    return json({ url: authorizationUrl(env, state, redirectUri) }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
