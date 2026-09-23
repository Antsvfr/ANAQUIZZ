/* ============================================================================
   REV-EM — configuration des Edge Functions Brightspace
   ----------------------------------------------------------------------------
   Toutes les valeurs viennent des SECRETS SUPABASE (`supabase secrets set`).
   Aucune n'est committée, aucune n'atteint le navigateur.

   `readEnvFrom()` prend la source de configuration en paramètre : le code est
   ainsi testable hors Deno (voir tests/edge-oauth.test.js), et `readEnv()`
   reste l'appel normal en production.
   ============================================================================ */

import { ConfigError } from "./crypto.ts";

export interface Env {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientId: string;
  clientSecret: string;
  tenantUrl: string;
  encKey: string;
  appUrl: string;
  authBase: string;
  scopes: string;
  lpVersion: string;
  leVersion: string;
  /* Chemin de révocation du fournisseur, VIDE par défaut : il n'a pas pu être
     confirmé dans la documentation D2L (voir BRIGHTSPACE_SETUP.md). Tant qu'il
     n'est pas renseigné, la déconnexion ne tente aucun appel de révocation —
     plutôt que d'appeler une URL devinée. */
  revocationPath: string;
  /* Origines autorisées à appeler ces fonctions depuis un navigateur.
     Déduites de BRIGHTSPACE_APP_URL, complétées par BRIGHTSPACE_ALLOWED_ORIGINS
     (utile en développement local). */
  allowedOrigins: string[];
}

export type EnvSource = (key: string) => string | undefined;

/* Lit et VALIDE la configuration. Échoue tôt et bruyamment : une fonction mal
   configurée doit être évidente immédiatement, jamais à moitié fonctionnelle. */
export function readEnvFrom(src: EnvSource): Env {
  const get = (k: string, required = true): string => {
    const v = (src(k) ?? "").trim();
    if (required && !v) throw new ConfigError(`Variable d'environnement manquante : ${k}`);
    return v;
  };
  const opt = (k: string, fallback = ""): string => (src(k) ?? "").trim() || fallback;

  const appUrl = get("BRIGHTSPACE_APP_URL").replace(/\/+$/, "");
  const extraOrigins = opt("BRIGHTSPACE_ALLOWED_ORIGINS")
    .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

  const origins: string[] = [];
  for (const candidate of [appUrl, ...extraOrigins]) {
    try { origins.push(new URL(candidate).origin); } catch { /* valeur inutilisable : ignorée */ }
  }

  return {
    supabaseUrl: get("SUPABASE_URL").replace(/\/+$/, ""),
    serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY"),
    clientId: get("BRIGHTSPACE_CLIENT_ID"),
    clientSecret: get("BRIGHTSPACE_CLIENT_SECRET"),
    tenantUrl: get("BRIGHTSPACE_TENANT_URL").replace(/\/+$/, ""),
    encKey: get("BRIGHTSPACE_TOKEN_ENC_KEY"),
    appUrl,
    /* Les endpoints OAuth publics de D2L sont identiques pour tous les
       tenants ; on ne les code pas en dur pour pouvoir les corriger sans
       redéployer si D2L les fait évoluer. */
    authBase: opt("BRIGHTSPACE_AUTH_BASE", "https://auth.brightspace.com").replace(/\/+$/, ""),
    /* Scopes de LECTURE SEULE par défaut, les plus précis possibles.
       Aucun scope d'écriture, jamais : REV-EM ne modifie rien dans
       Brightspace. La liste exacte dépend de ce que le tenant expose —
       voir BRIGHTSPACE_SETUP.md, étape 1. */
    scopes: opt("BRIGHTSPACE_SCOPES", DEFAULT_SCOPES),
    lpVersion: opt("BRIGHTSPACE_LP_VERSION", "1.31"),
    leVersion: opt("BRIGHTSPACE_LE_VERSION", "1.67"),
    revocationPath: opt("BRIGHTSPACE_REVOCATION_PATH"),
    allowedOrigins: origins,
  };
}

/* Lecture seule, strictement limitée à ce dont l'import a besoin :
     • enrollment:orgunit:read  → la liste des cours de l'utilisateur
     • content:toc:read         → la table des matières d'un cours
     • content:modules:read     → les modules
     • content:topics:read      → les ressources d'un module
     • users:userdata:read      → vérifier à QUEL compte Brightspace on est relié
   Aucun `*:*:*`, aucun `:write`, aucun `:delete`.
   Si le tenant refuse l'un de ces libellés, voir la procédure de repli dans
   BRIGHTSPACE_SETUP.md — ne jamais élargir à `core:*:*`, qui inclut l'écriture. */
export const DEFAULT_SCOPES = [
  "enrollment:orgunit:read",
  "content:toc:read",
  "content:modules:read",
  "content:topics:read",
  "users:userdata:read",
].join(" ");

/* Refuse tout scope contenant une permission d'écriture. Appelé au démarrage
   de la fonction connect : une mauvaise configuration doit échouer AVANT
   d'envoyer l'utilisateur vers un écran de consentement trop large. */
const WRITE_PERMISSIONS = ["write", "create", "update", "delete", "manage"];

export function assertReadOnlyScopes(scopes: string): void {
  const bad: string[] = [];
  for (const scope of scopes.split(/\s+/).filter(Boolean)) {
    const parts = scope.split(":");
    const permissions = (parts[2] ?? "").split(",").map(p => p.trim().toLowerCase());
    if (permissions.some(p => p === "*" || WRITE_PERMISSIONS.includes(p))) bad.push(scope);
  }
  if (bad.length) {
    throw new ConfigError(
      `BRIGHTSPACE_SCOPES contient des permissions non lecture seule : ${bad.join(", ")}. ` +
      `REV-EM ne modifie rien dans Brightspace et ne doit demander que des scopes en :read.`,
    );
  }
}

export function readEnv(): Env {
  const deno = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  if (!deno) throw new ConfigError("readEnv() n'est utilisable que dans le runtime Deno.");
  return readEnvFrom((k) => deno.env.get(k));
}
