-- ============================================================================
-- REV-EM — migration 002 : centralisation des données utilisateur
-- ============================================================================
-- À exécuter APRÈS schema.sql et 001_brightspace.sql.
-- Idempotente : relançable sans risque. AUCUNE suppression, AUCUN drop de
-- table, AUCUNE colonne retirée, AUCUNE donnée existante modifiée.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- ----------------------------------------------------------------------------
-- CE QUI EST RÉUTILISÉ (aucune table créée en double)
-- ----------------------------------------------------------------------------
--   profils ................. profiles              (existant)
--   matières ................ subjects              (existant + provenance 001)
--   chapitres / cours ....... chapters              (existant + provenance 001)
--   fiches .................. chapters.content      (existant)
--   quiz .................... chapters.ai_quiz      (existant)
--   questions de révision ... chapters.ai_review_questions (existant)
--   flashcards .............. chapters.ai_flashcards + ai_cards (existant)
--   ressources .............. chapters.resources (001) + documents (existant)
--   progression ............. progress              (existant)
--   maîtrise par question ... question_stats        (existant)
--   examens ................. exam_history          (existant)
--   réussites ............... badges                (existant)
--   notes de cours .......... course_notes          (existant)
--   emploi du temps ......... planning_events       (existant)
--   historique IA ........... ai_history            (existant)
--   préférences ............. preferences           (existant)
--   sources externes ........ brightspace_connections (001)
--   synchronisations ........ sync_runs             (001)
--
-- ----------------------------------------------------------------------------
-- CE QUI MANQUAIT RÉELLEMENT (seules tables créées ici)
-- ----------------------------------------------------------------------------
-- L'audit a montré que state.dash (16 champs hétérogènes, la donnée la plus
-- lue du produit) et state.studyPlan n'avaient AUCUNE table. state.dash n'est
-- pas un objet : c'est quatre choses différentes agrégées par commodité côté
-- client. On les sépare selon leur nature réelle plutôt que de stocker un
-- gros JSON opaque impossible à interroger :
--
--   compteurs scalaires ........ user_stats      (1 ligne / utilisateur)
--   séries temporelles par jour  daily_stats     (1 ligne / utilisateur / jour)
--   journal d'activités ........ activities      (N lignes)
--   chapitres récemment ouverts  chapter_visits  (1 ligne / utilisateur / chapitre)
--   planning intelligent ....... study_plans     (1 ligne / utilisateur)
--
-- ----------------------------------------------------------------------------
-- CE QUI N'EST VOLONTAIREMENT PAS STOCKÉ : state.dash.wrongQuestions
-- ----------------------------------------------------------------------------
-- Ce dictionnaire est INTÉGRALEMENT dérivable de question_stats, qui contient
-- déjà wrong / theme / last_date par question. Le stocker serait un doublon.
--
-- Il porte de surcroît un défaut que l'audit a mis en évidence : il est indexé
-- par q.id, un INDEX POSITIONNEL dans le tableau QUESTIONS ("q.id = i",
-- index.html), alors que question_stats est indexé par q.uid, un hash stable
-- du contenu. Insérer une question au milieu du programme décale donc
-- silencieusement toutes les clés de wrongQuestions.
-- En le reconstruisant côté client à partir de question_stats (clé uid), on
-- supprime le doublon ET le défaut. Rien n'est perdu : le libellé de la
-- question est déjà retrouvable via QUESTION_BY_UID.
-- ============================================================================


-- ============================================================================
-- 1. user_stats — compteurs globaux (ex-state.dash, partie scalaire)
-- ============================================================================
-- Une seule ligne par utilisateur : la clé primaire EST l'utilisateur, comme
-- pour profiles / ai_history / preferences (convention déjà en place).
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
  if to_regclass('public.brightspace_connections') is not null then null; else manquant := '001_brightspace.sql'; end if;
  if to_regclass('public.subjects') is not null then null; else manquant := '000_schema.sql'; end if;

  if manquant is not null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — ' || manquant,
      detail  = 'Cette migration suppose que ' || manquant || ' a déjà été appliquée, '
             || 'et la base montre que ce n''est pas le cas.',
      hint    = 'Dans le SQL Editor, exécute les fichiers de supabase/migrations/ '
             || 'dans cet ordre : 000_schema.sql → 001_brightspace.sql → 002_centralisation.sql. '
             || 'Ils sont tous idempotents : relancer ceux déjà passés ne crée aucun doublon. '
             || 'Pour savoir où tu en es, exécute supabase/tests/00_diagnostic.sql.';
  end if;
end
$prereq$;


