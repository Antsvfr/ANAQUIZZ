/* ============================================================================
   REV-EM — accès Supabase des Edge Functions
   ----------------------------------------------------------------------------
   SEUL fichier partagé qui dépend du SDK Supabase. Tout le reste (crypto,
   configuration, HTTP, OAuth, connexion) est volontairement sans dépendance,
   pour être exécutable et testable hors Deno — voir tests/edge-oauth.test.js.

   Ce module réexporte les autres pour que les fonctions n'aient qu'un import
   à faire.

   ⚠️ Code SERVEUR uniquement. Aucune de ces valeurs ne doit jamais atteindre
   le navigateur.
   ============================================================================ */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { Env } from "./env.ts";
import { AuthError } from "./crypto.ts";

export * from "./crypto.ts";
export * from "./env.ts";
export * from "./http.ts";

/* service_role : contourne RLS. Utilisé UNIQUEMENT par les Edge Functions,
   jamais exposé. C'est ce qui permet d'écrire dans brightspace_connections et
   oauth_states, tables sur lesquelles le client n'a aucune policy d'écriture
   (et, pour oauth_states, aucun accès du tout). */
export function adminClient(env: Env): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* Vérifie le JWT Supabase de l'appelant et retourne son identifiant.
   L'identité vient TOUJOURS du jeton vérifié côté serveur, jamais d'un
   user_id transmis dans le corps de la requête.

   Utilisée par connect, api, refresh, status et disconnect — jamais par le
   callback OAuth, qui arrive sans session (voir oauth-state.ts). */
export async function requireUser(req: Request, env: Env): Promise<string> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new AuthError("Authentification requise.");
  const { data, error } = await adminClient(env).auth.getUser(token);
  if (error || !data?.user) throw new AuthError("Session invalide ou expirée.");
  return data.user.id;
}
