-- ============================================================================
-- 00_diagnostic.sql — « où en est ma base, et que dois-je exécuter ensuite ? »
-- ============================================================================
-- EN LECTURE SEULE. Ce fichier ne crée rien, ne modifie rien, ne supprime
-- rien. Il regarde la base et te dit, dans l'ordre, ce qui manque.
--
-- À exécuter quand :
--   • une migration refuse de s'appliquer ;
--   • tu ne sais plus lesquelles sont déjà passées ;
--   • tu veux vérifier une installation avant d'ouvrir le site.
--
-- COMMENT
--   Supabase → SQL Editor → coller tout le fichier → Run.
--   En local  : psql -d ma_base -f supabase/tests/00_diagnostic.sql
--
-- COMMENT LIRE LE RÉSULTAT
--   Deux tableaux. Le premier liste les migrations et leur état. Le second
--   donne la marche à suivre — c'est celui qu'il faut lire en premier si
--   quelque chose ne va pas.
--
-- COMMENT L'ÉTAT EST DÉDUIT
--   Par introspection du schéma : on cherche un objet que la migration est
--   la seule à créer. Aucune table de suivi n'est tenue, donc rien ne peut
--   se désynchroniser de la réalité — la base est sa propre référence.
-- ============================================================================

with attendu(rang, fichier, repere, description) as (
  values
    (0, '000_schema.sql',         'table public.subjects',
        'les 13 tables de base : profils, matières, chapitres, progression, statistiques…'),
    (1, '001_brightspace.sql',    'table public.brightspace_connections',
        'provenance des contenus importés + connexion OAuth + journal de synchronisation'),
    (2, '002_centralisation.sql', 'table public.user_stats',
        'compteurs, séries par jour, journal d''activités, chapitres ouverts, plan de révision'),
    (3, '003_sync_layer.sql',     'colonne subjects.source_updated_at',
        'index d''import non partiels, exigés par l''écriture idempotente'),
    (4, '004_oauth_hardening.sql','table public.oauth_states',
        'états OAuth à usage unique, verrous de rafraîchissement'),
    (5, '005_user_sync.sql',      'index uq_subjects_user_local',
        'les clés naturelles du multi-appareils — sans elles, la synchronisation ne peut pas être idempotente')
),
etat as (
  select a.*,
         case a.rang
           when 0 then to_regclass('public.subjects') is not null
           when 1 then to_regclass('public.brightspace_connections') is not null
           when 2 then to_regclass('public.user_stats') is not null
           when 3 then exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'subjects'
                                  and column_name = 'source_updated_at')
           when 4 then to_regclass('public.oauth_states') is not null
           when 5 then exists (select 1 from pg_indexes
                                where schemaname = 'public' and indexname = 'uq_subjects_user_local')
         end as applique
    from attendu a
)
select rang                                        as "n",
       fichier                                     as "migration",
       case when applique then 'APPLIQUÉE' else '— MANQUANTE —' end as "état",
       repere                                      as "repère cherché",
       description                                 as "ce qu'elle apporte"
  from etat
 order by rang;

-- ----------------------------------------------------------------------------
-- La marche à suivre
-- ----------------------------------------------------------------------------
with attendu(rang, fichier) as (
  values (0, '000_schema.sql'), (1, '001_brightspace.sql'), (2, '002_centralisation.sql'),
         (3, '003_sync_layer.sql'), (4, '004_oauth_hardening.sql'), (5, '005_user_sync.sql')
),
etat as (
  select a.rang, a.fichier,
         case a.rang
           when 0 then to_regclass('public.subjects') is not null
           when 1 then to_regclass('public.brightspace_connections') is not null
           when 2 then to_regclass('public.user_stats') is not null
           when 3 then exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'subjects'
                                  and column_name = 'source_updated_at')
           when 4 then to_regclass('public.oauth_states') is not null
           when 5 then exists (select 1 from pg_indexes
                                where schemaname = 'public' and indexname = 'uq_subjects_user_local')
         end as applique
    from attendu a
),
manquantes as (select * from etat where not applique order by rang),
compte as (select count(*) as n from manquantes),
-- Une colonne de la v1 qui sera SUPPRIMÉE par 000_schema.sql : on prévient
-- avant, plutôt que de le découvrir après.
v1 as (
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'user_code') as a_user_code
)
select
  case when (select n from compte) = 0
       then 'Rien à faire : les 6 migrations sont appliquées.'
       else 'À exécuter dans le SQL Editor, dans cet ordre : '
            || (select string_agg('supabase/migrations/' || fichier, '  puis  ' order by rang)
                  from manquantes)
  end as "marche à suivre",
  case when (select n from compte) = 0
       then 'Vérifie avec user_sync_tests.sql, rls_tests.sql et sync_idempotency_tests.sql (0 FAIL attendu sur chacun).'
       else 'Tous les fichiers sont idempotents : relancer ceux déjà passés ne crée aucun doublon. '
            || 'En cas de doute, relance simplement toute la série depuis 000.'
  end as "ensuite",
  case when (select a_user_code from v1)
       then 'ATTENTION : ta table profiles contient encore la colonne user_code (v1). '
            || '000_schema.sql la SUPPRIME, avec son contenu. Sauvegarde-la avant si elle te sert.'
       else 'Aucun point d''attention sur profiles.'
  end as "avertissement";