create table if not exists public.user_stats (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  total_answered      integer not null default 0 check (total_answered >= 0),
  total_correct       integer not null default 0 check (total_correct >= 0),
  time_spent_seconds  integer not null default 0 check (time_spent_seconds >= 0),
  correct_streak      integer not null default 0 check (correct_streak >= 0),
  best_correct_streak integer not null default 0 check (best_correct_streak >= 0),
  quizzes_completed   integer not null default 0 check (quizzes_completed >= 0),
  best90_achieved     boolean not null default false,
  -- petite liste plafonnée côté client (ajouts récents) : jsonb plutôt qu'une
  -- table, elle n'est jamais interrogée indépendamment.
  recent_adds         jsonb   not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create or replace trigger trg_user_stats_updated_at
  before update on public.user_stats
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 2. daily_stats — séries temporelles par jour
-- ============================================================================
-- Fusionne les TROIS dictionnaires par date de state.dash :
--   dailyStats{date:{answered,correct}} + dailyTimeSeconds{date:sec}
--   + activityDates[date]
-- L'existence d'une ligne signifie "jour actif" : activityDates n'a donc plus
-- besoin d'être stocké séparément (c'était la même information dupliquée).
create table if not exists public.daily_stats (
  user_id      uuid not null references auth.users(id) on delete cascade,
  day          date not null,
  answered     integer not null default 0 check (answered >= 0),
  correct      integer not null default 0 check (correct >= 0),
  time_seconds integer not null default 0 check (time_seconds >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists idx_daily_stats_user_day
  on public.daily_stats(user_id, day desc);

create or replace trigger trg_daily_stats_updated_at
  before update on public.daily_stats
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 3. activities — journal des sessions (ex-state.dash.recentActivity)
-- ============================================================================
-- Côté client la liste est plafonnée à 20 entrées ; côté serveur on conserve
-- l'historique complet — c'est précisément l'intérêt de la centralisation
-- (les statistiques d'évolution ne sont plus limitées aux 20 dernières).
--
-- `scope` est une clé OPAQUE ("chapter:<id>", "express", "wrong", "level:L1"…)
-- qui ne correspond pas toujours à une ligne chapters : même convention que
-- progress.scope, déjà documentée dans schema.sql. Pas de FK, volontairement.
create table if not exists public.activities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  ts         timestamptz not null,
  day        date not null,
  type       text not null,          -- quiz | exam | flash | oral | ai …
  scope      text,
  label      text,
  score      integer check (score >= 0),
  total      integer check (total >= 0),
  pct        integer check (pct between 0 and 100),
  time_used  integer check (time_used >= 0),
  created_at timestamptz not null default now(),
  -- Déduplication : deux activités ne peuvent pas partager le même instant
  -- exact pour un même utilisateur. Rend la synchronisation idempotente
  -- (upsert on conflict) — même motif unique(user_id, <clé naturelle>) que
  -- progress / question_stats / badges / ai_cards / planning_events.
  unique (user_id, ts)
);

create index if not exists idx_activities_user_ts on public.activities(user_id, ts desc);
create index if not exists idx_activities_user_day on public.activities(user_id, day desc);


-- ============================================================================
-- 4. chapter_visits — chapitres récemment ouverts
-- ============================================================================
-- Distinct de `activities` : ouvrir une fiche n'est pas terminer une session
-- (trackChapterVisit ≠ logActivity côté client). Plafonné à 8 localement,
-- conservé intégralement ici.
--
-- chapter_key est du TEXTE, pas une FK : un chapitre peut être intégré au
-- programme ("ch1"…, en dur dans index.html, jamais en base) ou utilisateur
-- (ligne chapters). Une FK casserait sur les chapitres intégrés.
create table if not exists public.chapter_visits (
  user_id     uuid not null references auth.users(id) on delete cascade,
  chapter_key text not null,
  kind        text,                  -- quiz | fiche | flash …
  visited_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, chapter_key)
);

create index if not exists idx_chapter_visits_user_time
  on public.chapter_visits(user_id, visited_at desc);

create or replace trigger trg_chapter_visits_updated_at
  before update on public.chapter_visits
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 5. study_plans — planning intelligent (ex-state.studyPlan)
-- ============================================================================
-- Une seule ligne par utilisateur : l'application ne manipule qu'un plan à la
-- fois (state.studyPlan est un objet, pas une liste).
--
-- `days` reste du jsonb (tableau de jours, chacun portant ses tâches) : le
-- plan est toujours lu en entier, jamais tâche par tâche. Éclater en
-- study_plan_days / study_plan_tasks ajouterait deux jointures sans bénéfice —
-- même arbitrage que celui déjà documenté sur la table chapters.
create table if not exists public.study_plans (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  plan_id            text,               -- id généré côté client (genLibId)
  goal               text,
  deadline_at        timestamptz,
  deadline_label     text,
  deadline_event_id  text,               -- événement .ics d'origine, si lié
  subject_ids        jsonb not null default '[]'::jsonb,
  chapter_ids        jsonb not null default '[]'::jsonb,
  availability       jsonb not null default '{}'::jsonb,
  days               jsonb not null default '[]'::jsonb,
  last_checked_missed_at text,
  last_replan_message    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create or replace trigger trg_study_plans_updated_at
  before update on public.study_plans
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 6. RLS — isolation stricte par utilisateur
-- ============================================================================
-- Même boucle générique que schema.sql : chaque table reçoit ses quatre
-- policies select/insert/update/delete restreintes à auth.uid() = user_id.
-- Empêche structurellement : utilisateur A → données B, et B → A.
alter table public.user_stats     enable row level security;
alter table public.daily_stats    enable row level security;
alter table public.activities     enable row level security;
alter table public.chapter_visits enable row level security;
alter table public.study_plans    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['user_stats','daily_stats','activities','chapter_visits','study_plans']
  loop
    execute format('drop policy if exists "%1$s_select_own" on public.%1$s;', t);
    execute format('create policy "%1$s_select_own" on public.%1$s for select using (auth.uid() = user_id);', t);

    execute format('drop policy if exists "%1$s_insert_own" on public.%1$s;', t);
    execute format('create policy "%1$s_insert_own" on public.%1$s for insert with check (auth.uid() = user_id);', t);

    execute format('drop policy if exists "%1$s_update_own" on public.%1$s;', t);
    execute format('create policy "%1$s_update_own" on public.%1$s for update using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);

    execute format('drop policy if exists "%1$s_delete_own" on public.%1$s;', t);
    execute format('create policy "%1$s_delete_own" on public.%1$s for delete using (auth.uid() = user_id);', t);
  end loop;
end $$;

-- Droits de base (Supabase les accorde par défaut, explicités ici pour que la
-- migration soit autoportante si elle est rejouée sur un projet neuf).
grant select, insert, update, delete on
  public.user_stats, public.daily_stats, public.activities,
  public.chapter_visits, public.study_plans
  to authenticated;

-- L'accès anonyme n'a aucune raison d'exister sur des données de compte.
revoke all on
  public.user_stats, public.daily_stats, public.activities,
  public.chapter_visits, public.study_plans
  from anon;


-- ============================================================================
-- 6 bis. INTÉGRITÉ RÉFÉRENTIELLE CROISÉE (chapters / documents)
-- ============================================================================
-- Constat issu des tests d'isolation (supabase/tests/rls_tests.sql) : les
-- policies d'écriture ne contrôlaient que `user_id`. Un client pouvait donc
-- créer un chapitre à SON nom en le rattachant au `subject_id` d'un AUTRE
-- compte — à condition d'en deviner l'UUID.
--
-- Ce n'était pas une fuite de données : l'auteur ne peut toujours pas lire la
-- matière visée, et le propriétaire de la matière ne voit jamais ce chapitre
-- (RLS filtre sur `user_id`). Mais cela crée une ligne incohérente, et la
-- suppression de la matière par son propriétaire ferait disparaître en cascade
-- un chapitre d'autrui. On ferme donc la porte.
--
-- Le reste des policies est inchangé : mêmes noms, même clause `user_id`, on
-- ajoute seulement la condition « la matière visée est la mienne ».
-- `subject_id is null` reste accepté pour documents (colonne facultative).
drop policy if exists "chapters_insert_own" on public.chapters;
create policy "chapters_insert_own" on public.chapters
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.subjects s
                 where s.id = subject_id and s.user_id = auth.uid())
  );

drop policy if exists "chapters_update_own" on public.chapters;
create policy "chapters_update_own" on public.chapters
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.subjects s
                 where s.id = subject_id and s.user_id = auth.uid())
  );

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own" on public.documents
  for insert with check (
    auth.uid() = user_id
    and (subject_id is null
         or exists (select 1 from public.subjects s
                     where s.id = subject_id and s.user_id = auth.uid()))
  );

drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (subject_id is null
         or exists (select 1 from public.subjects s
                     where s.id = subject_id and s.user_id = auth.uid()))
  );


-- ============================================================================
-- 7. VÉRIFICATION POST-MIGRATION
-- ============================================================================
-- (a) les 5 tables existent et ont RLS actif → doit renvoyer 5 lignes, toutes
--     avec rowsecurity = true :
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname='public'
--      and tablename in ('user_stats','daily_stats','activities',
--                        'chapter_visits','study_plans');
--
-- (b) 4 policies par table → doit renvoyer 20 :
--
--   select count(*) from pg_policies
--    where schemaname='public'
--      and tablename in ('user_stats','daily_stats','activities',
--                        'chapter_visits','study_plans');
--
-- (c) aucune donnée existante n'a été touchée → les comptes doivent être
--     identiques à ceux d'avant la migration :
--
--   select 'subjects' t, count(*) from public.subjects
--   union all select 'chapters', count(*) from public.chapters
--   union all select 'profiles', count(*) from public.profiles;
--
-- Les tests d'isolation A/B sont dans supabase/tests/rls_tests.sql.
-- ============================================================================
