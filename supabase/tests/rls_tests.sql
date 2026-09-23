-- ============================================================================
-- rls_tests.sql — tests d'isolation RLS entre deux comptes (A → B et B → A)
-- ============================================================================
-- Ce que ce fichier prouve, table par table :
--   • SELECT : A ne voit aucune ligne de B (et réciproquement) ;
--   • UPDATE : A ne modifie aucune ligne de B ;
--   • DELETE : A ne supprime aucune ligne de B ;
--   • INSERT : A ne peut pas créer une ligne AU NOM de B ;
--   • contrôles positifs : A agit bien sur SES propres lignes — sans eux, une
--     base qui refuserait tout passerait les tests sans rien protéger ;
--   • rôle anon (non connecté) : aucune ligne visible nulle part ;
--   • colonnes de tokens Brightspace : inaccessibles au navigateur.
--
-- ----------------------------------------------------------------------------
-- COMMENT L'EXÉCUTER
-- ----------------------------------------------------------------------------
--   Supabase → SQL Editor → coller TOUT ce fichier → Run.
--   En local  : psql -d revem_test -f supabase/tests/rls_tests.sql
--
--   Le résultat est un tableau : une ligne par vérification, colonne `statut`
--   à PASS ou FAIL, et une ligne « RÉSUMÉ » en dernier.
--   Objectif : zéro FAIL.
--
-- ----------------------------------------------------------------------------
-- CE QUE LE TEST ÉCRIT DANS LA BASE
-- ----------------------------------------------------------------------------
--   Deux comptes de test sont créés dans auth.users avec des UUID sentinelles
--   (…-a000-…000a et …-b000-…000b), puis des lignes de test leur sont
--   rattachées. Tout est supprimé à la fin de l'exécution : le DELETE de ces
--   deux comptes fait disparaître toutes les lignes par cascade (ON DELETE
--   CASCADE). Le nettoyage a lieu aussi en cas d'erreur.
--   AUCUNE donnée d'un compte réel n'est lue, modifiée ou supprimée : toutes
--   les instructions sont filtrées sur ces deux UUID.
--
--   Les fonctions sont créées dans `pg_temp` : elles disparaissent avec la
--   session, rien n'est ajouté au schéma.
-- ============================================================================

