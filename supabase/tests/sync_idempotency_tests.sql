-- ============================================================================
-- sync_idempotency_tests.sql — l'upsert de synchronisation, côté base
-- ============================================================================
-- Les tests Node (tests/sync-engine.test.js) prouvent la logique du moteur.
-- Ce fichier-ci prouve l'autre moitié, celle qu'aucun test JavaScript ne peut
-- établir : que la BASE elle-même refuse structurellement les doublons, même
-- si deux onglets, deux appareils ou deux moteurs écrivaient en même temps.
--
-- Il vérifie exactement l'instruction émise par createSupabaseStore() :
--   insert … on conflict (user_id, source, external_id) do update set …
--
-- ----------------------------------------------------------------------------
-- COMMENT L'EXÉCUTER
-- ----------------------------------------------------------------------------
--   Supabase → SQL Editor → coller tout le fichier → Run.
--   En local  : psql -d revem_test -f supabase/tests/sync_idempotency_tests.sql
--   À exécuter APRÈS les migrations 001, 002 et 003.
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

create or replace function pg_temp.sync_idempotency_run()
returns table (
  n        int,
  phase    text,
  cible    text,
  controle text,
  attendu  text,
  observe  text,
  statut   text
)
language plpgsql
as $fn$
declare
  ua      uuid := '00000000-0000-4000-a000-0000000000c1';
  ub      uuid := '00000000-0000-4000-b000-0000000000c2';
  subjA   uuid;
  subjB   uuid;
  cnt     bigint;
  txt     text;
  okv     boolean;
  k       int := 0;
  nb_fail int := 0;
  i       int;
  as_a    text;
  upsert_subject text;
  upsert_chapter text;
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims',    '', false);

  upsert_subject :=
    'insert into public.subjects
       (user_id, name, description, source, external_id, external_type,
        sync_status, last_synced_at, source_updated_at, source_meta, semester_id)
     values (%L, %L, null, ''brightspace'', %L, ''org-unit'',
             ''active'', now(), null, %L::jsonb, ''s1'')
     on conflict (user_id, source, external_id) do update set
       name = excluded.name,
       sync_status = excluded.sync_status,
       last_synced_at = excluded.last_synced_at,
       source_updated_at = excluded.source_updated_at,
       source_meta = excluded.source_meta';

  upsert_chapter :=
    'insert into public.chapters
       (user_id, subject_id, num, title, source, external_id, external_type,
        sync_status, last_synced_at, sort_order, resources, source_meta)
     values (%L, %L, ''01'', %L, ''brightspace'', %L, ''module'',
             ''active'', now(), 1, ''[]''::jsonb, %L::jsonb)
     on conflict (user_id, source, external_id) do update set
       title = excluded.title,
       sync_status = excluded.sync_status,
       last_synced_at = excluded.last_synced_at,
       sort_order = excluded.sort_order,
       resources = excluded.resources,
       source_meta = excluded.source_meta';

  delete from auth.users where id in (ua, ub);
  insert into auth.users (id, email)
       values (ua, 'sync-test-a@example.invalid'), (ub, 'sync-test-b@example.invalid');

  -- ==========================================================================
  -- 1. DIX SYNCHRONISATIONS DU MÊME COURS → UNE SEULE COPIE
  -- ==========================================================================
  for i in 1 .. 10 loop
    execute format(upsert_subject, ua, 'Économie internationale', '101',
                   '{"fingerprint":"abc"}');
  end loop;

  select count(*) into cnt from public.subjects
   where user_id = ua and source = 'brightspace' and external_id = '101';
  k := k + 1; n := k; phase := '1. idempotence'; cible := 'subjects';
  controle := '10 synchronisations du même cours';
  attendu := '1 ligne'; observe := cnt::text || ' ligne(s)';
  okv := (cnt = 1); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  select id into subjA from public.subjects
   where user_id = ua and source = 'brightspace' and external_id = '101';

  for i in 1 .. 10 loop
    execute format(upsert_chapter, ua, subjA, 'Introduction', '1001',
                   '{"fingerprint":"def"}');
  end loop;

  select count(*) into cnt from public.chapters
   where user_id = ua and source = 'brightspace' and external_id = '1001';
  k := k + 1; n := k; phase := '1. idempotence'; cible := 'chapters';
  controle := '10 synchronisations du même chapitre';
  attendu := '1 ligne'; observe := cnt::text || ' ligne(s)';
  okv := (cnt = 1); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- L'identifiant local ne doit pas changer : les fiches, quiz et statistiques
  -- rattachés à ce chapitre y survivent.
  k := k + 1; n := k; phase := '1. idempotence'; cible := 'subjects';
  controle := 'l''identifiant local reste stable';
  attendu := 'même id qu''à la première écriture';
  select id into subjB from public.subjects
   where user_id = ua and source = 'brightspace' and external_id = '101';
  okv := (subjA = subjB); observe := case when okv then 'identique' else 'changé' end;
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 2. LE CONTENU PRODUIT DANS REV-EM SURVIT À UNE RESYNCHRONISATION
  -- ==========================================================================
  update public.chapters
     set content = 'Fiche rédigée par l''élève',
         ai_quiz = '[{"q":"question générée"}]'::jsonb
   where user_id = ua and external_id = '1001';

  execute format(upsert_chapter, ua, subjA, 'Introduction — révisée', '1001',
                 '{"fingerprint":"ghi"}');

  select content into txt from public.chapters
   where user_id = ua and external_id = '1001';
  k := k + 1; n := k; phase := '2. non-destruction'; cible := 'chapters';
  controle := 'la fiche de l''élève après resynchronisation';
  attendu := 'intacte'; observe := coalesce(txt, '(vide)');
  okv := (txt = 'Fiche rédigée par l''élève');
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  select ai_quiz::text into txt from public.chapters
   where user_id = ua and external_id = '1001';
  k := k + 1; n := k; phase := '2. non-destruction'; cible := 'chapters';
  controle := 'le quiz généré après resynchronisation';
  attendu := 'intact'; observe := coalesce(txt, '(vide)');
  okv := (txt like '%question générée%');
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  select title into txt from public.chapters
   where user_id = ua and external_id = '1001';
  k := k + 1; n := k; phase := '2. non-destruction'; cible := 'chapters';
  controle := 'le titre suit bien la source';
  attendu := 'Introduction — révisée'; observe := coalesce(txt, '(vide)');
  okv := (txt = 'Introduction — révisée');
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 3. LA DÉDUPLICATION EST PAR COMPTE, PAS GLOBALE
  -- ==========================================================================
  execute format(upsert_subject, ub, 'Économie internationale', '101',
                 '{"fingerprint":"abc"}');

  select count(*) into cnt from public.subjects
   where source = 'brightspace' and external_id = '101' and user_id in (ua, ub);
  k := k + 1; n := k; phase := '3. comptes A/B'; cible := 'subjects';
  controle := 'le même cours importé par deux comptes';
  attendu := '2 lignes (une par compte)'; observe := cnt::text || ' ligne(s)';
  okv := (cnt = 2); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- La resynchronisation de A ne doit rien changer chez B.
  update public.subjects set name = 'Nom choisi par B'
   where user_id = ub and external_id = '101';
  for i in 1 .. 3 loop
    execute format(upsert_subject, ua, 'Nom venant de la source', '101',
                   '{"fingerprint":"abc"}');
  end loop;
  select name into txt from public.subjects where user_id = ub and external_id = '101';
  k := k + 1; n := k; phase := '3. comptes A/B'; cible := 'subjects';
  controle := 'la ligne de B après 3 synchronisations de A';
  attendu := 'inchangée'; observe := coalesce(txt, '(vide)');
  okv := (txt = 'Nom choisi par B');
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- Et A ne peut pas écrire au nom de B, même avec l'upsert (RLS).
  as_a := format(
    'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
    ua::text, jsonb_build_object('sub', ua::text, 'role', 'authenticated')::text);
  okv := false;
  begin
    execute as_a;
    execute 'set role authenticated';
    execute format(upsert_subject, ub, 'injecté par A', '999', '{}');
    observe := 'ACCEPTÉ';
  exception when others then
    observe := 'refusé (' || sqlstate || ')'; okv := true;
  end;
  execute 'reset role';
  k := k + 1; n := k; phase := '3. comptes A/B'; cible := 'subjects';
  controle := 'A tente un upsert au nom de B';
  attendu := 'refus'; statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 4. LES CONTENUS SANS IDENTITÉ EXTERNE RESTENT LIBRES
  -- ==========================================================================
  -- Un index unique non partiel ne doit PAS empêcher un élève de créer
  -- plusieurs matières à la main (external_id null, donc jamais en conflit :
  -- deux NULL ne sont pas égaux dans un index unique PostgreSQL).
  insert into public.subjects (user_id, name, semester_id) values (ua, 'Manuelle 1', 's1');
  insert into public.subjects (user_id, name, semester_id) values (ua, 'Manuelle 2', 's1');
  insert into public.subjects (user_id, name, semester_id) values (ua, 'Manuelle 3', 's1');
  select count(*) into cnt from public.subjects
   where user_id = ua and source = 'manual' and external_id is null;
  k := k + 1; n := k; phase := '4. contenus locaux'; cible := 'subjects';
  controle := '3 matières créées à la main';
  attendu := '3 lignes'; observe := cnt::text || ' ligne(s)';
  okv := (cnt = 3); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 5. JOURNAL DE SYNCHRONISATION
  -- ==========================================================================
  -- 5a. les cinq états sont acceptés
  okv := true; observe := 'tous acceptés';
  begin
    insert into public.sync_runs (user_id, source, status) values (ua, 'test-a', 'started');
    insert into public.sync_runs (user_id, source, status, finished_at) values (ua, 'test-b', 'completed', now());
    insert into public.sync_runs (user_id, source, status, finished_at) values (ua, 'test-c', 'partial', now());
    insert into public.sync_runs (user_id, source, status, finished_at) values (ua, 'test-d', 'failed', now());
    insert into public.sync_runs (user_id, source, status, finished_at) values (ua, 'test-e', 'cancelled', now());
  exception when others then
    okv := false; observe := 'refusé (' || sqlstate || ') : ' || sqlerrm;
  end;
  k := k + 1; n := k; phase := '5. journal'; cible := 'sync_runs';
  controle := 'started / completed / partial / failed / cancelled';
  attendu := 'les 5 états acceptés';
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- 5b. l'ancien vocabulaire est refusé (une seule vérité)
  okv := false;
  begin
    insert into public.sync_runs (user_id, source, status) values (ua, 'test-f', 'running');
    observe := 'ACCEPTÉ';
  exception when check_violation then
    observe := 'refusé (contrainte CHECK)'; okv := true;
  when others then
    observe := 'refusé (' || sqlstate || ')'; okv := true;
  end;
  k := k + 1; n := k; phase := '5. journal'; cible := 'sync_runs';
  controle := 'l''ancien statut ''running'' n''est plus accepté';
  attendu := 'refus'; statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- 5c. une seule exécution ouverte à la fois, par compte et par source
  okv := false;
  begin
    insert into public.sync_runs (user_id, source, status) values (ua, 'test-a', 'started');
    observe := 'ACCEPTÉ — deux synchronisations concurrentes possibles';
  exception when unique_violation then
    observe := 'refusé (index unique)'; okv := true;
  end;
  k := k + 1; n := k; phase := '5. journal'; cible := 'sync_runs';
  controle := 'deuxième exécution ouverte sur la même source';
  attendu := 'refus'; statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- 5d. … mais une fois la première terminée, une nouvelle est possible
  okv := false;
  begin
    update public.sync_runs set status = 'completed', finished_at = now()
     where user_id = ua and source = 'test-a' and status = 'started';
    insert into public.sync_runs (user_id, source, status) values (ua, 'test-a', 'started');
    observe := 'acceptée'; okv := true;
  exception when others then
    observe := 'refusée à tort (' || sqlstate || ')';
  end;
  k := k + 1; n := k; phase := '5. journal'; cible := 'sync_runs';
  controle := 'nouvelle exécution après clôture de la précédente';
  attendu := 'acceptée'; statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- 5e. le curseur de reprise se relit tel qu'il a été écrit
  update public.sync_runs
     set cursor = '{"containersDone":true,"doneKeys":["101","202"]}'::jsonb
   where user_id = ua and source = 'test-c';
  select cursor->>'doneKeys' into txt from public.sync_runs
   where user_id = ua and source = 'test-c';
  k := k + 1; n := k; phase := '5. journal'; cible := 'sync_runs';
  controle := 'le curseur de reprise est conservé';
  attendu := '["101", "202"]'; observe := coalesce(txt, '(vide)');
  okv := (txt is not null and txt like '%101%' and txt like '%202%');
  statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 6. STRUCTURE — ce dont le moteur dépend existe vraiment
  -- ==========================================================================
  select count(*) into cnt from information_schema.columns
   where table_schema = 'public' and column_name = 'source_updated_at'
     and table_name in ('subjects','chapters');
  k := k + 1; n := k; phase := '6. structure'; cible := 'subjects/chapters';
  controle := 'colonne source_updated_at';
  attendu := '2 colonnes'; observe := cnt::text;
  okv := (cnt = 2); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  select count(*) into cnt from pg_indexes
   where schemaname = 'public'
     and indexname in ('uq_subjects_source_external','uq_chapters_source_external')
     and indexdef not like '%WHERE%';
  k := k + 1; n := k; phase := '6. structure'; cible := 'subjects/chapters';
  controle := 'index uniques NON partiels (condition de l''upsert)';
  attendu := '2 index'; observe := cnt::text;
  okv := (cnt = 2); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  select count(*) into cnt from pg_indexes
   where schemaname = 'public'
     and indexname in ('uq_subjects_external','uq_chapters_external');
  k := k + 1; n := k; phase := '6. structure'; cible := 'subjects/chapters';
  controle := 'les anciens index partiels ont été retirés';
  attendu := '0'; observe := cnt::text;
  okv := (cnt = 0); statut := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if; return next;

  -- ==========================================================================
  -- 7. NETTOYAGE + RÉSUMÉ
  -- ==========================================================================
  execute 'reset role';
  delete from auth.users where id in (ua, ub);

  k := k + 1; n := k; phase := 'RÉSUMÉ'; cible := '';
  controle := (k - 1)::text || ' vérifications exécutées';
  attendu := '0 FAIL'; observe := nb_fail::text || ' FAIL';
  statut := case when nb_fail = 0 then 'PASS' else 'FAIL' end;
  return next;
  return;

exception when others then
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims',    '', false);
  delete from auth.users where id in (ua, ub);
  raise;
end;
$fn$;

select * from pg_temp.sync_idempotency_run();
