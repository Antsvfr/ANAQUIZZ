-- ============================================================================
-- REV-EM — migration 004 : OAuth 2.0 Brightspace, durcissement
-- ============================================================================
-- À exécuter APRÈS 001, 002 et 003. Idempotente, non destructive.
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- Quatre besoins, tous issus du fonctionnement réel d'OAuth 2.0 chez D2L :
--
--   1. `state` à USAGE UNIQUE. Un state signé et daté (déjà en place) empêche
--      la forge, mais pas le REJEU à l'intérieur de sa fenêtre de validité.
--      Une table de nonces consommés rend le rejeu impossible : c'est la
--      recommandation de la RFC 6749 §10.12.
--
--   2. VERROU DE RAFRAÎCHISSEMENT. Chez Brightspace, un refresh token est à
--      USAGE UNIQUE : l'échanger renvoie un NOUVEAU couple access/refresh et
--      invalide l'ancien. Deux appels simultanés (deux onglets, deux appareils)
--      échangeraient donc le même refresh token : le second recevrait
--      `invalid_grant` et la connexion serait marquée expirée alors qu'elle
--      est parfaitement valide. Une colonne de verrou, posée de façon atomique,
--      sérialise les rafraîchissements.
--
--   3. VÉRIFICATION RÉELLE. Une connexion n'est « vérifiée » que si un appel
--      authentifié a réellement abouti côté Brightspace. On enregistre donc
--      quand, et pour quelle identité Brightspace.
--
--   4. Les colonnes ajoutées doivent entrer dans les privilèges de colonnes
--      (001) : sans cela, elles seraient invisibles au navigateur, qui ne
--      pourrait pas afficher l'état réel de la connexion.
-- ============================================================================


-- ============================================================================
-- 1. brightspace_connections — verrou, vérification, identité
-- ============================================================================
alter table public.brightspace_connections
  add column if not exists refresh_lock_at    timestamptz;
alter table public.brightspace_connections
  add column if not exists last_verified_at   timestamptz;
alter table public.brightspace_connections
  add column if not exists external_user_name text;
alter table public.brightspace_connections
  add column if not exists token_rotated_at   timestamptz;
alter table public.brightspace_connections
  add column if not exists refresh_count      integer not null default 0;

comment on column public.brightspace_connections.refresh_lock_at is
  'Posé de façon atomique avant un échange de refresh token, libéré après. Le refresh token Brightspace étant à usage unique, deux rafraîchissements simultanés invalideraient la connexion.';
comment on column public.brightspace_connections.last_verified_at is
  'Date du dernier appel authentifié RÉUSSI à Brightspace (route whoami). NULL = jamais vérifié : l''interface ne doit pas annoncer une connexion vérifiée.';
comment on column public.brightspace_connections.token_rotated_at is
  'Date de la dernière rotation du refresh token. Permet de diagnostiquer une connexion qui ne se rafraîchit plus.';


-- ============================================================================
-- 2. PRIVILÈGES DE COLONNES — les nouvelles colonnes sûres, jamais les tokens
-- ============================================================================
-- On rejoue la logique de 001 en l'étendant : révocation totale pour les deux
-- rôles exposés au navigateur, puis lecture colonne par colonne pour
-- `authenticated`. Les colonnes de token restent hors de tout GRANT, et
-- `refresh_lock_at` aussi : c'est un détail d'implémentation serveur, le
-- navigateur n'a rien à en faire.
revoke all on public.brightspace_connections from anon, authenticated;
grant select (
  user_id, tenant_url, external_user_id, external_user_name, status, scopes,
  last_synced_at, last_verified_at, last_error, token_expires_at,
  token_rotated_at, refresh_count, created_at, updated_at
) on public.brightspace_connections to authenticated;
-- NON accordées : access_token_enc, refresh_token_enc, refresh_lock_at.
-- anon : aucun privilège d'aucune sorte.


-- ============================================================================
-- 3. oauth_states — nonces à usage unique du flux d'autorisation
-- ============================================================================
-- Cette table n'est JAMAIS lue ni écrite par le navigateur : seules les Edge
-- Functions y touchent, via service_role. Aucune policy n'est créée, et RLS
-- est activée — donc même si un GRANT était ajouté par erreur un jour, aucune
-- ligne ne serait visible depuis le client.
create table if not exists public.oauth_states (
  id         text primary key,                       -- nonce aléatoire (base64url)
  user_id    uuid not null references auth.users(id) on delete cascade,
  source     text not null default 'brightspace',
  redirect_to text,                                  -- page de retour dans l'app
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_states_expires on public.oauth_states(expires_at);
create index if not exists idx_oauth_states_user    on public.oauth_states(user_id, created_at desc);

alter table public.oauth_states enable row level security;
-- Aucune policy : aucun accès client, quelles que soient les circonstances.
revoke all on public.oauth_states from anon, authenticated;

comment on table public.oauth_states is
  'Nonces du paramètre `state` OAuth, à usage unique. Consommés par brightspace-callback. Aucun accès client : service_role uniquement.';


-- ============================================================================
-- 4. MÉNAGE DES STATES EXPIRÉS
-- ============================================================================
-- Les lignes expirées n'ont plus aucune valeur. La fonction est appelée par
-- brightspace-connect à chaque émission : pas de tâche planifiée à configurer,
-- pas de table qui gonfle indéfiniment.
--
-- SECURITY DEFINER pour qu'elle s'exécute avec les droits du propriétaire ;
-- `search_path` figé pour qu'aucun objet homonyme ne puisse la détourner.
create or replace function public.purge_expired_oauth_states()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare removed integer;
begin
  delete from public.oauth_states
   where expires_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_oauth_states() from public, anon, authenticated;


-- ============================================================================
-- 5. VÉRIFICATION POST-MIGRATION
-- ============================================================================
-- (a) les colonnes existent → 5 lignes :
--
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='brightspace_connections'
--      and column_name in ('refresh_lock_at','last_verified_at',
--                          'external_user_name','token_rotated_at','refresh_count');
--
-- (b) les tokens ET le verrou restent hors de portée du navigateur → 0 ligne :
--
--   select grantee, column_name from information_schema.column_privileges
--    where table_name='brightspace_connections'
--      and grantee in ('anon','authenticated')
--      and column_name in ('access_token_enc','refresh_token_enc','refresh_lock_at');
--
-- (c) oauth_states est hermétique → rowsecurity = true, 0 policy, 0 privilège :
--
--   select rowsecurity from pg_tables where schemaname='public' and tablename='oauth_states';
--   select count(*) from pg_policies where schemaname='public' and tablename='oauth_states';
--   select count(*) from information_schema.role_table_grants
--    where table_name='oauth_states' and grantee in ('anon','authenticated');
-- ============================================================================
