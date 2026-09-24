-- ============================================================================
-- REV-EM — migration 003 : support de la couche de synchronisation générique
-- ============================================================================
-- À exécuter APRÈS schema.sql, 001_brightspace.sql et 002_centralisation.sql.
-- Idempotente. AUCUNE table supprimée, AUCUNE colonne retirée, AUCUNE donnée
-- effacée. Trois changements, chacun exigé par un point précis du besoin.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- ----------------------------------------------------------------------------
-- 1. `source_updated_at` — la date de modification côté source
-- ----------------------------------------------------------------------------
-- Chaque élément externe doit porter : source, external_id, user_id,
-- last_synced_at, source_updated_at (si la source la fournit) et un statut.
-- Les cinq premiers existaient déjà (001) ; il manquait source_updated_at.
--
-- Nullable À DESSEIN : toutes les sources ne datent pas leurs contenus. Une
-- valeur absente reste null — on ne fabrique jamais une date en la remplaçant
-- par celle de l'import, ce qui ferait passer une supposition pour un fait.
--
-- ----------------------------------------------------------------------------
-- 2. Index uniques non partiels — l'upsert idempotent
-- ----------------------------------------------------------------------------
-- 001 créait `unique (user_id, source, external_id) where external_id is not
-- null`. Correct fonctionnellement, mais PostgreSQL ne peut pas déduire un
-- index PARTIEL depuis `on conflict (user_id, source, external_id)` sans que
-- la requête répète le prédicat — ce que le client Supabase ne permet pas
-- d'exprimer. L'upsert idempotent était donc impossible : il fallait lire
-- puis insérer, avec une fenêtre de course entre les deux (deux onglets, deux
-- appareils → deux copies du même cours).
--
-- Un index NON partiel donne exactement la même garantie ici : dans un index
-- unique PostgreSQL, deux NULL ne sont PAS considérés égaux (comportement par
-- défaut, `nulls distinct`). Les lignes manuelles et PDF, dont external_id est
-- null, restent donc libres de se répéter autant que nécessaire.
--
-- ----------------------------------------------------------------------------
-- 3. `sync_runs.status` : 'running' → 'started'
-- ----------------------------------------------------------------------------
-- Le journal doit exposer les cinq états started / completed / partial /
-- failed / cancelled. 'running' était le même état sous un autre nom : deux
-- vocabulaires pour une seule réalité, c'est une source de bugs. On renomme,
-- et la contrainte comme l'index unique suivent.
-- ============================================================================


-- ============================================================================
-- 1. DATE DE MODIFICATION CÔTÉ SOURCE
-- ============================================================================
-- ============================================================================
-- PRÉREQUIS — à lire si cette migration refuse de s'exécuter
-- ----------------------------------------------------------------------------
-- Les migrations s'appliquent DANS L'ORDRE NUMÉRIQUE, en commençant par
-- 000_schema.sql, qui crée les tables de base. Ce bloc le vérifie et s'arrête
-- avec un message qui dit QUOI FAIRE, plutôt que de laisser PostgreSQL
-- échouer plus bas sur un « relation ... does not exist » qui ne dit rien.
--
-- Il ne modifie rien : il constate.
-- ============================================================================
do $prereq$
declare
  manquant text := null;
begin
  if to_regclass('public.user_stats') is not null then null; else manquant := '002_centralisation.sql'; end if;
  if to_regclass('public.brightspace_connections') is not null then null; else manquant := '001_brightspace.sql'; end if;
  if to_regclass('public.subjects') is not null then null; else manquant := '000_schema.sql'; end if;

  if manquant is not null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — ' || manquant,
      detail  = 'Cette migration suppose que ' || manquant || ' a déjà été appliquée, '
             || 'et la base montre que ce n''est pas le cas.',
      hint    = 'Dans le SQL Editor, exécute les fichiers de supabase/migrations/ '
             || 'dans cet ordre : 000_schema.sql → 001_brightspace.sql → 002_centralisation.sql → 003_sync_layer.sql. '
             || 'Ils sont tous idempotents : relancer ceux déjà passés ne crée aucun doublon. '
             || 'Pour savoir où tu en es, exécute supabase/tests/00_diagnostic.sql.';
  end if;
end
$prereq$;


alter table public.subjects add column if not exists source_updated_at timestamptz;
alter table public.chapters add column if not exists source_updated_at timestamptz;

