-- ============================================================================
-- REV-EM — migration 005 : rendre les données utilisateur synchronisables
-- ============================================================================
-- À exécuter APRÈS schema.sql, 001, 002, 003 et 004.
-- Idempotente : relançable sans risque. AUCUNE suppression, AUCUN drop de
-- table, AUCUNE colonne retirée, AUCUNE donnée existante modifiée.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- ----------------------------------------------------------------------------
-- POURQUOI CETTE MIGRATION EXISTE
-- ----------------------------------------------------------------------------
-- Les 18 tables de données utilisateur existaient déjà (schema.sql + 002), avec
-- leur RLS. Ce qui manquait n'était pas des tables : c'étaient les CLÉS
-- NATURELLES permettant d'écrire de façon idempotente depuis plusieurs
-- appareils.
--
-- Sans clé naturelle, la seule écriture possible est « lire puis insérer », qui
-- ouvre une fenêtre de course entre les deux : deux appareils qui se
-- synchronisent en même temps créent deux lignes pour la même matière. Avec la
-- clé, l'écriture devient `on conflict (…) do update`, atomique côté
-- PostgreSQL. C'est exactement le raisonnement déjà tenu par la migration 003
-- pour les contenus importés (voir SYNC_ARCHITECTURE.md, « L'idempotence,
-- concrètement ») — on l'étend ici aux données personnelles.
--
-- Les objets créés côté client portent déjà un identifiant stable et unique
-- (`genLibId()` dans index.html : préfixe + horodatage + aléa). C'est lui qui
-- sert de clé naturelle, stocké dans la colonne `local_id` qui existait déjà
-- mais n'était contrainte par rien.
--
-- ----------------------------------------------------------------------------
-- POURQUOI DES INDEX NON PARTIELS
-- ----------------------------------------------------------------------------
-- Même raison qu'en 003, et c'est important : PostgreSQL ne sait pas déduire un
-- index PARTIEL depuis `on conflict (a, b)` sans que la requête répète le
-- prédicat, ce que le client Supabase ne sait pas exprimer. Un index partiel
-- rendrait donc l'upsert impossible.
--
-- Un index non partiel donne ici la même garantie, parce que dans un index
-- unique PostgreSQL DEUX NULL NE SONT PAS ÉGAUX : les lignes sans `local_id`
-- (contenus importés depuis un LMS, qui sont identifiés par `external_id` et
-- possèdent déjà leur propre contrainte depuis 003) restent libres de
-- coexister. Le test 3 de supabase/tests/user_sync_tests.sql le vérifie.
-- ============================================================================


-- ============================================================================
-- 1. CLÉS NATURELLES SUR LES COLLECTIONS CRÉÉES PAR L'UTILISATEUR
-- ============================================================================
-- subjects / chapters : `local_id` existait déjà (schema.sql) « pour le
-- rapprochement », sans contrainte. On le rend unique par utilisateur.
create unique index if not exists uq_subjects_user_local
  on public.subjects(user_id, local_id);

create unique index if not exists uq_chapters_user_local
  on public.chapters(user_id, local_id);

-- documents : métadonnées seulement (le binaire reste local à l'appareil,
-- décision du 19/09 conservée telle quelle — voir schema.sql).
create unique index if not exists uq_documents_user_local
  on public.documents(user_id, local_id);

-- planning_events : `local_id` est l'identifiant de l'événement côté client
-- (souvent l'UID du flux .ics, sinon un id généré).
create unique index if not exists uq_planning_events_user_local
  on public.planning_events(user_id, local_id);


-- ============================================================================
-- 2. exam_history — une date d'examen, pour pouvoir réécrire sans dupliquer
-- ============================================================================
-- La table ne portait que `data jsonb` et `created_at`. `created_at` est la
-- date d'ÉCRITURE, pas celle du passage : deux appareils qui poussent le même
-- examen produisaient deux lignes. On extrait la date réelle du passage, qui
-- est déjà dans le JSON (`data->>'date'`, écrite par index.html).
alter table public.exam_history add column if not exists taken_at timestamptz;

-- Rattrapage des lignes déjà présentes, sans en perdre aucune : la date du
-- JSON quand elle existe, sinon la date d'écriture (approximation explicite,
-- jamais une valeur inventée).
update public.exam_history
   set taken_at = coalesce(
     nullif(data->>'date', '')::timestamptz,
     created_at
   )
 where taken_at is null;

-- Deux examens passés à la même milliseconde par le même utilisateur, c'est
-- le même examen poussé deux fois. Les lignes historiques qui se
-- retrouveraient en double après le rattrapage ci-dessus sont dédupliquées
-- (on garde la plus ancienne écriture) — sinon l'index unique échouerait.
delete from public.exam_history e
 using public.exam_history keep
 where e.user_id  = keep.user_id
   and e.taken_at = keep.taken_at
   and e.created_at > keep.created_at;

create unique index if not exists uq_exam_history_user_taken
  on public.exam_history(user_id, taken_at);


-- ============================================================================
-- 3. documents — une date de modification, pour arbitrer les conflits
-- ============================================================================
-- C'était la seule table de collection sans `updated_at` : impossible d'y
-- appliquer la règle « le dernier qui écrit gagne, arbitré par updated_at ».
alter table public.documents
  add column if not exists updated_at timestamptz not null default now();

create or replace trigger trg_documents_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 4. preferences — la dernière synchronisation du planning
-- ============================================================================
-- `state.planning.lastSyncAt` était la seule donnée de `state.planning` sans
-- colonne : l'URL du flux était déjà là (planning_official_url), les
-- événements aussi (planning_events), mais pas la date du dernier import.
-- Sans elle, l'appareil B réimportait le flux comme s'il ne l'avait jamais vu.
alter table public.preferences
  add column if not exists planning_last_sync_at timestamptz;


-- ============================================================================
-- 5. RLS — vérification, pas création
-- ============================================================================
-- Aucune table n'est créée ici, donc aucune policy n'est à créer : celles de
-- schema.sql et 002 (auth.uid() = user_id, en select/insert/update/delete)
-- couvrent déjà toutes les tables touchées. Ce bloc échoue bruyamment si ce
-- n'est plus vrai — mieux vaut une migration qui refuse de s'appliquer qu'une
-- table de données personnelles laissée ouverte.
do $$
declare
  t text;
  missing text[] := '{}';
begin
  foreach t in array array[
    'subjects', 'chapters', 'documents', 'planning_events', 'exam_history',
    'preferences', 'progress', 'question_stats', 'badges', 'ai_cards',
    'course_notes', 'ai_history', 'user_stats', 'daily_stats', 'activities',
    'chapter_visits', 'study_plans', 'profiles'
  ]
  loop
    if not exists (
      select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      missing := missing || t;
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception
      'RLS désactivée sur : %. Rejouer supabase/schema.sql et 002_centralisation.sql avant cette migration.',
      array_to_string(missing, ', ');
  end if;
end $$;
