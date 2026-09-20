-- ============================================================================
-- Lyon Révision — schéma Supabase (PostgreSQL + Auth + Row Level Security)
-- ============================================================================
-- À exécuter dans l'éditeur SQL de ton projet Supabase (Dashboard → SQL Editor),
-- une seule fois, sur un projet neuf. Idempotent grâce aux "if not exists" /
-- "or replace" : tu peux le relancer sans casser un projet déjà initialisé.
--
-- Ce schéma correspond exactement aux structures de données déjà utilisées
-- par l'application (voir AUDIT dans SETUP_SUPABASE.md) : rien n'est inventé,
-- chaque table reflète une clé localStorage existante dans index.html.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. Ce fichier est du SQL pur, sûr à committer.
-- ============================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Fonction utilitaire : maintient automatiquement updated_at à jour.
-- Réutilisée par toutes les tables ci-dessous via un trigger BEFORE UPDATE.
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- profiles — un compte = une ligne. id = auth.uid() directement (pas de
-- colonne user_id séparée ici : la clé primaire EST l'identifiant utilisateur).
--
-- display_name sert de "pseudo" (déjà demandé et enregistré depuis le
-- formulaire d'inscription) : on ne duplique pas cette notion dans une
-- colonne "username" séparée, réutilisée telle quelle par "Mes informations".
--
-- v2 (profil enrichi) : ajout de first_name/last_name/phone/avatar_url.
-- Suppression de user_code (v1) : ce code n'était affiché que dans "Mon
-- espace" et n'était utilisé par AUCUNE autre fonctionnalité (pas de
-- connexion par code, pas de partage, pas de sync par code) — retiré à la
-- demande explicite du 20/09, avec sa fonction de génération dédiée.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,   -- pseudo affiché dans l'application
  first_name       text,
  last_name        text,
  phone            text,   -- information de profil, PAS un identifiant de connexion/2FA
  avatar_url       text,   -- chemin dans le bucket Storage "avatars" (pas une URL publique : bucket privé, signée à la demande)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_synced_at   timestamptz
);

-- Additifs idempotents pour un projet où "profiles" existait déjà (v1) :
-- CREATE TABLE IF NOT EXISTS ci-dessus n'ajoute pas de colonne à une table
-- existante, d'où ces ALTER explicites.
alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name  text;
alter table public.profiles add column if not exists phone      text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles drop column if exists user_code;

create or replace trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Crée automatiquement le profil dès qu'un compte Supabase Auth est créé —
-- SECURITY DEFINER car le client n'a pas le droit d'insérer directement dans
-- profiles pour un autre id que le sien, et au moment de l'inscription la
-- session n'est pas encore pleinement établie.
-- Redéfinie AVANT de supprimer generate_user_code() ci-dessous : elle ne doit
-- plus l'appeler au moment où la fonction disparaît.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- v1 seulement — supprimé en v2 (voir commentaire sur la table profiles).
-- handle_new_user() vient d'être redéfinie ci-dessus pour ne plus l'appeler.
drop function if exists public.generate_user_code();

