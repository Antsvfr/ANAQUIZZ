/* ============================================================================
   Edge Functions 2/6 et 3/6 : brightspace-callback
   — GÉRER LE CALLBACK, puis STOCKER / METTRE À JOUR LA CONNEXION
   ----------------------------------------------------------------------------
   Point de retour du flux OAuth. Appelée par le NAVIGATEUR via une redirection
   de Brightspace : il n'y a donc PAS de session Supabase sur cette requête.
   L'identité de l'utilisateur vient exclusivement du paramètre `state`, signé
   par brightspace-connect et consommé ici — une seule fois.

   ⚠️ Déploiement : `--no-verify-jwt` OBLIGATOIRE (une redirection de navigateur
   ne porte pas d'en-tête Authorization). Sa sécurité ne repose pas sur le JWT
   mais sur la signature HMAC du state et l'unicité de son nonce.

   Ce fichier n'est qu'une redirection : toute la décision est dans
   _shared/callback-flow.ts, pour qu'elle soit testable (tests/edge-oauth.test.js).
   ============================================================================ */

import { readEnv, adminClient } from "../_shared/lib.ts";
import { handleCallback } from "../_shared/callback-flow.ts";

/* N'accepte une URL de retour que si elle reste dans l'application. Toute
   autre valeur est ignorée au profit de l'URL officielle. */
export function safeReturnUrl(candidate: string | null | undefined, appUrl: string): string {
  if (!candidate) return appUrl;
  try {
    const u = new URL(candidate, appUrl);
    const base = new URL(appUrl);
    if (u.origin === base.origin && u.pathname.startsWith(base.pathname)) return u.toString();
  } catch { /* valeur inutilisable */ }
  return appUrl;
}

function back(appUrl: string, params: Record<string, string>): Response {
  const u = new URL(appUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return Response.redirect(u.toString(), 302);
}

Deno.serve(async (req) => {
  let appUrl = "/";
  try {
    const env = readEnv();
    appUrl = env.appUrl;
    const result = await handleCallback(env, adminClient(env), new URL(req.url).searchParams);
    // Le retour ne peut JAMAIS sortir de l'application : une redirection
    // ouverte transformerait cette fonction en tremplin d'hameçonnage.
    return back(safeReturnUrl(result.redirectTo, appUrl), { brightspace: result.outcome });
  } catch (e) {
    // Aucun détail technique ne part vers le navigateur : il reste dans les
    // logs de la fonction.
    console.error("[brightspace-callback]", e);
    return back(appUrl, { brightspace: "error" });
  }
});
