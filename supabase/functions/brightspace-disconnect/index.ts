/* ============================================================================
   Edge Function 6/6 : brightspace-disconnect — DÉCONNECTER BRIGHTSPACE
   ----------------------------------------------------------------------------
   Ce qui est supprimé : UNIQUEMENT les tokens et la ligne de connexion.
   Ce qui est conservé : matières, chapitres, fiches, quiz, flashcards,
   progression et statistiques déjà importés ou générés. Ils appartiennent à
   l'élève, pas à la source. Les contenus importés passent simplement en
   sync_status = 'unavailable' : toujours consultables et révisables, mais
   plus mis à jour.

   Révocation côté D2L : tentée seulement si BRIGHTSPACE_REVOCATION_PATH est
   configuré. L'endpoint de révocation n'a pas pu être confirmé dans la
   documentation D2L depuis l'environnement de développement, et appeler une
   URL devinée n'apporterait rien. La suppression locale, elle, a toujours
   lieu — un échec de révocation ne bloque jamais la déconnexion.

   Déploiement : JWT vérifié.
   ============================================================================ */

import { readEnv, requireUser, adminClient, decryptSecret, json, errorResponse, corsHeaders, resolveOrigin } from "../_shared/lib.ts";
import { loadConnection } from "../_shared/connection.ts";
import { revokeToken } from "../_shared/brightspace.ts";

Deno.serve(async (req) => {
  let origin = "";
  try {
    const env = readEnv();
    origin = resolveOrigin(req.headers.get("Origin"), env.allowedOrigins, env.appUrl);
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

    const userId = await requireUser(req, env);
    const db = adminClient(env);
    const conn = await loadConnection(db, userId);

    /* ---- 1. révocation côté fournisseur (au mieux) ---- */
    let revoked = false;
    if (conn?.refresh_token_enc && env.revocationPath) {
      try {
        revoked = await revokeToken(env, await decryptSecret(String(conn.refresh_token_enc), env.encKey));
      } catch (e) {
        console.error("[brightspace-disconnect] révocation", e);
      }
    }

    /* ---- 2. le contenu pédagogique reste en place ---- */
    await db.from("subjects")
      .update({ sync_status: "unavailable" })
      .eq("user_id", userId).eq("source", "brightspace").neq("sync_status", "removed");
    await db.from("chapters")
      .update({ sync_status: "unavailable" })
      .eq("user_id", userId).eq("source", "brightspace").neq("sync_status", "removed");

    /* ---- 3. purge effective des secrets ---- */
    const { error } = await db.from("brightspace_connections").delete().eq("user_id", userId);
    if (error) throw error;

    // Les states en attente de ce compte n'ont plus lieu d'être.
    await db.from("oauth_states").delete().eq("user_id", userId).is("used_at", null);

    return json({
      ok: true,
      contentKept: true,
      // Dit honnêtement si la révocation a eu lieu : sans endpoint configuré,
      // l'autorisation reste active côté Brightspace jusqu'à son expiration.
      revokedAtProvider: revoked,
    }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
