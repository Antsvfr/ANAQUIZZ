/* ============================================================================
   REV-EM — réponses HTTP des Edge Functions (CORS, JSON, erreurs)
   ----------------------------------------------------------------------------
   Aucune dépendance. Deux principes :

     • CORS par LISTE BLANCHE. Renvoyer l'origine reçue telle quelle
       (`Access-Control-Allow-Origin: <origine appelante>`) revient à autoriser
       n'importe quel site. Ici, seules les origines configurées sont
       acceptées ; toute autre reçoit l'origine officielle de l'application,
       donc le navigateur bloque la réponse.

     • AUCUN détail technique renvoyé au navigateur. Les messages sont rédigés
       pour l'utilisateur ; la cause exacte reste dans les logs de la fonction.
   ============================================================================ */

import { AuthError, ConfigError } from "./crypto.ts";

export function resolveOrigin(requestOrigin: string | null, allowed: string[], fallback: string): string {
  const o = (requestOrigin || "").trim();
  if (o && allowed.includes(o)) return o;
  return fallback || (allowed[0] ?? "");
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status = 200, origin = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export function errorResponse(e: unknown, origin = ""): Response {
  console.error("[brightspace]", e);
  if (e instanceof AuthError) {
    return json({ error: "auth", message: e.message }, 401, origin);
  }
  if (e instanceof ConfigError) {
    return json({
      error: "config",
      message: "L'intégration Brightspace n'est pas encore configurée sur ce serveur.",
    }, 500, origin);
  }
  return json({ error: "unexpected", message: "Une erreur est survenue. Réessaie dans un instant." }, 500, origin);
}
