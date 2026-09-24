-- ============================================================================
-- 00_local_emulation.sql — émulation minimale de Supabase sur un PostgreSQL nu
-- ============================================================================
-- À N'EXÉCUTER QUE sur une base de test locale. Ne jamais exécuter sur Supabase :
-- le schéma `auth`, la fonction `auth.uid()` et les rôles y existent déjà, et ce
-- fichier les écraserait par des versions simplifiées.
--
-- Objectif : pouvoir appliquer réellement `supabase/migrations/000_schema.sql` puis les
-- migrations, et exécuter `rls_tests.sql`, sans dépendre d'un projet Supabase.
--
-- Usage :
--   createdb revem_test
--   psql -d revem_test -f supabase/tests/00_local_emulation.sql
--   psql -d revem_test -f supabase/migrations/000_schema.sql          -- storage.buckets échoue : normal
--   psql -d revem_test -f supabase/migrations/001_brightspace.sql
--   psql -d revem_test -f supabase/migrations/002_centralisation.sql
--   psql -d revem_test -f supabase/tests/rls_tests.sql
-- ============================================================================

create extension if not exists pgcrypto;

create schema if not exists auth;

-- Version réduite de auth.users : seules les colonnes utilisées par le projet.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- Définition identique à celle de Supabase (coalesce des deux emplacements du
-- claim `sub`), pour que les tests se comportent pareil ici et en production.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims',    true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

-- Rôles Supabase. service_role contourne RLS, comme en production.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Chez Supabase, service_role peut lire auth.users (c'est ce dont se sert
-- `auth.getUser()` côté serveur). On reproduit ce privilège, sinon les Edge
-- Functions échoueraient ici pour une raison qui n'existe pas en production.
grant usage on schema auth to service_role;
grant select on auth.users to service_role;

-- Supabase accorde par défaut tous les privilèges de table à ces trois rôles
-- dans `public` : on reproduit ce comportement, sinon les tests de privilèges
-- de colonnes (brightspace_connections) ne testeraient rien de réaliste.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
