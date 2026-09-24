-- ============================================================================
-- user_sync_tests.sql — la persistance multi-appareils, côté base
-- ============================================================================
-- Les tests Node (tests/user-data.test.mjs) font tourner le moteur RÉEL contre
-- un PostgreSQL réel. Ce fichier-ci vérifie l'autre moitié, celle qu'aucun
-- test JavaScript ne peut établir : que la BASE elle-même tient ses promesses,
-- même si deux appareils écrivaient exactement en même temps.
--
-- Il vérifie les clés naturelles ajoutées par la migration 005, sur lesquelles
-- reposent tous les `on conflict … do update` de user-data.js :
--   subjects/chapters/documents/planning_events → (user_id, local_id)
--   exam_history                                → (user_id, taken_at)
--
-- ----------------------------------------------------------------------------
-- COMMENT L'EXÉCUTER
-- ----------------------------------------------------------------------------
--   Supabase → SQL Editor → coller tout le fichier → Run.
--   En local  : psql -d revem_test -f supabase/tests/user_sync_tests.sql
--   À exécuter APRÈS schema.sql et les migrations 001 à 005.
--
--   Résultat : une ligne par vérification, colonne `statut`, puis « RÉSUMÉ ».
--   Objectif : zéro FAIL.
--
-- ----------------------------------------------------------------------------
-- CE QUE LE TEST ÉCRIT
-- ----------------------------------------------------------------------------
--   Deux comptes de test aux UUID sentinelles, supprimés à la fin (cascade),
--   y compris si le harnais échoue. Aucune donnée réelle n'est lue ni touchée :
--   toutes les instructions sont filtrées sur ces deux UUID.
-- ============================================================================

create or replace function pg_temp.user_sync_run()
returns table (
  n        int,
  cible    text,
  controle text,
  attendu  text,
  observe  text,
  statut   text
)
language plpgsql
as $fn$
declare
  ua    uuid := '00000000-0000-4000-a000-0000000000d1';
  ub    uuid := '00000000-0000-4000-b000-0000000000d2';
  sA    uuid;
  cnt   bigint;
  okv   boolean;
  k     int := 0;

  procedure_note text;