create or replace function pg_temp.rls_test_run()
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
  ua        uuid := '00000000-0000-4000-a000-00000000000a';
  ub        uuid := '00000000-0000-4000-b000-00000000000b';
  sa        uuid;
  sb        uuid;
  actor     uuid;
  victim    uuid;
  uid       uuid;
  dir       text;
  tbl       text;
  own       text;
  stmt      text;
  vals      text;
  as_actor  text;
  cnt       bigint;
  okv       boolean;
  expect_ok boolean;
  k         int := 0;
  nb_fail   int := 0;
  i         int;
  j         int;
  d         int;
  op        int;

  -- table | colonne propriétaire | colonnes complémentaires | valeurs A |
  -- valeurs B | INSERT propre testable | policy UPDATE | policy DELETE
  --
  -- Ordre : les tables dépendantes AVANT celles dont elles dépendent, pour que
  -- le contrôle positif « DELETE de ses propres lignes » ne se fasse pas
  -- devancer par une suppression en cascade.
  fx text[] := array[
    array['chapters','user_id','subject_id, title','{SA}, ''Chapitre A''','{SB}, ''Chapitre B''','n','y','y'],
    array['documents','user_id','name','''doc-a.pdf''','''doc-b.pdf''','y','y','y'],
    array['subjects','user_id','name','''RLS matière A2''','''RLS matière B2''','y','y','y'],
    array['progress','user_id','kind, scope','''quiz'', ''chap-a''','''quiz'', ''chap-b''','y','y','y'],
    array['question_stats','user_id','question_uid','''q-a''','''q-b''','y','y','y'],
    array['exam_history','user_id','data','''{}''::jsonb','''{}''::jsonb','y','y','y'],
    array['badges','user_id','badge_id, earned_date','''badge-a'', now()','''badge-b'', now()','y','y','y'],
    array['ai_cards','user_id','builtin_chapter_id','''ch-a''','''ch-b''','y','y','y'],
    array['ai_history','user_id','','','','n','y','y'],
    array['course_notes','user_id','event_id','''ev-a''','''ev-b''','y','y','y'],
    array['planning_events','user_id','data','''{}''::jsonb','''{}''::jsonb','y','y','y'],
    array['preferences','user_id','','','','n','y','y'],
    array['user_stats','user_id','','','','n','y','y'],
    array['daily_stats','user_id','day','current_date','current_date - 1','y','y','y'],
    array['activities','user_id','ts, day, type','now(), current_date, ''quiz''','now() - interval ''1 hour'', current_date, ''flashcards''','y','y','y'],
    array['chapter_visits','user_id','chapter_key','''ch-a''','''ch-b''','y','y','y'],
    array['study_plans','user_id','','','','n','y','y'],
    array['sync_runs','user_id','status','''started''','''completed''','y','y','n'],
    array['brightspace_connections','user_id','tenant_url','''https://tenant-a.example''','''https://tenant-b.example''','n','n','n'],
    array['profiles','id','display_name','''RLS A''','''RLS B''','n','y','n']
  ];
begin
  -- ==========================================================================
  -- 0. PRÉPARATION — deux comptes de test
  -- ==========================================================================
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims',    '', false);

  delete from auth.users where id in (ua, ub);
  insert into auth.users (id, email)
       values (ua, 'rls-test-a@example.invalid'),
              (ub, 'rls-test-b@example.invalid');

  insert into public.subjects (user_id, name) values (ua, 'RLS matière A') returning id into sa;
  insert into public.subjects (user_id, name) values (ub, 'RLS matière B') returning id into sb;

  -- Une ligne de test par table et par compte, insérée en tant que propriétaire
  -- de la base (RLS contournée) : c'est la situation de départ, pas un test.
  for i in 1 .. array_length(fx, 1) loop
    for j in 1 .. 2 loop
      uid  := case when j = 1 then ua else ub end;
      vals := case when j = 1 then fx[i][4] else fx[i][5] end;
      vals := replace(replace(vals, '{SA}', quote_literal(sa)), '{SB}', quote_literal(sb));
      if fx[i][3] = '' then
        stmt := format('insert into public.%I (%I) values (%L)', fx[i][1], fx[i][2], uid);
      else
        stmt := format('insert into public.%I (%I, %s) values (%L, %s)',
                       fx[i][1], fx[i][2], fx[i][3], uid, vals);
      end if;
      begin
        execute stmt;
      exception when unique_violation then
        -- profiles : la ligne existe déjà, créée par le trigger on_auth_user_created.
        null;
      end;
    end loop;
  end loop;

  -- ==========================================================================
  -- 1. ISOLATION CROISÉE — A → B puis B → A
  -- ==========================================================================
  for d in 1 .. 2 loop
    actor  := case when d = 1 then ua else ub end;
    victim := case when d = 1 then ub else ua end;
    dir    := case when d = 1 then '1. A -> B' else '2. B -> A' end;
    as_actor := format(
      'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
      actor::text,
      jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text);

    for i in 1 .. array_length(fx, 1) loop
      tbl := fx[i][1];
      own := fx[i][2];

      for op in 1 .. 4 loop
        okv     := false;
        observe := null;

        begin
          execute as_actor;
          execute 'set role authenticated';

          case op
            when 1 then
              execute format('select count(*) from public.%I where %I = %L', tbl, own, victim) into cnt;
              observe := cnt::text || ' ligne(s) lue(s)';
              okv     := (cnt = 0);
            when 2 then
              execute format('update public.%I set %I = %I where %I = %L', tbl, own, own, own, victim);
              get diagnostics cnt = row_count;
              observe := cnt::text || ' ligne(s) modifiée(s)';
              okv     := (cnt = 0);
            when 3 then
              execute format('delete from public.%I where %I = %L', tbl, own, victim);
              get diagnostics cnt = row_count;
              observe := cnt::text || ' ligne(s) supprimée(s)';
              okv     := (cnt = 0);
            else
              -- Insertion d'une ligne appartenant à l'autre compte. On réutilise
              -- les valeurs de l'acteur : elles diffèrent de celles déjà
              -- présentes chez la victime, donc un éventuel refus ne peut pas
              -- venir d'une contrainte d'unicité.
              vals := case when d = 1 then fx[i][4] else fx[i][5] end;
              vals := replace(replace(vals, '{SA}', quote_literal(sa)), '{SB}', quote_literal(sb));
              if fx[i][3] = '' then
                stmt := format('insert into public.%I (%I) values (%L)', tbl, own, victim);
              else
                stmt := format('insert into public.%I (%I, %s) values (%L, %s)',
                               tbl, own, fx[i][3], victim, vals);
              end if;
              execute stmt;
              observe := 'INSERTION ACCEPTÉE';
              okv     := false;
          end case;
        exception when others then
          -- Un refus du moteur (42501 : RLS ou privilège absent) vaut isolation.
          observe := 'refusé (' || sqlstate || ')';
          okv     := true;
        end;

        k        := k + 1;
        n        := k;
        phase    := dir;
        cible    := tbl;
        controle := case op
                      when 1 then 'SELECT des lignes de l''autre compte'
                      when 2 then 'UPDATE des lignes de l''autre compte'
                      when 3 then 'DELETE des lignes de l''autre compte'
                      else        'INSERT d''une ligne au nom de l''autre compte'
                    end;
        attendu  := case op
                      when 1 then '0 ligne'
                      when 2 then '0 ligne modifiée'
                      when 3 then '0 ligne supprimée'
                      else        'refus'
                    end;
        statut   := case when okv then 'PASS' else 'FAIL' end;
        if not okv then nb_fail := nb_fail + 1; end if;
        return next;
      end loop;
    end loop;
  end loop;

  -- ==========================================================================
  -- 2. CONTRÔLES POSITIFS — chaque compte agit bien sur SES propres lignes
  -- ==========================================================================
  -- Sans cette phase, une base qui refuserait tout à tout le monde passerait la
  -- phase 1 en entier sans protéger quoi que ce soit.
  for d in 1 .. 2 loop
    actor    := case when d = 1 then ua else ub end;
    dir      := case when d = 1 then '3. A sur A' else '4. B sur B' end;
    as_actor := format(
      'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
      actor::text,
      jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text);

    for i in 1 .. array_length(fx, 1) loop
      tbl := fx[i][1];
      own := fx[i][2];

      for op in 1 .. 4 loop
        continue when op = 3 and fx[i][6] <> 'y';

        expect_ok := case op
                       when 1 then true
                       when 2 then fx[i][7] = 'y'
                       when 3 then true
                       else        fx[i][8] = 'y'
                     end;
        okv     := false;
        observe := null;

        begin
          execute as_actor;
          execute 'set role authenticated';

          case op
            when 1 then
              execute format('select count(*) from public.%I where %I = %L', tbl, own, actor) into cnt;
              observe := cnt::text || ' ligne(s) lue(s)';
              okv     := (cnt > 0);
            when 2 then
              execute format('update public.%I set %I = %I where %I = %L', tbl, own, own, own, actor);
              get diagnostics cnt = row_count;
              observe := cnt::text || ' ligne(s) modifiée(s)';
              okv     := ((cnt > 0) = expect_ok);
            when 3 then
              -- On insère avec le jeu de valeurs de l'AUTRE compte pour ne pas
              -- heurter la contrainte d'unicité de la ligne déjà présente.
              vals := case when d = 1 then fx[i][5] else fx[i][4] end;
              vals := replace(replace(vals, '{SA}', quote_literal(sa)), '{SB}', quote_literal(sb));
              if fx[i][3] = '' then
                stmt := format('insert into public.%I (%I) values (%L)', tbl, own, actor);
              else
                stmt := format('insert into public.%I (%I, %s) values (%L, %s)',
                               tbl, own, fx[i][3], actor, vals);
              end if;
              execute stmt;
              observe := 'insertion acceptée';
              okv     := expect_ok;
            else
              execute format('delete from public.%I where %I = %L', tbl, own, actor);
              get diagnostics cnt = row_count;
              observe := cnt::text || ' ligne(s) supprimée(s)';
              okv     := ((cnt > 0) = expect_ok);
          end case;
        exception when others then
          observe := 'refusé (' || sqlstate || ')';
          okv     := not expect_ok;
        end;

        k        := k + 1;
        n        := k;
        phase    := dir;
        cible    := tbl;
        controle := case op
                      when 1 then 'SELECT de ses propres lignes'
                      when 2 then 'UPDATE de ses propres lignes'
                      when 3 then 'INSERT d''une ligne à son nom'
                      else        'DELETE de ses propres lignes'
                    end;
        attendu  := case
                      when op = 1 then 'au moins 1 ligne'
                      when op = 2 then case when expect_ok then 'au moins 1 ligne modifiée'
                                            else 'refus (aucune policy UPDATE : voulu)' end
                      when op = 3 then 'acceptée'
                      else             case when expect_ok then 'au moins 1 ligne supprimée'
                                            else 'refus (aucune policy DELETE : voulu)' end
                    end;
        statut   := case when okv then 'PASS' else 'FAIL' end;
        if not okv then nb_fail := nb_fail + 1; end if;
        return next;
      end loop;
    end loop;
  end loop;

  -- ==========================================================================
  -- 3. RÔLE anon — un visiteur non connecté ne voit rien
  -- ==========================================================================
  for i in 1 .. array_length(fx, 1) loop
    tbl     := fx[i][1];
    okv     := false;
    observe := null;
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', '', false);
      perform set_config('request.jwt.claims',    '', false);
      execute 'set role anon';
      execute format('select count(*) from public.%I', tbl) into cnt;
      observe := cnt::text || ' ligne(s) lue(s)';
      okv     := (cnt = 0);
    exception when others then
      observe := 'refusé (' || sqlstate || ')';
      okv     := true;
    end;

    k        := k + 1;
    n        := k;
    phase    := '5. anon';
    cible    := tbl;
    controle := 'SELECT sans être connecté';
    attendu  := '0 ligne, ou refus';
    statut   := case when okv then 'PASS' else 'FAIL' end;
    if not okv then nb_fail := nb_fail + 1; end if;
    return next;
  end loop;

  -- ==========================================================================
  -- 4. SECRETS BRIGHTSPACE — les colonnes de tokens sont hors de portée
  -- ==========================================================================
  as_actor := format(
    'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
    ua::text, jsonb_build_object('sub', ua::text, 'role', 'authenticated')::text);

  for op in 1 .. 4 loop
    okv     := false;
    observe := null;
    begin
      execute 'reset role';
      if op = 3 then
        perform set_config('request.jwt.claim.sub', '', false);
        perform set_config('request.jwt.claims',    '', false);
        execute 'set role anon';
      else
        execute as_actor;
        execute 'set role authenticated';
      end if;

      case op
        when 1 then
          execute 'select count(access_token_enc) from public.brightspace_connections' into cnt;
          observe := 'LECTURE ACCEPTÉE'; okv := false;
        when 2 then
          execute 'select count(refresh_token_enc) from public.brightspace_connections' into cnt;
          observe := 'LECTURE ACCEPTÉE'; okv := false;
        when 3 then
          execute 'select count(access_token_enc) from public.brightspace_connections' into cnt;
          observe := 'LECTURE ACCEPTÉE'; okv := false;
        else
          execute format(
            'select count(*) from public.brightspace_connections where user_id = %L', ua) into cnt;
          observe := cnt::text || ' ligne(s) lue(s)';
          okv     := (cnt = 1);
      end case;
    exception when others then
      observe := 'refusé (' || sqlstate || ')';
      okv     := (op <> 4);
    end;

    k        := k + 1;
    n        := k;
    phase    := '6. secrets';
    cible    := 'brightspace_connections';
    controle := case op
                  when 1 then 'authenticated lit access_token_enc'
                  when 2 then 'authenticated lit refresh_token_enc'
                  when 3 then 'anon lit access_token_enc'
                  else        'authenticated lit SES colonnes autorisées'
                end;
    attendu  := case when op = 4 then '1 ligne' else 'refus' end;
    statut   := case when okv then 'PASS' else 'FAIL' end;
    if not okv then nb_fail := nb_fail + 1; end if;
    return next;
  end loop;

  -- Vérification structurelle : le privilège lui-même ne doit pas exister.
  execute 'reset role';
  select count(*) into cnt
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name   = 'brightspace_connections'
     and grantee      in ('anon', 'authenticated')
     and column_name  in ('access_token_enc', 'refresh_token_enc');

  k        := k + 1;
  n        := k;
  phase    := '6. secrets';
  cible    := 'brightspace_connections';
  controle := 'aucun privilège accordé sur les colonnes de tokens';
  attendu  := '0 privilège';
  observe  := cnt::text || ' privilège(s) accordé(s) à anon/authenticated';
  okv      := (cnt = 0);
  statut   := case when okv then 'PASS' else 'FAIL' end;
  if not okv then nb_fail := nb_fail + 1; end if;
  return next;

  -- ==========================================================================
  -- 4 bis. oauth_states — hermétique au navigateur
  -- ==========================================================================
  -- Cette table porte les nonces du flux OAuth. Elle n'a AUCUNE policy et
  -- AUCUN privilège pour les rôles exposés au navigateur : seules les Edge
  -- Functions y accèdent, via service_role. On le vérifie au lieu de le
  -- supposer.
  for op in 1 .. 3 loop
    okv := false; observe := null;
    begin
      execute 'reset role';
      if op = 3 then
        perform set_config('request.jwt.claim.sub', '', false);
        perform set_config('request.jwt.claims',    '', false);
        execute 'set role anon';
      else
        execute format(
          'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
          ua::text, jsonb_build_object('sub', ua::text, 'role', 'authenticated')::text);
        execute 'set role authenticated';
      end if;

      if op = 2 then
        execute format(
          'insert into public.oauth_states (id, user_id, expires_at) values (''forge'', %L, now() + interval ''1 hour'')', ua);
        observe := 'ÉCRITURE ACCEPTÉE';
      else
        execute 'select count(*) from public.oauth_states' into cnt;
        observe := cnt::text || ' ligne(s) lue(s)';
        okv := (cnt = 0);
      end if;
    exception when others then
      observe := 'refusé (' || sqlstate || ')'; okv := true;
    end;

    k := k + 1; n := k;
    phase    := '5. anon';
    cible    := 'oauth_states';
    controle := case op
                  when 1 then 'authenticated lit les nonces OAuth'
                  when 2 then 'authenticated forge un nonce OAuth'
                  else        'anon lit les nonces OAuth'
                end;
    attendu  := 'refus, ou 0 ligne';
    statut   := case when okv then 'PASS' else 'FAIL' end;
    if not okv then nb_fail := nb_fail + 1; end if;
    return next;
  end loop;

  -- ==========================================================================
  -- 5. INTÉGRITÉ — une ligne rattachée à la matière d'un autre compte
  -- ==========================================================================
  -- Avant la migration 002, les policies d'écriture ne contrôlaient que
  -- `user_id` : A pouvait créer un chapitre à SON nom rattaché au `subject_id`
  -- de B. Aucune donnée de B n'était exposée, mais la ligne était incohérente.
  -- La migration 002 (§6 bis) ajoute la condition « la matière visée est la
  -- mienne » — ces quatre vérifications le prouvent.
  -- Les matières de départ ont été supprimées par la phase 2 (contrôle positif
  -- « DELETE de ses propres lignes ») : on en recrée une pour chaque compte.
  execute 'reset role';
  insert into public.subjects (user_id, name) values (ua, 'RLS matière A3') returning id into sa;
  insert into public.subjects (user_id, name) values (ub, 'RLS matière B3') returning id into sb;

  as_actor := format(
    'select set_config(''request.jwt.claim.sub'', %L, false), set_config(''request.jwt.claims'', %L, false)',
    ua::text, jsonb_build_object('sub', ua::text, 'role', 'authenticated')::text);

  for op in 1 .. 4 loop
    -- op impair : matière de A (doit passer) ; op pair : matière de B (doit être refusé)
    expect_ok := (op % 2 = 1);
    okv       := false;
    observe   := null;
    begin
      execute 'reset role';
      execute as_actor;
      execute 'set role authenticated';
      if op <= 2 then
        execute format(
          'insert into public.chapters (user_id, subject_id, title) values (%L, %L, %L)',
          ua, case when expect_ok then sa else sb end, 'Chapitre intégrité ' || op);
      else
        execute format(
          'insert into public.documents (user_id, subject_id, name) values (%L, %L, %L)',
          ua, case when expect_ok then sa else sb end, 'doc-intégrité-' || op || '.pdf');
      end if;
      observe := 'insertion acceptée';
      okv     := expect_ok;
    exception when others then
      observe := 'refusé (' || sqlstate || ')';
      okv     := not expect_ok;
    end;

    k        := k + 1;
    n        := k;
    phase    := '7. intégrité';
    cible    := case when op <= 2 then 'chapters' else 'documents' end;
    controle := case op
                  when 1 then 'A crée un chapitre dans SA matière'
                  when 2 then 'A crée un chapitre dans la matière de B'
                  when 3 then 'A crée un document dans SA matière'
                  else        'A crée un document dans la matière de B'
                end;
    attendu  := case when expect_ok then 'accepté' else 'refus' end;
    statut   := case when okv then 'PASS' else 'FAIL' end;
    if not okv then nb_fail := nb_fail + 1; end if;
    return next;
  end loop;

  -- ==========================================================================
  -- 6. NETTOYAGE + RÉSUMÉ
  -- ==========================================================================
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims',    '', false);
  delete from auth.users where id in (ua, ub);

  k        := k + 1;
  n        := k;
  phase    := 'RÉSUMÉ';
  cible    := '';
  controle := (k - 1)::text || ' vérifications exécutées';
  attendu  := '0 FAIL';
  observe  := nb_fail::text || ' FAIL';
  statut   := case when nb_fail = 0 then 'PASS' else 'FAIL' end;
  return next;

  return;

exception when others then
  -- Nettoyage systématique, même si le harnais lui-même casse.
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims',    '', false);
  delete from auth.users where id in (ua, ub);
  raise;
end;
$fn$;

select * from pg_temp.rls_test_run();