-- ----------------------------------------------------------------------------
-- subjects — state.userSubjects (matières créées/importées par l'élève).
-- Les matières "intégrées" au site (SUBJECTS, en dur dans index.html) ne
-- sont jamais stockées ici : seulement celles créées par l'utilisateur.
-- ----------------------------------------------------------------------------
create table if not exists public.subjects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  local_id      text,                 -- id généré côté client avant migration (genLibId), pour le rapprochement
  name          text not null,
  icon          text,
  color         text,
  semester_id   text,                 -- référence l'id statique d'un semestre (SEMESTERS côté client), pas une FK
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_subjects_user_id on public.subjects(user_id);
create or replace trigger trg_subjects_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- chapters — state.userChapters. Regroupe volontairement fiche/résumé/quiz IA/
-- flashcards IA/questions IA dans la même ligne : c'est déjà comme ça que
-- l'application les manipule (un seul objet chapitre, jamais interrogé par
-- "toutes les questions de tous les chapitres" séparément). Les éclater en
-- tables séparées ajouterait des jointures sans bénéfice réel.
-- Le PDF original n'est JAMAIS stocké ici (reste en IndexedDB, local à
-- l'appareil) — has_original_file n'est qu'un indicateur.
-- ----------------------------------------------------------------------------
create table if not exists public.chapters (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  local_id              text,
  num                   text,
  title                 text not null,
  description           text,          -- correspond à ch.desc ("desc" est un mot réservé SQL)
  content               text,          -- fiche : JSON structuré (nouveau format) ou texte/Markdown (ancien format), tel quel
  original_text         text,          -- texte source extrait, tronqué côté client (~20000 caractères)
  summary               text,
  ai_quiz               jsonb not null default '[]'::jsonb,
  ai_flashcards         jsonb not null default '[]'::jsonb,
  ai_review_questions   jsonb not null default '[]'::jsonb,
  key_notions           jsonb not null default '[]'::jsonb,
  source_file_name      text,
  page_count            integer,
  has_original_file     boolean not null default false,
  level                 text,          -- identifiant interne L1/L2/L3 éventuel (jamais affiché tel quel côté client)
  marked_reviewed       boolean not null default false,
  generation_pending    boolean not null default false,
  heuristic_mode        boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_chapters_user_id on public.chapters(user_id);
create index if not exists idx_chapters_subject_id on public.chapters(subject_id);
create or replace trigger trg_chapters_updated_at
  before update on public.chapters
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- progress — state.progress (quiz) + state.flashProgress (flashcards), fusionnés
-- avec une colonne "kind" : même forme de donnée ({best, attempts}), même clé
-- opaque "scope" côté client (ex. "chapter:<id>", "level:L1", un thème…) qui
-- ne correspond pas toujours à une ligne "chapters" (le programme intégré
-- n'a pas de ligne propre) — d'où l'absence de FK stricte sur scope.
-- ----------------------------------------------------------------------------
create table if not exists public.progress (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('quiz', 'flashcard')),
  scope         text not null,
  best          integer not null default 0,
  attempts      integer not null default 0,
  updated_at    timestamptz not null default now(),
  unique (user_id, kind, scope)
);
create index if not exists idx_progress_user_id on public.progress(user_id);
create or replace trigger trg_progress_updated_at
  before update on public.progress
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- question_stats — state.qstats, suivi fin par question (uid). Conservé en
-- JSONB (seen/correct/wrong/streak/last/lastDate/history/theme) : petit sac
-- de données déjà géré comme un tout côté client, jamais interrogé champ par
-- champ côté serveur.
-- ----------------------------------------------------------------------------
create table if not exists public.question_stats (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  question_uid   text not null,
  data           jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  unique (user_id, question_uid)
);
create index if not exists idx_question_stats_user_id on public.question_stats(user_id);
create or replace trigger trg_question_stats_updated_at
  before update on public.question_stats
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- exam_history — state.exam.history (déjà limité à 20 entrées côté client).
-- ----------------------------------------------------------------------------
create table if not exists public.exam_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  data          jsonb not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_exam_history_user_id on public.exam_history(user_id);

-- ----------------------------------------------------------------------------
-- badges — state.badges ({ badgeId: {earnedDate} } côté client, éclaté ici
-- en une ligne par badge débloqué pour permettre une contrainte d'unicité
-- propre et éviter les doublons.
-- ----------------------------------------------------------------------------
create table if not exists public.badges (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  badge_id      text not null,
  earned_date   timestamptz not null,
  unique (user_id, badge_id)
);
create index if not exists idx_badges_user_id on public.badges(user_id);

-- ----------------------------------------------------------------------------
-- ai_cards — state.aiCards : flashcards générées par l'IA sur les chapitres
-- INTÉGRÉS (programme du site), distinct de chapters.ai_flashcards qui, lui,
-- concerne les chapitres créés par l'utilisateur. builtin_chapter_id référence
-- un id statique (ex. "ch1") côté client, pas une ligne de la table chapters.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_cards (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  builtin_chapter_id    text not null,
  cards                 jsonb not null default '[]'::jsonb,
  updated_at            timestamptz not null default now(),
  unique (user_id, builtin_chapter_id)
);
create index if not exists idx_ai_cards_user_id on public.ai_cards(user_id);
create or replace trigger trg_ai_cards_updated_at
  before update on public.ai_cards
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- course_notes — state.courseData, notes/résumé/questions/checklist par
-- événement de planning (event_id = id de l'événement, pas une FK puisque
-- les événements proviennent souvent d'un flux ICS externe).
-- ----------------------------------------------------------------------------
create table if not exists public.course_notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  event_id      text not null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  unique (user_id, event_id)
);
create index if not exists idx_course_notes_user_id on public.course_notes(user_id);
create or replace trigger trg_course_notes_updated_at
  before update on public.course_notes
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- planning_events — state.planning.events (synchronisés à la demande explicite
-- du 19/09 : les événements peuvent être annotés/modifiés localement, pas
-- seulement importés passivement depuis l'URL ICS).
-- ----------------------------------------------------------------------------
create table if not exists public.planning_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  local_id      text,
  data          jsonb not null,
  updated_at    timestamptz not null default now()
);
create index if not exists idx_planning_events_user_id on public.planning_events(user_id);
create or replace trigger trg_planning_events_updated_at
  before update on public.planning_events
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- ai_history — state.aiHistory (déjà limité à 20 entrées côté client). Une
-- seule ligne par utilisateur (comme preferences ci-dessous) : c'est un
-- historique court, pas une collection qui grossit sans limite.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_history (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  history       jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);
create or replace trigger trg_ai_history_updated_at
  before update on public.ai_history
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- preferences — une ligne par utilisateur : position du bouton IA, choix de
-- modèle WebLLM, URL du flux ICS. Regroupées ici plutôt que dans "profiles"
-- pour séparer identité de compte (profiles) et réglages (preferences).
-- ----------------------------------------------------------------------------
create table if not exists public.preferences (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  ai_bubble_side          text check (ai_bubble_side in ('left', 'right')),
  ai_bubble_y             numeric,
  ai_model_choice         text check (ai_model_choice in ('auto', 'small', 'large')),
  planning_official_url   text,
  updated_at              timestamptz not null default now()
);
create or replace trigger trg_preferences_updated_at
  before update on public.preferences
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- documents — state.documents, MÉTADONNÉES SEULEMENT (décision du 19/09) :
-- le contenu binaire (dataUrl/content, jusqu'à ~3 Mo par fichier) reste
-- strictement local à l'appareil. has_local_content indique que le fichier
-- lui-même n'existe que côté client — pas de colonne pour son contenu.
-- ----------------------------------------------------------------------------
create table if not exists public.documents (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  local_id              text,
  name                  text not null,
  type                  text check (type in ('document', 'resume', 'sujet')),
  mime                  text,
  subject_id            uuid references public.subjects(id) on delete set null,
  added_at              timestamptz,
  has_local_content     boolean not null default true
);
create index if not exists idx_documents_user_id on public.documents(user_id);

-- ============================================================================
-- ROW LEVEL SECURITY — partie critique : chaque table de données privées
-- n'autorise SELECT/INSERT/UPDATE/DELETE qu'à son propriétaire (auth.uid()).
-- Le frontend n'est jamais considéré comme une barrière de sécurité : tout
-- est appliqué ici, côté base.
-- ============================================================================

alter table public.profiles          enable row level security;
alter table public.subjects          enable row level security;
alter table public.chapters          enable row level security;
alter table public.progress          enable row level security;
alter table public.question_stats    enable row level security;
alter table public.exam_history      enable row level security;
alter table public.badges            enable row level security;
alter table public.ai_cards          enable row level security;
alter table public.course_notes      enable row level security;
alter table public.planning_events   enable row level security;
alter table public.ai_history        enable row level security;
alter table public.preferences       enable row level security;
alter table public.documents         enable row level security;

-- profiles : la clé primaire EST l'utilisateur (id = auth.uid()).
-- Pas d'INSERT/DELETE côté client : la ligne est créée par le trigger
-- on_auth_user_created (SECURITY DEFINER) et supprimée par la cascade
-- lors de la suppression du compte (auth.users), jamais directement par
-- l'utilisateur — voir SETUP_SUPABASE.md, section "Supprimer mon compte".
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ai_history / preferences : même logique (clé primaire = user_id = auth.uid()).
drop policy if exists "ai_history_select_own" on public.ai_history;
create policy "ai_history_select_own" on public.ai_history
  for select using (auth.uid() = user_id);
drop policy if exists "ai_history_insert_own" on public.ai_history;
create policy "ai_history_insert_own" on public.ai_history
  for insert with check (auth.uid() = user_id);
drop policy if exists "ai_history_update_own" on public.ai_history;
create policy "ai_history_update_own" on public.ai_history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "ai_history_delete_own" on public.ai_history;
create policy "ai_history_delete_own" on public.ai_history
  for delete using (auth.uid() = user_id);

drop policy if exists "preferences_select_own" on public.preferences;
create policy "preferences_select_own" on public.preferences
  for select using (auth.uid() = user_id);
drop policy if exists "preferences_insert_own" on public.preferences;
create policy "preferences_insert_own" on public.preferences
  for insert with check (auth.uid() = user_id);
drop policy if exists "preferences_update_own" on public.preferences;
create policy "preferences_update_own" on public.preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "preferences_delete_own" on public.preferences;
create policy "preferences_delete_own" on public.preferences
  for delete using (auth.uid() = user_id);

-- Toutes les tables restantes partagent exactement la même forme de policy
-- (auth.uid() = user_id) : générée par une boucle pour éviter de répéter
-- 40 fois le même bloc, plutôt que d'écrire chaque policy à la main.
-- "drop policy if exists" avant chaque "create policy" rend le script
-- rejouable sans erreur sur un projet déjà initialisé (CREATE POLICY n'a
-- pas d'équivalent IF NOT EXISTS / OR REPLACE en PostgreSQL).
do $$
declare
  t text;
begin
  foreach t in array array[
    'subjects', 'chapters', 'progress', 'question_stats', 'exam_history',
    'badges', 'ai_cards', 'course_notes', 'planning_events', 'documents'
  ]
  loop
    execute format('drop policy if exists "%1$s_select_own" on public.%1$s;', t);
    execute format(
      'create policy "%1$s_select_own" on public.%1$s for select using (auth.uid() = user_id);',
      t
    );
    execute format('drop policy if exists "%1$s_insert_own" on public.%1$s;', t);
    execute format(
      'create policy "%1$s_insert_own" on public.%1$s for insert with check (auth.uid() = user_id);',
      t
    );
    execute format('drop policy if exists "%1$s_update_own" on public.%1$s;', t);
    execute format(
      'create policy "%1$s_update_own" on public.%1$s for update using (auth.uid() = user_id) with check (auth.uid() = user_id);',
      t
    );
    execute format('drop policy if exists "%1$s_delete_own" on public.%1$s;', t);
    execute format(
      'create policy "%1$s_delete_own" on public.%1$s for delete using (auth.uid() = user_id);',
      t
    );
  end loop;
end $$;

-- ============================================================================
-- STORAGE — bucket "avatars" (photos de profil, v2 du 20/09).
-- Bucket PRIVÉ (public = false) : une photo de profil n'est pas publiée sur
-- le web, l'app la lit via une URL signée à durée limitée (voir auth.js,
-- resolveAvatarUrl). Chaque fichier est rangé sous "<user_id>/avatar.<ext>" —
-- le premier segment du chemin sert de propriétaire pour les policies
-- ci-dessous (storage.foldername), donc chaque utilisateur ne peut lire/
-- écrire/supprimer que dans SON PROPRE dossier, jamais celui d'un autre.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

drop policy if exists "avatars_select_own" on storage.objects;
create policy "avatars_select_own" on storage.objects
  for select using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================================================
-- Fin du schéma. Prochaine étape : SETUP_SUPABASE.md pour la configuration
-- (URL, clé publique, Auth, URLs GitHub Pages) et les tests de policies.
-- ============================================================================
