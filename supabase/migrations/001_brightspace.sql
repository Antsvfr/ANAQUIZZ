-- ============================================================================
-- REV-EM — migration Brightspace (provenance + connexion OAuth + sync)
-- ============================================================================
-- À exécuter APRÈS supabase/schema.sql, dans l'éditeur SQL de ton projet
-- Supabase (Dashboard → SQL Editor). Idempotent : relançable sans risque.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- PRINCIPE DIRECTEUR — on ne crée PAS de tables "external_courses" /
-- "external_modules" / "external_resources". Un cours Brightspace n'est pas
-- un objet d'un autre type : c'est une MATIÈRE REV-EM avec une provenance.
-- Les tables subjects/chapters existantes portent déjà exactement les bons
-- champs ; on leur ajoute seulement de quoi savoir d'où elles viennent et
-- comment les dédupliquer. Créer un second système de cours parallèle aurait
-- contredit l'architecture (un seul système de matières/chapitres).
--
-- Deux tables réellement nouvelles seulement :
--   brightspace_connections  (la connexion OAuth d'un utilisateur)
--   sync_runs                (traçabilité + reprise d'une synchronisation)
-- ============================================================================


-- ============================================================================
-- 1. PROVENANCE SUR LES TABLES EXISTANTES
-- ============================================================================
-- Valeurs par défaut choisies pour que TOUTES les lignes déjà présentes
-- (matières manuelles, imports PDF) restent strictement inchangées :
-- source='manual', sync_status='active', external_id=null.
-- Aucune migration de données n'est nécessaire, aucune régression possible.

-- ---- subjects --------------------------------------------------------------
alter table public.subjects add column if not exists source         text not null default 'manual';
alter table public.subjects add column if not exists external_id    text;
alter table public.subjects add column if not exists external_type  text;
alter table public.subjects add column if not exists sync_status    text not null default 'active';
alter table public.subjects add column if not exists last_synced_at timestamptz;
alter table public.subjects add column if not exists source_meta    jsonb not null default '{}'::jsonb;

alter table public.subjects drop constraint if exists subjects_source_chk;
alter table public.subjects add  constraint subjects_source_chk
  check (source in ('manual','pdf','brightspace'));

alter table public.subjects drop constraint if exists subjects_sync_status_chk;
alter table public.subjects add  constraint subjects_sync_status_chk
  check (sync_status in ('active','modified','removed','unavailable'));

-- LA clé de déduplication. Index PARTIEL : ne contraint que les lignes ayant
-- une identité externe — les matières manuelles (external_id null) ne sont
-- soumises à aucune unicité, exactement comme avant.
create unique index if not exists uq_subjects_external
  on public.subjects(user_id, source, external_id)
  where external_id is not null;

create index if not exists idx_subjects_source on public.subjects(user_id, source);

-- ---- chapters --------------------------------------------------------------
alter table public.chapters add column if not exists source         text not null default 'manual';
alter table public.chapters add column if not exists external_id    text;
alter table public.chapters add column if not exists external_type  text;
alter table public.chapters add column if not exists sync_status    text not null default 'active';
alter table public.chapters add column if not exists last_synced_at timestamptz;
alter table public.chapters add column if not exists sort_order     integer;
alter table public.chapters add column if not exists source_meta    jsonb not null default '{}'::jsonb;

-- Ressources d'un chapitre (liens, fichiers, pages, vidéos) : JSONB et NON
-- une table dédiée. Cohérent avec l'arbitrage déjà documenté sur la table
-- chapters ("les éclater en tables séparées ajouterait des jointures sans
-- bénéfice réel") : une ressource n'est jamais interrogée indépendamment de
-- son chapitre.
alter table public.chapters add column if not exists resources      jsonb not null default '[]'::jsonb;

alter table public.chapters drop constraint if exists chapters_source_chk;
alter table public.chapters add  constraint chapters_source_chk
  check (source in ('manual','pdf','brightspace'));

alter table public.chapters drop constraint if exists chapters_sync_status_chk;
alter table public.chapters add  constraint chapters_sync_status_chk
  check (sync_status in ('active','modified','removed','unavailable'));

create unique index if not exists uq_chapters_external
  on public.chapters(user_id, source, external_id)
  where external_id is not null;

create index if not exists idx_chapters_source on public.chapters(user_id, source);


-- ============================================================================
-- 2. brightspace_connections — la connexion OAuth d'un utilisateur
-- ============================================================================
-- Une connexion par compte (user_id en clé primaire). Si le multi-
-- établissement devient nécessaire un jour, la clé deviendra (user_id, tenant)
-- — ce n'est pas le cas aujourd'hui et on ne construit pas pour un besoin
-- hypothétique.
--
-- SÉCURITÉ DES TOKENS — double verrou, voir section 4 plus bas :
--   • les tokens sont stockés CHIFFRÉS (AES-GCM, clé dans les secrets
--     Supabase, jamais en base) : une fuite de la base ne les expose pas ;
--   • les colonnes chiffrées ne sont dans AUCUN grant au rôle authenticated :
--     le navigateur ne peut pas les lire, même avec une session valide.
create table if not exists public.brightspace_connections (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  tenant_url        text not null,
  external_user_id  text,
  status            text not null default 'connected'
                    check (status in ('connected','expired','revoked','error')),
  scopes            text[] not null default '{}',
  last_synced_at    timestamptz,
  last_error        text,

  -- secrets (chiffrés applicativement par l'Edge Function)
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create or replace trigger trg_brightspace_connections_updated_at
  before update on public.brightspace_connections
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 3. sync_runs — traçabilité et reprise d'une synchronisation
-- ============================================================================
-- `cursor` n'est pas du confort : une Edge Function a une durée d'exécution
-- bornée, et un import de plusieurs centaines de ressources ne tient pas en
-- une invocation. Le curseur rend la synchronisation reprenable et permet
-- d'afficher une progression RÉELLE (et non une fausse barre qui avance
-- toute seule).
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  source        text not null default 'brightspace',
  status        text not null default 'running'
                check (status in ('running','completed','partial','failed','cancelled')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  cursor        jsonb,
  counts        jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_sync_runs_user_started
  on public.sync_runs(user_id, started_at desc);

-- Au plus UNE synchronisation en cours par utilisateur et par source : évite
-- qu'un double-clic ou deux onglets ne lancent deux imports concurrents.
create unique index if not exists uq_sync_runs_one_running
  on public.sync_runs(user_id, source)
  where status = 'running';

create or replace trigger trg_sync_runs_updated_at
  before update on public.sync_runs
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 4. RLS + PRIVILÈGES DE COLONNES
-- ============================================================================
alter table public.brightspace_connections enable row level security;
alter table public.sync_runs               enable row level security;

-- ---- brightspace_connections ----------------------------------------------
-- LECTURE : uniquement sa propre ligne.
drop policy if exists "brightspace_connections_select_own" on public.brightspace_connections;
create policy "brightspace_connections_select_own" on public.brightspace_connections
  for select using (auth.uid() = user_id);

-- ÉCRITURE : AUCUNE policy pour le client. Seules les Edge Functions écrivent,
-- via la clé service_role qui contourne RLS. Un utilisateur ne peut donc pas
-- forger, modifier ni supprimer une connexion depuis le navigateur.

-- Column Level Security : on retire l'accès à toute la table, puis on redonne
-- colonne par colonne — les trois colonnes de secret ne sont volontairement
-- PAS dans cette liste. Elles deviennent inaccessibles au navigateur, quelle
-- que soit la policy RLS.
revoke select on public.brightspace_connections from authenticated;
grant  select (
  user_id, tenant_url, external_user_id, status, scopes,
  last_synced_at, last_error, token_expires_at, created_at, updated_at
) on public.brightspace_connections to authenticated;
-- NON accordées (invisibles au client) : access_token_enc, refresh_token_enc

-- ---- sync_runs -------------------------------------------------------------
-- Contrairement à brightspace_connections, cette table ne contient AUCUN
-- secret : c'est la télémétrie de la synchronisation, pilotée par le client
-- (qui normalise et écrit lui-même dans subjects/chapters — voir l'Edge
-- Function brightspace-api, volontairement réduite à un proxy). Le client a
-- donc les droits classiques sur SES propres lignes.
drop policy if exists "sync_runs_select_own" on public.sync_runs;
create policy "sync_runs_select_own" on public.sync_runs
  for select using (auth.uid() = user_id);
drop policy if exists "sync_runs_insert_own" on public.sync_runs;
create policy "sync_runs_insert_own" on public.sync_runs
  for insert with check (auth.uid() = user_id);
drop policy if exists "sync_runs_update_own" on public.sync_runs;
create policy "sync_runs_update_own" on public.sync_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================================
-- 5. VÉRIFICATION POST-MIGRATION
-- ============================================================================
-- Exécute ceci après la migration : les deux requêtes doivent renvoyer 0 ligne.
--
--   -- (a) aucune donnée existante n'a changé de nature :
--   select count(*) from public.subjects where source <> 'manual';
--   select count(*) from public.chapters where source <> 'manual';
--
--   -- (b) les colonnes de token sont bien inaccessibles au rôle authenticated :
--   select column_name from information_schema.column_privileges
--    where table_name = 'brightspace_connections'
--      and grantee = 'authenticated'
--      and column_name in ('access_token_enc','refresh_token_enc');
--   -- => doit renvoyer 0 ligne
-- ============================================================================
