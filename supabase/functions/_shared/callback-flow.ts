/* ============================================================================
   REV-EM — décision du callback OAuth, isolée pour être testable
   ----------------------------------------------------------------------------
   C'est le chemin le plus sensible du projet : c'est ici que se décide si un
   compte Brightspace est rattaché à un compte REV-EM, et si l'interface a le
   droit d'afficher « Connecté ».

   Il est donc séparé du serveur HTTP (index.ts n'est plus qu'une redirection
   autour de cette fonction) pour pouvoir être exécuté tel quel dans les tests,
   avec un faux Brightspace et une fausse base — voir tests/edge-oauth.test.js.

   RÈGLE ABSOLUE, vérifiée par les tests : aucune ligne de connexion n'est
   écrite, et aucun statut « connected » n'est renvoyé, tant que
     1. le `state` n'a pas été vérifié ET consommé,
     2. le code n'a pas été échangé contre de vrais tokens,
     3. un appel authentifié (whoami) n'a pas abouti.
   Un échec à n'importe laquelle de ces étapes ne laisse AUCUNE trace de
   connexion.
   ============================================================================ */

import type { Env } from "./env.ts";
import type { Db } from "./connection.ts";
import { AuthError, encryptSecret } from "./crypto.ts";
import { consumeState } from "./oauth-state.ts";
import {
  exchangeCode, whoami, callbackUrl, BrightspaceError,
  type FetchLike, type TokenSet, type Identity,
} from "./brightspace.ts";

/* Statuts renvoyés à l'application, en clair dans l'URL de retour. Aucun ne
   contient de détail technique : celui-ci reste dans les logs de la fonction. */
export type CallbackOutcome =
  | "connected"        // OAuth réel réussi ET vérifié
  | "denied"           // l'utilisateur a refusé, ou D2L a renvoyé une erreur
  | "invalid"          // paramètres manquants ou state invalide/rejoué
  | "no_refresh_token" // application D2L sans « Enable refresh tokens »
  | "forbidden"        // scopes insuffisants côté D2L
  | "error";           // tout le reste

export interface CallbackDeps {
  fetchImpl?: FetchLike;
  exchange?: (env: Env, code: string, redirectUri: string, f: FetchLike) => Promise<TokenSet>;
  identify?: (env: Env, accessToken: string, f: FetchLike) => Promise<Identity>;
  now?: () => Date;
}

export interface CallbackResult {
  outcome: CallbackOutcome;
  userId?: string;
  redirectTo?: string | null;
}

export async function handleCallback(
  env: Env, db: Db, params: URLSearchParams, deps: CallbackDeps = {},
): Promise<CallbackResult> {
  const f = deps.fetchImpl ?? fetch;
  const exchange = deps.exchange ?? exchangeCode;
  const identify = deps.identify ?? whoami;
  const now = deps.now ?? (() => new Date());

  /* ---- 0. refus de consentement ou erreur côté D2L ---- */
  const oauthError = params.get("error");
  if (oauthError) {
    console.warn("[brightspace-callback] refus ou erreur OAuth :", oauthError);
    return { outcome: "denied" };
  }

  const code = params.get("code") || "";
  const state = params.get("state") || "";
  if (!code || !state) return { outcome: "invalid" };

  /* ---- 1. state : signature, expiration, nonce à usage unique ---- */
  let userId: string;
  let redirectTo: string | null = null;
  try {
    const consumed = await consumeState(db, state, env.clientSecret);
    userId = consumed.userId;
    redirectTo = consumed.redirectTo;
  } catch (e) {
    // State forgé, altéré, expiré ou rejoué : rien n'est écrit.
    console.warn("[brightspace-callback] state rejeté :", e instanceof AuthError ? e.message : e);
    return { outcome: "invalid" };
  }

  try {
    /* ---- 2. échange du code (client_secret en Basic Auth, côté serveur) ---- */
    const tokens = await exchange(env, code, callbackUrl(env), f);

    if (!tokens.refreshToken) {
      /* Sans refresh token, la connexion mourrait à la première expiration
         (≈1 h) sans que l'utilisateur comprenne pourquoi. C'est le symptôme
         d'une application D2L enregistrée sans « Enable refresh tokens ».
         On le signale au lieu de laisser une connexion se dégrader en silence,
         et on n'enregistre rien. */
      console.error("[brightspace-callback] aucun refresh token — « Enable refresh tokens » probablement désactivé sur l'application D2L");
      return { outcome: "no_refresh_token", userId };
    }

    /* ---- 3. vérification RÉELLE avant d'annoncer quoi que ce soit ---- */
    const identity = await identify(env, tokens.accessToken, f);

    /* ---- 4. seulement maintenant, on enregistre ---- */
    const stamp = now().toISOString();
    const { error } = await db.from("brightspace_connections").upsert({
      user_id: userId,
      tenant_url: env.tenantUrl,
      status: "connected",
      scopes: tokens.scopes,
      external_user_id: identity.externalUserId,
      external_user_name: identity.displayName,
      access_token_enc: await encryptSecret(tokens.accessToken, env.encKey),
      refresh_token_enc: await encryptSecret(tokens.refreshToken, env.encKey),
      token_expires_at: new Date(tokens.expiresAt).toISOString(),
      token_rotated_at: stamp,
      last_verified_at: stamp,
      refresh_lock_at: null,
      last_error: null,
      updated_at: stamp,
    }, { onConflict: "user_id" });

    if (error) {
      console.error("[brightspace-callback] enregistrement impossible", error);
      return { outcome: "error", userId };
    }
    return { outcome: "connected", userId, redirectTo };
  } catch (e) {
    console.error("[brightspace-callback]", e);
    if (e instanceof BrightspaceError && e.status === 403) return { outcome: "forbidden", userId };
    return { outcome: "error", userId };
  }
}
