/* ============================================================================
   Edge Function : brightspace-disconnect
   ------------------------------------------------------------------------
   Déconnecte le compte Brightspace de l'utilisateur courant.

   Ce qui est supprimé : UNIQUEMENT les tokens et la connexion.
   Ce qui est conservé : les matières, chapitres, fiches, quiz, flashcards et
   statistiques déjà importés ou générés. Ils appartiennent à l'élève, pas à
   la source (§13). Les éléments importés passent simplement en
   sync_status = 'unavailable' : ils restent consultables et révisables, mais
   ne seront plus mis à jour.
   ============================================================================ */

import { readEnv, requireUser, adminClient, json, errorResponse, corsHeaders } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "*";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const env = readEnv();
    const userId = await requireUser(req, env);
    const db = adminClient(env);

    // Les contenus importés restent en place, simplement signalés comme non
    // maintenus. Aucune donnée pédagogique n'est détruite.
    await db.from("subjects")
      .update({ sync_status: "unavailable" })
      .eq("user_id", userId).eq("source", "brightspace").neq("sync_status", "removed");
    await db.from("chapters")
      .update({ sync_status: "unavailable" })
      .eq("user_id", userId).eq("source", "brightspace").neq("sync_status", "removed");

    // Purge effective des secrets.
    const { error } = await db.from("brightspace_connections").delete().eq("user_id", userId);
    if (error) throw error;

    return json({ ok: true, contentKept: true }, 200, origin);
  } catch (e) {
    return errorResponse(e, origin);
  }
});
