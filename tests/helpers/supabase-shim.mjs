/* ============================================================================
   REV-EM — remplaçant du SDK Supabase pour les tests d'intégration
   ----------------------------------------------------------------------------
   Les Edge Functions importent `createClient` depuis esm.sh. Ce module prend sa
   place (voir loader-hooks.mjs) afin que le VRAI code des fonctions puisse
   s'exécuter sous Node, contre une VRAIE base PostgreSQL.

   Ce qui est réel ici : la base, ses contraintes, ses policies RLS, l'atomicité
   des UPDATE, les transactions concurrentes.
   Ce qui est remplacé : le transport HTTP de PostgREST, et la vérification du
   JWT par Supabase Auth — `auth.getUser()` résout un jeton de test en
   identifiant en consultant réellement la table auth.users, mais ne vérifie
   aucune signature. C'est une limite assumée et signalée dans le rapport :
   la validation cryptographique du JWT est le travail de Supabase, pas celui
   du code de REV-EM.
   ============================================================================ */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPostgrestClient } = require("./pgrest.js");

/* `lib.ts` importe aussi le TYPE SupabaseClient. Deno le résout comme un type ;
   Node, qui se contente de retirer les annotations, le voit comme une valeur.
   On l'exporte donc, sans rien en faire. */
export class SupabaseClient {}

export function createClient(_url, _key, _opts) {
  const run = globalThis.__ITEST_RUN_SQL;
  if (typeof run !== "function") {
    throw new Error("__ITEST_RUN_SQL n'est pas installé : le harnais de test n'est pas prêt.");
  }
  const client = createPostgrestClient(run);

  return {
    from: client.from,
    auth: {
      /* Convention du harnais : un jeton « itest:<uuid> » désigne cet
         utilisateur, à condition qu'il existe RÉELLEMENT dans auth.users.
         Tout autre jeton est refusé, comme le ferait Supabase. */
      async getUser(token) {
        const m = /^itest:([0-9a-f-]{36})$/i.exec(String(token || ""));
        if (!m) return { data: null, error: { message: "Jeton invalide." } };
        const rows = await run("select id from auth.users where id = $1", [m[1]]);
        if (!rows.length) return { data: null, error: { message: "Utilisateur inconnu." } };
        return { data: { user: { id: rows[0].id } }, error: null };
      },
    },
  };
}

export default { createClient };
