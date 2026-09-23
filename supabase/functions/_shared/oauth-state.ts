/* ============================================================================
   REV-EM — paramètre `state` OAuth à usage unique
   ----------------------------------------------------------------------------
   Le `state` est ce qui empêche un tiers de rattacher SA connexion Brightspace
   au compte REV-EM de quelqu'un d'autre. Il est protégé deux fois :

     1. SIGNÉ (HMAC-SHA256, crypto.ts) : il ne peut pas être forgé.
     2. CONSOMMÉ (ici) : le nonce est marqué utilisé à la première présentation,
        donc un state authentique intercepté ne peut pas être rejoué dans les
        dix minutes de sa validité.

   La table `oauth_states` n'est accessible qu'à service_role : aucune policy,
   aucun privilège pour anon ni authenticated (migration 004).
   ============================================================================ */

import type { Db } from "./connection.ts";
import { AuthError, randomNonce, signState, verifyState, STATE_TTL_MS } from "./crypto.ts";

export const STATES_TABLE = "oauth_states";

/* Émet un state signé ET enregistre son nonce. Purge au passage les nonces
   périmés : pas de tâche planifiée à configurer, pas de table qui gonfle. */
export async function issueState(
  db: Db, userId: string, secret: string,
  opts: { source?: string; redirectTo?: string | null; ttlMs?: number } = {},
): Promise<string> {
  const ttlMs = opts.ttlMs ?? STATE_TTL_MS;
  const nonce = randomNonce();

  const { error } = await db.from(STATES_TABLE).insert({
    id: nonce,
    user_id: userId,
    source: opts.source ?? "brightspace",
    redirect_to: opts.redirectTo ?? null,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (error) throw error;

  return await signState(userId, nonce, secret, ttlMs);
}

export interface ConsumedState {
  userId: string;
  redirectTo: string | null;
}

/* Vérifie la signature, puis consomme le nonce. La consommation est une seule
   requête conditionnelle (`used_at is null`) : deux présentations simultanées
   du même state ne peuvent pas réussir toutes les deux. */
export async function consumeState(db: Db, state: string, secret: string): Promise<ConsumedState> {
  const payload = await verifyState(state, secret);   // signature + expiration

  const { data, error } = await db.from(STATES_TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq("id", payload.nonce)
    .eq("user_id", payload.userId)
    .is("used_at", null)
    .select("user_id,redirect_to,expires_at");
  if (error) throw error;

  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (!rows.length) {
    // Signature valide mais nonce déjà consommé, inconnu, ou appartenant à un
    // autre compte : c'est exactement ce qu'on cherche à bloquer.
    throw new AuthError("Cette demande de connexion a déjà été utilisée ou n'est plus valide.");
  }
  const row = rows[0] as Record<string, unknown>;
  if (row.expires_at && Date.parse(String(row.expires_at)) < Date.now()) {
    throw new AuthError("Demande de connexion expirée.");
  }

  return { userId: String(row.user_id), redirectTo: (row.redirect_to as string) ?? null };
}

/* Appelée à l'émission : supprime les nonces périmés depuis plus d'une heure.
   Échoue en silence — un ménage raté ne doit jamais empêcher une connexion. */
export async function purgeExpiredStates(db: Db): Promise<void> {
  try {
    await db.from(STATES_TABLE).delete().lt("expires_at", new Date(Date.now() - 3_600_000).toISOString());
  } catch (e) {
    console.error("[brightspace] purge des states impossible", e);
  }
}
