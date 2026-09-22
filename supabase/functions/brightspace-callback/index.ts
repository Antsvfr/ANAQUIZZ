/* ============================================================================
   Edge Function : brightspace-callback
   ------------------------------------------------------------------------
   Point de retour du flux OAuth. Appelée par le NAVIGATEUR via une
   redirection de Brightspace — donc SANS session Supabase. L'identité de
   l'utilisateur provient exclusivement du paramètre `state` signé émis par
   brightspace-connect.

   Redirige toujours vers REV-EM avec un statut lisible, jamais une erreur
   technique brute (§18).
   ============================================================================ */

import { readEnv, verifyState, adminClient, encryptSecret } from "../_shared/lib.ts";
import { exchangeCode } from "../_shared/brightspace.ts";

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
    const url = new URL(req.url);

    // L'utilisateur a refusé le consentement, ou Brightspace a renvoyé une erreur.
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return back(appUrl, { brightspace: "denied" });
    }

    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!code || !state) return back(appUrl, { brightspace: "invalid" });

    // Vérifie signature + expiration, et récupère l'utilisateur d'origine.
    // Échoue si le state a été forgé, rejoué tardivement ou altéré.
    const userId = await verifyState(state, env.clientSecret);

    const redirectUri = `${env.supabaseUrl}/functions/v1/brightspace-callback`;
    const tokens = await exchangeCode(env, code, redirectUri);

    // Les tokens ne touchent la base que chiffrés.
    const accessEnc = await encryptSecret(tokens.accessToken, env.encKey);
    const refreshEnc = tokens.refreshToken ? await encryptSecret(tokens.refreshToken, env.encKey) : null;

    const db = adminClient(env);
    const { error } = await db.from("brightspace_connections").upsert({
      user_id: userId,
      tenant_url: env.tenantUrl,
      status: "connected",
      scopes: tokens.scopes,
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      token_expires_at: new Date(tokens.expiresAt).toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    if (error) {
      console.error("[brightspace-callback] upsert", error);
      return back(appUrl, { brightspace: "error" });
    }

    return back(appUrl, { brightspace: "connected" });
  } catch (e) {
    console.error("[brightspace-callback]", e);
    return back(appUrl, { brightspace: "error" });
  }
});
