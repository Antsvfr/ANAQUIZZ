/* ============================================================================
   REV-EM — cycle de vie de la connexion Brightspace (stockage, rafraîchissement)
   ----------------------------------------------------------------------------
   Un seul endroit décide quand un token est encore bon, quand il faut le
   rafraîchir, et comment la rotation est enregistrée. Les quatre Edge
   Functions qui en ont besoin (api, refresh, status, disconnect) passent
   toutes par ici : pas deux implémentations à garder d'accord.

   Le client de base de données est INJECTÉ (et `fetch` aussi) : ce fichier
   n'importe ni Supabase ni Deno, donc il s'exécute tel quel dans les tests
   (tests/edge-oauth.test.js).

   ── LE POINT DÉLICAT : LA ROTATION DU REFRESH TOKEN ────────────────────────
   Chez Brightspace, un refresh token est À USAGE UNIQUE : l'échanger renvoie
   un nouveau couple access/refresh et invalide l'ancien.

   Conséquence si on n'y prend pas garde : deux appels simultanés (deux
   onglets, ou deux appareils) lisent le même refresh token, l'échangent tous
   les deux, et le second reçoit `invalid_grant` — la connexion est alors
   marquée expirée alors qu'elle est parfaitement valide, et l'utilisateur
   doit se reconnecter sans raison.

   D'où le verrou posé de façon ATOMIQUE en base (une seule requête UPDATE
   conditionnelle : celui qui obtient la ligne a le verrou), et l'attente
   active côté perdant, qui relit simplement le token que le gagnant vient
   d'écrire.
   ============================================================================ */

import type { Env } from "./env.ts";
import { encryptSecret, decryptSecret } from "./crypto.ts";
import {
  refreshTokens, whoami, BrightspaceError,
  type FetchLike, type TokenSet, type Identity,
} from "./brightspace.ts";

export const TABLE = "brightspace_connections";

/* Forme minimale attendue du client (PostgREST / supabase-js). Typée ici
   plutôt qu'importée, pour ne dépendre d'aucun paquet. */
export interface Db {
  from(table: string): {
    select(cols?: string): any;
    update(patch: Record<string, unknown>): any;
    delete(): any;
    insert(row: Record<string, unknown>): any;
    upsert(row: Record<string, unknown>, opts?: Record<string, unknown>): any;
  };
}

export interface ConnectionRow {
  user_id: string;
  tenant_url?: string;
  status?: string;
  scopes?: string[];
  access_token_enc?: string | null;
  refresh_token_enc?: string | null;
  token_expires_at?: string | null;
  refresh_lock_at?: string | null;
  last_verified_at?: string | null;
  external_user_id?: string | null;
  external_user_name?: string | null;
  refresh_count?: number;
  [k: string]: unknown;
}

/* Durée au-delà de laquelle un verrou est considéré comme abandonné (fonction
   tuée en plein rafraîchissement). Volontairement courte : un échange de token
   prend moins d'une seconde. */
export const LOCK_TTL_MS = 30_000;
/* Marge avant expiration : on rafraîchit un peu en avance plutôt que de
   découvrir un 401 au milieu d'un import. */
export const REFRESH_MARGIN_MS = 60_000;

export class ReconnectRequired extends Error {
  constructor(message = "Ta session Brightspace a expiré. Reconnecte ton compte pour continuer.") {
    super(message);
  }
}

export async function loadConnection(db: Db, userId: string): Promise<ConnectionRow | null> {
  const { data, error } = await db.from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as ConnectionRow) ?? null;
}

/* Écrit un couple de tokens fraîchement obtenu. Les tokens ne touchent la base
   que chiffrés (AES-GCM, clé hors base). */
export async function persistTokens(
  db: Db, env: Env, userId: string, tokens: TokenSet, extra: Record<string, unknown> = {},
): Promise<void> {
  const patch: Record<string, unknown> = {
    access_token_enc: await encryptSecret(tokens.accessToken, env.encKey),
    token_expires_at: new Date(tokens.expiresAt).toISOString(),
    status: "connected",
    last_error: null,
    refresh_lock_at: null,
    ...extra,
  };
  if (tokens.refreshToken) {
    patch.refresh_token_enc = await encryptSecret(tokens.refreshToken, env.encKey);
    patch.token_rotated_at = new Date().toISOString();
  }
  if (tokens.scopes?.length) patch.scopes = tokens.scopes;

  const { error } = await db.from(TABLE).update(patch).eq("user_id", userId);
  if (error) throw error;
}

export async function markStatus(db: Db, userId: string, status: string, lastError?: string | null): Promise<void> {
  await db.from(TABLE).update({
    status,
    last_error: lastError ? String(lastError).slice(0, 500) : null,
    refresh_lock_at: null,
  }).eq("user_id", userId);
}

/* Tente de prendre le verrou de rafraîchissement. Une seule requête : la
   condition et l'écriture sont évaluées ensemble par PostgreSQL, donc deux
   appels simultanés ne peuvent pas l'obtenir tous les deux.
   Retourne true si le verrou est à nous. */