comment on column public.subjects.source_updated_at is
  'Date de dernière modification déclarée par la source externe. NULL si la source ne la fournit pas — jamais remplacée par la date d''import.';
comment on column public.chapters.source_updated_at is
  'Date de dernière modification déclarée par la source externe. NULL si la source ne la fournit pas — jamais remplacée par la date d''import.';


-- ============================================================================
-- 2. UNICITÉ (user_id, source, external_id) — SANS prédicat partiel
-- ============================================================================
-- Ordre volontaire : on crée le nouvel index AVANT de supprimer l'ancien, pour
-- qu'il n'existe à aucun instant de fenêtre sans protection d'unicité.
--
-- Si des doublons existaient déjà (impossible avec l'ancien index, mais on ne
-- suppose pas), la création échouerait ici — c'est le comportement voulu : il
-- vaut mieux une migration qui s'arrête qu'une migration qui perd des lignes.
create unique index if not exists uq_subjects_source_external
  on public.subjects(user_id, source, external_id);
create unique index if not exists uq_chapters_source_external
  on public.chapters(user_id, source, external_id);

drop index if exists public.uq_subjects_external;
drop index if exists public.uq_chapters_external;


-- ============================================================================
-- 3. JOURNAL DE SYNCHRONISATION — cinq états explicites
-- ============================================================================
-- 3a. Les lignes existantes d'abord : la contrainte ne peut être resserrée
--     qu'une fois les données conformes.
update public.sync_runs set status = 'started' where status = 'running';

-- 3b. L'index unique référence l'ancienne valeur dans son prédicat : il doit
--     disparaître avant que 'running' ne devienne invalide.
drop index if exists public.uq_sync_runs_one_running;

-- 3c. Contrainte CHECK : on la remplace par son équivalent sur le nouveau
--     vocabulaire. Le nom est stable, donc le drop est sûr et rejouable.
alter table public.sync_runs drop constraint if exists sync_runs_status_check;
alter table public.sync_runs add  constraint sync_runs_status_check
  check (status in ('started','completed','partial','failed','cancelled'));

alter table public.sync_runs alter column status set default 'started';

-- 3d. Toujours au plus UNE synchronisation en cours par utilisateur et par
--     source : un double-clic ou un second onglet ne peut pas lancer un
--     deuxième import concurrent.
create unique index if not exists uq_sync_runs_one_started
  on public.sync_runs(user_id, source)
  where status = 'started';

-- 3e. Reprise : le moteur lit la DERNIÈRE exécution de cette source, quel que
--     soit son statut, et ne la reprend que si elle est restée ouverte ou a
--     été annulée. Filtrer l'index sur ces deux statuts serait contre-productif
--     ici : c'est justement en voyant le statut de la dernière ligne, même
--     terminée, qu'on évite de reprendre une vieille annulation déjà remplacée
--     par une synchronisation complète.
create index if not exists idx_sync_runs_user_source_started
  on public.sync_runs(user_id, source, started_at desc);

comment on column public.sync_runs.cursor is
  'Curseur de reprise : { doneKeys: [external_id des conteneurs déjà traités], containersDone: bool }. Écrit après chaque conteneur pour qu''une interruption ne fasse jamais tout recommencer.';


-- ============================================================================
-- 4. VÉRIFICATION POST-MIGRATION
-- ============================================================================
-- (a) les colonnes existent → doit renvoyer 2 lignes :
--
--   select table_name, column_name from information_schema.columns
--    where table_schema='public' and column_name='source_updated_at';
--
-- (b) les index uniques sont non partiels → `indexdef` ne doit PAS contenir
--     de clause WHERE :
--
--   select indexname, indexdef from pg_indexes
--    where schemaname='public'
--      and indexname in ('uq_subjects_source_external','uq_chapters_source_external');
--
-- (c) plus aucune exécution au statut 'running' → doit renvoyer 0 :
--
--   select count(*) from public.sync_runs where status = 'running';
--
-- (d) aucune donnée perdue — les comptes doivent être inchangés :
--
--   select 'subjects' t, count(*) from public.subjects
--   union all select 'chapters', count(*) from public.chapters
--   union all select 'sync_runs', count(*) from public.sync_runs;
--
-- L'idempotence réelle de l'upsert est prouvée par
-- supabase/tests/sync_idempotency_tests.sql (10 synchronisations → 1 ligne).
-- ============================================================================