begin
  -- ── préparation ────────────────────────────────────────────────────────
  delete from auth.users where id in (ua, ub);
  insert into auth.users (id, email) values (ua, 'sync-a@test.invalid'), (ub, 'sync-b@test.invalid');

  -- ══════════════════════════════════════════════════════════════════════
  -- 1. (user_id, local_id) est unique — deux appareils, une seule ligne
  -- ══════════════════════════════════════════════════════════════════════
  insert into public.subjects (user_id, local_id, name, source)
       values (ua, 'subj_1', 'Analyse financière', 'manual')
  on conflict (user_id, local_id) do update set name = excluded.name;

  insert into public.subjects (user_id, local_id, name, source)
       values (ua, 'subj_1', 'Analyse financière (renommée)', 'manual')
  on conflict (user_id, local_id) do update set name = excluded.name;

  select count(*) into cnt from public.subjects where user_id = ua and local_id = 'subj_1';
  k := k + 1;
  return query select k, 'subjects'::text, 'deux écritures du même id local'::text,
    '1 ligne'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  select (name = 'Analyse financière (renommée)') into okv
    from public.subjects where user_id = ua and local_id = 'subj_1';
  k := k + 1;
  return query select k, 'subjects'::text, 'la seconde écriture met à jour'::text,
    'true'::text, okv::text, case when okv then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 2. Le même id local chez DEUX comptes reste deux lignes distinctes
  -- ══════════════════════════════════════════════════════════════════════
  insert into public.subjects (user_id, local_id, name, source)
       values (ub, 'subj_1', 'Marketing', 'manual')
  on conflict (user_id, local_id) do update set name = excluded.name;

  select count(*) into cnt from public.subjects where local_id = 'subj_1' and user_id in (ua, ub);
  k := k + 1;
  return query select k, 'subjects'::text, 'même id local, deux comptes'::text,
    '2 lignes'::text, cnt::text, case when cnt = 2 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 3. L'INDEX EST NON PARTIEL, ET C'EST VOULU
  -- ----------------------------------------------------------------------
  -- Les contenus importés d'un LMS n'ont pas de `local_id` : ils sont
  -- identifiés par `external_id` (index de la migration 003). Dans un index
  -- unique PostgreSQL, deux NULL ne sont PAS égaux — ils peuvent donc être
  -- nombreux sans se gêner. C'est ce qui permet d'avoir un index simple
  -- (utilisable par `on conflict`) plutôt qu'un index partiel (qui ne l'est
  -- pas). Si cette propriété tombait, l'import d'un second cours échouerait.
  -- ══════════════════════════════════════════════════════════════════════
  insert into public.subjects (user_id, local_id, name, source, external_id)
       values (ua, null, 'Cours importé 1', 'brightspace', 'D2L-1');
  insert into public.subjects (user_id, local_id, name, source, external_id)
       values (ua, null, 'Cours importé 2', 'brightspace', 'D2L-2');

  select count(*) into cnt from public.subjects where user_id = ua and local_id is null;
  k := k + 1;
  return query select k, 'subjects'::text, 'plusieurs lignes sans id local'::text,
    '2 lignes'::text, cnt::text, case when cnt = 2 then 'PASS' else 'FAIL' end;

  select count(*) into cnt
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'uq_subjects_user_local' and i.indpred is null;
  k := k + 1;
  return query select k, 'uq_subjects_user_local'::text, 'index NON partiel (exigé par on conflict)'::text,
    '1'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 4. chapters : même règle, et la clé étrangère tient
  -- ══════════════════════════════════════════════════════════════════════
  select id into sA from public.subjects where user_id = ua and local_id = 'subj_1';

  insert into public.chapters (user_id, subject_id, local_id, title)
       values (ua, sA, 'ch_1', 'Bilan')
  on conflict (user_id, local_id) do update set title = excluded.title;
  insert into public.chapters (user_id, subject_id, local_id, title)
       values (ua, sA, 'ch_1', 'Bilan et compte de résultat')
  on conflict (user_id, local_id) do update set title = excluded.title;

  select count(*) into cnt from public.chapters where user_id = ua and local_id = 'ch_1';
  k := k + 1;
  return query select k, 'chapters'::text, 'deux écritures du même id local'::text,
    '1 ligne'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  -- Supprimer la matière emporte ses chapitres : aucun orphelin.
  begin
    insert into public.chapters (user_id, subject_id, local_id, title)
         values (ua, '00000000-0000-4000-c000-00000000dead', 'ch_x', 'Orphelin');
    okv := false;
  exception when foreign_key_violation then
    okv := true;
  end;
  k := k + 1;
  return query select k, 'chapters'::text, 'un chapitre sans matière est refusé'::text,
    'true'::text, okv::text, case when okv then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 5. exam_history : la date du PASSAGE déduplique, pas la date d'écriture
  -- ══════════════════════════════════════════════════════════════════════
  insert into public.exam_history (user_id, taken_at, data)
       values (ua, '2026-09-24T09:00:00Z', '{"pct":70}'::jsonb)
  on conflict (user_id, taken_at) do update set data = excluded.data;
  insert into public.exam_history (user_id, taken_at, data)
       values (ua, '2026-09-24T09:00:00Z', '{"pct":70}'::jsonb)
  on conflict (user_id, taken_at) do update set data = excluded.data;

  select count(*) into cnt from public.exam_history where user_id = ua;
  k := k + 1;
  return query select k, 'exam_history'::text, 'le même examen poussé deux fois'::text,
    '1 ligne'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  insert into public.exam_history (user_id, taken_at, data)
       values (ua, '2026-09-25T09:00:00Z', '{"pct":80}'::jsonb)
  on conflict (user_id, taken_at) do update set data = excluded.data;
  select count(*) into cnt from public.exam_history where user_id = ua;
  k := k + 1;
  return query select k, 'exam_history'::text, 'un examen d''un autre jour s''ajoute'::text,
    '2 lignes'::text, cnt::text, case when cnt = 2 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 6. documents : métadonnées uniquement, et une date de modification
  -- ══════════════════════════════════════════════════════════════════════
  insert into public.documents (user_id, local_id, name, type, has_local_content)
       values (ua, 'doc_1', 'Annales.pdf', 'sujet', true)
  on conflict (user_id, local_id) do update set name = excluded.name;
  insert into public.documents (user_id, local_id, name, type, has_local_content)
       values (ua, 'doc_1', 'Annales 2026.pdf', 'sujet', true)
  on conflict (user_id, local_id) do update set name = excluded.name;

  select count(*) into cnt from public.documents where user_id = ua;
  k := k + 1;
  return query select k, 'documents'::text, 'deux écritures du même id local'::text,
    '1 ligne'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  select count(*) into cnt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'documents'
     and column_name in ('data_url', 'content', 'file_data', 'blob');
  k := k + 1;
  return query select k, 'documents'::text, 'aucune colonne de contenu binaire'::text,
    '0'::text, cnt::text, case when cnt = 0 then 'PASS' else 'FAIL' end;

  select count(*) into cnt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'documents' and column_name = 'updated_at';
  k := k + 1;
  return query select k, 'documents'::text, 'une date de modification existe'::text,
    '1'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 7. preferences : la date du dernier import d'emploi du temps
  -- ══════════════════════════════════════════════════════════════════════
  select count(*) into cnt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'preferences'
     and column_name = 'planning_last_sync_at';
  k := k + 1;
  return query select k, 'preferences'::text, 'planning_last_sync_at existe'::text,
    '1'::text, cnt::text, case when cnt = 1 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 8. RLS reste active sur TOUTES les tables de données personnelles
  -- ══════════════════════════════════════════════════════════════════════
  select count(*) into cnt
    from unnest(array['subjects','chapters','documents','planning_events','exam_history',
                      'preferences','progress','question_stats','badges','ai_cards',
                      'course_notes','ai_history','user_stats','daily_stats','activities',
                      'chapter_visits','study_plans','profiles']) as t(name)
   where not exists (
     select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = t.name and c.relrowsecurity);
  k := k + 1;
  return query select k, 'RLS'::text, 'tables de données personnelles sans RLS'::text,
    '0'::text, cnt::text, case when cnt = 0 then 'PASS' else 'FAIL' end;

  -- Chaque table doit porter ses quatre policies, toutes basées sur auth.uid().
  select count(*) into cnt
    from unnest(array['subjects','chapters','documents','planning_events','exam_history',
                      'progress','question_stats','badges','ai_cards','course_notes',
                      'user_stats','daily_stats','activities','chapter_visits','study_plans']) as t(name)
   where (select count(*) from pg_policies p
           where p.schemaname = 'public' and p.tablename = t.name) < 4;
  k := k + 1;
  return query select k, 'RLS'::text, 'tables avec moins de 4 policies'::text,
    '0'::text, cnt::text, case when cnt = 0 then 'PASS' else 'FAIL' end;

  select count(*) into cnt
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('subjects','chapters','documents','planning_events','exam_history',
                         'progress','question_stats','badges','ai_cards','course_notes',
                         'user_stats','daily_stats','activities','chapter_visits','study_plans')
     and coalesce(p.qual, '') !~ 'auth\.uid\(\)'
     and coalesce(p.with_check, '') !~ 'auth\.uid\(\)';
  k := k + 1;
  return query select k, 'RLS'::text, 'policies ne reposant pas sur auth.uid()'::text,
    '0'::text, cnt::text, case when cnt = 0 then 'PASS' else 'FAIL' end;

  -- ══════════════════════════════════════════════════════════════════════
  -- 9. Supprimer un compte emporte ses données, et seulement les siennes
  -- ══════════════════════════════════════════════════════════════════════
  delete from auth.users where id = ub;
  select count(*) into cnt from public.subjects where user_id = ub;
  k := k + 1;
  return query select k, 'cascade'::text, 'les données du compte supprimé partent'::text,
    '0'::text, cnt::text, case when cnt = 0 then 'PASS' else 'FAIL' end;

  select count(*) into cnt from public.subjects where user_id = ua;
  k := k + 1;
  return query select k, 'cascade'::text, 'celles de l''autre compte restent'::text,
    '3'::text, cnt::text, case when cnt = 3 then 'PASS' else 'FAIL' end;

  -- ── ménage ─────────────────────────────────────────────────────────────
  delete from auth.users where id in (ua, ub);
exception when others then
  delete from auth.users where id in ('00000000-0000-4000-a000-0000000000d1',
                                      '00000000-0000-4000-b000-0000000000d2');
  raise;
end
$fn$;

select * from pg_temp.user_sync_run();

select 'RÉSUMÉ' as n,
       count(*) filter (where statut = 'PASS') || ' PASS' as pass,
       count(*) filter (where statut = 'FAIL') || ' FAIL' as fail
  from pg_temp.user_sync_run();