export async function claimRefreshLock(db: Db, userId: string, now = Date.now()): Promise<boolean> {
  const staleBefore = new Date(now - LOCK_TTL_MS).toISOString();
  const { data, error } = await db.from(TABLE)
    .update({ refresh_lock_at: new Date(now).toISOString() })
    .eq("user_id", userId)
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${staleBefore}`)
    .select("user_id");
  if (error) throw error;
  return Array.isArray(data) ? data.length > 0 : !!data;
}

export async function releaseRefreshLock(db: Db, userId: string): Promise<void> {
  await db.from(TABLE).update({ refresh_lock_at: null }).eq("user_id", userId);
}

function tokenStillValid(conn: ConnectionRow, now: number): boolean {
  const expiresAt = conn.token_expires_at ? Date.parse(String(conn.token_expires_at)) : 0;
  return !!conn.access_token_enc && expiresAt > now + REFRESH_MARGIN_MS;
}

export interface EnsureOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /* Nombre de relectures pendant qu'un autre appel détient le verrou. */
  waitAttempts?: number;
  waitDelayMs?: number;
}

/* Renvoie un access token valide, en rafraîchissant si nécessaire.
   Lève ReconnectRequired quand — et seulement quand — l'utilisateur doit
   vraiment repasser par l'écran de consentement Brightspace. */
export async function ensureAccessToken(
  env: Env, db: Db, conn: ConnectionRow, opts: EnsureOptions = {},
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const waitAttempts = opts.waitAttempts ?? 5;
  const waitDelayMs = opts.waitDelayMs ?? 400;
  const userId = conn.user_id;

  if (tokenStillValid(conn, now())) {
    return await decryptSecret(String(conn.access_token_enc), env.encKey);
  }
  if (!conn.refresh_token_enc) {
    throw new ReconnectRequired("Aucun accès Brightspace enregistré. Connecte ton compte.");
  }

  /* ---- un autre appel rafraîchit-il déjà ? ---- */
  if (!(await claimRefreshLock(db, userId, now()))) {
    for (let i = 0; i < waitAttempts; i++) {
      await sleep(waitDelayMs);
      const fresh = await loadConnection(db, userId);
      if (fresh && tokenStillValid(fresh, now())) {
        // Le gagnant a écrit un token tout neuf : on l'utilise, sans jamais
        // échanger le refresh token une seconde fois.
        return await decryptSecret(String(fresh.access_token_enc), env.encKey);
      }
      if (fresh && fresh.status === "expired") {
        throw new ReconnectRequired();
      }
    }
    throw new BrightspaceError("Un rafraîchissement de session est déjà en cours.", 409);
  }

  /* ---- on détient le verrou ---- */
  try {
    const refreshToken = await decryptSecret(String(conn.refresh_token_enc), env.encKey);
    const tokens = await refreshTokens(env, refreshToken, f);

    if (!tokens.refreshToken) {
      /* Brightspace fait tourner le refresh token à chaque échange. N'en pas
         recevoir est anormal : on le consigne plutôt que de le passer sous
         silence, tout en gardant la session utilisable. */
      console.warn("[brightspace] rafraîchissement sans nouveau refresh token — rotation inattendue");
    }
    await persistTokens(db, env, userId, tokens, {
      refresh_count: Number(conn.refresh_count ?? 0) + 1,
    });
    return tokens.accessToken;
  } catch (e) {
    if (e instanceof BrightspaceError && e.invalidGrant) {
      // Refresh token réellement mort : c'est le seul cas qui impose une
      // reconnexion. On l'enregistre pour que l'interface le dise clairement.
      await markStatus(db, userId, "expired", "invalid_grant");
      throw new ReconnectRequired();
    }
    await releaseRefreshLock(db, userId);
    throw e;
  }
}

/* ============================================================================
   Vérification réelle d'une connexion
   ============================================================================
   « Connecté » n'est pas une case cochée en base : c'est un appel authentifié
   qui aboutit. Cette fonction en fait un, et n'affirme rien d'autre. */
export interface VerifyResult {
  ok: boolean;
  status: string;
  identity?: Identity;
  scopes: string[];
  tenantUrl: string | null;
  lastVerifiedAt: string | null;
  reason?: string;
}

export async function verifyConnection(
  env: Env, db: Db, userId: string, opts: EnsureOptions = {},
): Promise<VerifyResult> {
  const f = opts.fetchImpl ?? fetch;
  const conn = await loadConnection(db, userId);
  if (!conn) {
    return { ok: false, status: "not_connected", scopes: [], tenantUrl: null, lastVerifiedAt: null };
  }

  try {
    const accessToken = await ensureAccessToken(env, db, conn, opts);
    const identity = await whoami(env, accessToken, f);
    const verifiedAt = new Date().toISOString();

    await db.from(TABLE).update({
      status: "connected",
      last_verified_at: verifiedAt,
      external_user_id: identity.externalUserId,
      external_user_name: identity.displayName,
      last_error: null,
    }).eq("user_id", userId);

    return {
      ok: true, status: "connected", identity,
      scopes: (conn.scopes as string[]) ?? [],
      tenantUrl: (conn.tenant_url as string) ?? env.tenantUrl,
      lastVerifiedAt: verifiedAt,
    };
  } catch (e) {
    if (e instanceof ReconnectRequired) {
      return {
        ok: false, status: "expired", scopes: (conn.scopes as string[]) ?? [],
        tenantUrl: (conn.tenant_url as string) ?? null,
        lastVerifiedAt: (conn.last_verified_at as string) ?? null,
        reason: "expired",
      };
    }
    if (e instanceof BrightspaceError && (e.status === 401 || e.status === 403)) {
      await markStatus(db, userId, "error", e.message);
      return {
        ok: false, status: "error", scopes: (conn.scopes as string[]) ?? [],
        tenantUrl: (conn.tenant_url as string) ?? null,
        lastVerifiedAt: (conn.last_verified_at as string) ?? null,
        reason: e.status === 403 ? "forbidden" : "unauthorized",
      };
    }
    throw e;
  }
}
