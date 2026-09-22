# ÉTAPE 2 — Architecture de données Supabase

Ce document décrit ce qui a été **réellement construit et vérifié** pour faire
de Supabase la source persistante principale des données de REV-EM, ce qui
reste à faire, et ce que tu dois exécuter toi-même.

Trois fichiers :

| Fichier | Rôle |
|---|---|
| `supabase/schema.sql` | schéma d'origine (13 tables) — **inchangé** |
| `supabase/migrations/001_brightspace.sql` | provenance + sources externes (2 tables) — **durci** (voir §4) |
| `supabase/migrations/002_centralisation.sql` | centralisation des données restantes (5 tables) — **nouveau** |
| `supabase/tests/rls_tests.sql` | 335 vérifications d'isolation A↔B — **nouveau** |
| `supabase/tests/00_local_emulation.sql` | permet de rejouer tout ça sur un PostgreSQL local — **nouveau** |

---

## 1. Principe directeur : réutiliser, ne pas dupliquer

Ta demande listait 16 familles de données à stocker proprement. L'audit
(ÉTAPE 1) a montré que **11 d'entre elles avaient déjà une table adaptée**.
Créer des tables « utilisateurs », « quiz » ou « fiches » aurait fabriqué des
doublons. Voici la correspondance réelle :

| Donnée demandée | Où elle va | Table créée ? |
|---|---|---|
| Utilisateurs / profils | `profiles` | non — existe |
| Matières | `subjects` | non — existe |
| Chapitres | `chapters` | non — existe |
| Cours / fiches | `chapters.content` | non — existe |
| Quiz | `chapters.ai_quiz` | non — existe |
| Questions | `chapters.ai_review_questions` + `question_stats` | non — existe |
| Flashcards | `chapters.ai_flashcards` + `ai_cards` | non — existe |
| Ressources | `chapters.resources` + `documents` | non — existe |
| Progression | `progress` | non — existe |
| Examens | `exam_history` | non — existe |
| Planning (agenda) | `planning_events` + `course_notes` | non — existe |
| Sources externes | `brightspace_connections` | non — créée en 001 |
| Synchronisations | `sync_runs` | non — créée en 001 |
| **Statistiques** | `user_stats`, `daily_stats` | **oui** |
| **Activités** | `activities`, `chapter_visits` | **oui** |
| **Planning intelligent** | `study_plans` | **oui** |

Pourquoi ces 5 là et pas d'autres : `state.dash` (la donnée la plus lue du
produit, 16 champs) et `state.studyPlan` étaient les **seules** structures sans
aucune table. Tout le reste avait déjà sa place.

---

## 2. Spécification des 5 tables créées

### 2.1 `user_stats` — compteurs globaux

| Colonne | Type | Contrainte |
|---|---|---|
| `user_id` | `uuid` | **PK**, FK → `auth.users(id)` `on delete cascade` |
| `total_answered` | `integer` | not null, défaut 0, `>= 0` |
| `total_correct` | `integer` | not null, défaut 0, `>= 0` |
| `time_spent_seconds` | `integer` | not null, défaut 0, `>= 0` |
| `correct_streak` | `integer` | not null, défaut 0, `>= 0` |
| `best_correct_streak` | `integer` | not null, défaut 0, `>= 0` |
| `quizzes_completed` | `integer` | not null, défaut 0, `>= 0` |
| `best90_achieved` | `boolean` | not null, défaut false |
| `recent_adds` | `jsonb` | not null, défaut `[]` |
| `created_at` / `updated_at` | `timestamptz` | not null, défaut `now()`, trigger `set_updated_at()` |

Une ligne par utilisateur — la clé primaire **est** l'utilisateur, comme
`profiles`, `ai_history` et `preferences` (convention déjà en place).
Index : la PK suffit (accès toujours par `user_id`).

### 2.2 `daily_stats` — séries temporelles

| Colonne | Type | Contrainte |
|---|---|---|
| `user_id` | `uuid` | **PK (1/2)**, FK → `auth.users(id)` cascade |
| `day` | `date` | **PK (2/2)** |
| `answered`, `correct`, `time_seconds` | `integer` | not null, défaut 0, `>= 0` |
| `created_at` / `updated_at` | `timestamptz` | trigger `set_updated_at()` |

Index : `idx_daily_stats_user_day (user_id, day desc)`.

Cette table **fusionne trois dictionnaires** qui étaient séparés côté client :
`dailyStats`, `dailyTimeSeconds` et `activityDates`. L'existence d'une ligne
signifie « jour actif » : `activityDates` était la même information dupliquée.

### 2.3 `activities` — journal des sessions

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `uuid` | **PK**, défaut `gen_random_uuid()` |
| `user_id` | `uuid` | not null, FK → `auth.users(id)` cascade |
| `ts` | `timestamptz` | not null |
| `day` | `date` | not null |
| `type` | `text` | not null (`quiz`, `exam`, `flash`, `oral`, `ai`…) |
| `scope`, `label` | `text` | nullable |
| `score`, `total`, `time_used` | `integer` | `>= 0` |
| `pct` | `integer` | `between 0 and 100` |
| — | — | **`unique (user_id, ts)`** |
| `created_at` | `timestamptz` | not null, défaut `now()` |

Index : `idx_activities_user_ts`, `idx_activities_user_day`.

`unique(user_id, ts)` rend la synchronisation **idempotente** : un `upsert …
on conflict` rejoué ne crée pas de doublon. C'est le même motif
`unique(user_id, <clé naturelle>)` que `progress`, `question_stats`, `badges`,
`ai_cards` — déjà utilisé cinq fois dans le schéma.

`scope` n'a volontairement **pas de FK** : c'est une clé opaque
(`chapter:<id>`, `express`, `wrong`, `level:L1`…) qui ne correspond pas toujours
à une ligne `chapters` — exactement comme `progress.scope`.

Côté client la liste est plafonnée à 20 entrées ; côté serveur l'historique est
complet. C'est précisément l'intérêt de la centralisation : les statistiques
d'évolution ne seront plus limitées aux 20 dernières sessions.

### 2.4 `chapter_visits` — chapitres récemment ouverts

| Colonne | Type | Contrainte |
|---|---|---|
| `user_id` | `uuid` | **PK (1/2)**, FK → `auth.users(id)` cascade |
| `chapter_key` | `text` | **PK (2/2)** |
| `kind` | `text` | nullable (`quiz`, `fiche`, `flash`…) |
| `visited_at` | `timestamptz` | not null, défaut `now()` |
| `created_at` / `updated_at` | `timestamptz` | trigger `set_updated_at()` |

Index : `idx_chapter_visits_user_time (user_id, visited_at desc)`.

`chapter_key` est du **texte, pas une FK** : un chapitre peut être intégré au
programme (`ch1`…, en dur dans `index.html`, jamais en base) ou créé par
l'utilisateur (ligne `chapters`). Une FK casserait sur les chapitres intégrés.

Table distincte d'`activities` parce que **ouvrir une fiche n'est pas terminer
une session** — côté client, `trackChapterVisit()` ≠ `logActivity()`.

### 2.5 `study_plans` — planning intelligent

| Colonne | Type | Contrainte |
|---|---|---|
| `user_id` | `uuid` | **PK**, FK → `auth.users(id)` cascade |
| `plan_id`, `goal`, `deadline_label`, `deadline_event_id` | `text` | nullable |
| `deadline_at` | `timestamptz` | nullable |
| `subject_ids`, `chapter_ids`, `days` | `jsonb` | not null, défaut `[]` |
| `availability` | `jsonb` | not null, défaut `{}` |
| `last_checked_missed_at`, `last_replan_message` | `text` | nullable |
| `created_at` / `updated_at` | `timestamptz` | trigger `set_updated_at()` |

`days` reste du `jsonb` : le plan est toujours lu en entier, jamais tâche par
tâche. L'éclater en `study_plan_days` / `study_plan_tasks` ajouterait deux
jointures sans bénéfice — même arbitrage que celui déjà documenté sur
`chapters`.

### 2.6 Ce qui n'est volontairement **pas** stocké

`state.dash.wrongQuestions` n'a pas de table, pour deux raisons :

1. Il est **intégralement dérivable** de `question_stats` (qui contient déjà
   `wrong`, `theme`, `last_date` par question) : le stocker serait un doublon.
2. Il porte un **défaut** mis en évidence par l'audit : il est indexé par
   `q.id`, un index **positionnel** dans le tableau `QUESTIONS`
   (`q.id = i;` dans `index.html`), alors que `question_stats` est indexé par
   `q.uid`, un hash stable du contenu. Insérer une question au milieu du
   programme décale silencieusement toutes les clés de `wrongQuestions`.

Le reconstruire côté client depuis `question_stats` supprime le doublon **et**
le défaut. Rien n'est perdu : le libellé est déjà retrouvable via
`QUESTION_BY_UID`.

---

## 3. RLS — un utilisateur ne peut rien faire chez un autre

Les 5 nouvelles tables reçoivent les **4 policies** `select` / `insert` /
`update` / `delete`, toutes restreintes à `auth.uid() = user_id`, via la même
boucle générique que `schema.sql`. Total sur la base : **20 tables, 75
policies, RLS actif partout**.

En plus :

- `grant select, insert, update, delete … to authenticated` (explicite, pour que
  la migration soit autoportante sur un projet neuf) ;
- `revoke all … from anon` : un visiteur non connecté n'a **aucun** privilège
  sur des données de compte.

---

## 4. Deux failles trouvées par les tests, et corrigées

Les tests n'ont pas servi qu'à confirmer ce qui marchait.

### 4.1 `anon` pouvait lire les colonnes de tokens Brightspace *(001, corrigé)*

La migration 001 faisait `revoke select … from authenticated` puis un `grant`
colonne par colonne. Mais Supabase accorde par défaut **tous** les privilèges à
`anon` **et** `authenticated` sur les tables de `public`. Résultat :

- `anon` gardait un `SELECT` sur `access_token_enc` / `refresh_token_enc` ;
- `authenticated` gardait un `INSERT`/`UPDATE` sur ces mêmes colonnes.

Aucune ligne n'était réellement lisible — les policies RLS bloquaient déjà tout
(`auth.uid()` est `null` pour `anon`). **Il n'y a donc jamais eu de fuite.**
Mais la défense en profondeur exige que le privilège lui-même n'existe pas :
un jour où une policy serait modifiée par erreur, le grant serait la seule
barrière restante.

Corrigé : `revoke all on public.brightspace_connections from anon, authenticated;`
puis `grant select (<10 colonnes sûres>) to authenticated`. Les colonnes de
tokens ne sont dans aucun grant, et `anon` n'a plus rien du tout.

### 4.2 Un chapitre pouvait être rattaché à la matière d'un autre compte *(002, corrigé)*

Les policies d'écriture de `chapters` et `documents` ne contrôlaient que
`user_id`. A pouvait donc créer un chapitre **à son nom** en le rattachant au
`subject_id` de B (en devinant l'UUID).

Ce n'était pas une fuite : A ne peut toujours pas lire la matière de B, et B ne
verrait jamais ce chapitre. Mais la ligne est incohérente, et si B supprimait sa
matière, un chapitre d'A disparaîtrait en cascade.

Corrigé dans 002 (§6 bis) : les `with check` d'`insert`/`update` exigent
désormais que la matière visée appartienne à l'appelant. `subject_id is null`
reste accepté pour `documents` (colonne facultative).

---

## 5. Tests d'isolation — ce qui a réellement été exécuté

`supabase/tests/rls_tests.sql` crée deux comptes de test, leur attache une ligne
dans chacune des 20 tables, puis vérifie :

| Phase | Contenu | Vérifications |
|---|---|---|
| 1 | A → B : SELECT / UPDATE / DELETE / INSERT sur les données de B | 80 |
| 2 | B → A : les mêmes, en sens inverse | 80 |
| 3 | A sur A : contrôles **positifs** (il agit bien sur ses données) | 73 |
| 4 | B sur B : idem | 73 |
| 5 | `anon` : SELECT sur les 20 tables | 20 |
| 6 | secrets Brightspace : tokens illisibles, colonnes sûres lisibles | 5 |
| 7 | intégrité : chapitre/document rattaché à la matière d'autrui | 4 |
| | **Total** | **335** |

Les contrôles positifs (phases 3 et 4) ne sont pas décoratifs : **sans eux, une
base qui refuserait tout à tout le monde passerait les phases 1 et 2 sans rien
protéger.** Ils vérifient aussi les refus voulus (pas de policy `DELETE` sur
`profiles` et `sync_runs`, aucune écriture cliente sur
`brightspace_connections`).

**Résultat mesuré : 335 vérifications, 0 FAIL.**

Le test est **non destructif** : les deux comptes sont créés avec des UUID
sentinelles, toutes les instructions sont filtrées sur ces deux UUID, et le
`DELETE` final des comptes fait disparaître toutes les lignes par cascade — y
compris si le harnais lui-même échoue. Vérifié : après exécution, la base
revient à 0 ligne résiduelle. Le test est rejouable à l'identique.

---

## 6. Ce que tu dois exécuter dans Supabase

Dans l'ordre. Dashboard Supabase → **SQL Editor**.

1. **`supabase/migrations/001_brightspace.sql`**
   (si tu l'as déjà appliqué avant aujourd'hui, **relance-le** : il contient
   maintenant le durcissement §4.1. Il est idempotent.)

2. **`supabase/migrations/002_centralisation.sql`**

3. **`supabase/migrations/003_sync_layer.sql`** — ajoutée à l'étape 3
   (couche de synchronisation, voir `SYNC_ARCHITECTURE.md`).

4. **`supabase/tests/rls_tests.sql`** — attends la ligne `RÉSUMÉ` : elle doit
   afficher `0 FAIL` / `PASS`.

5. **`supabase/tests/sync_idempotency_tests.sql`** — idem, `0 FAIL`.

6. Vérifications finales (facultatif, elles sont déjà dans les tests) :

```sql
-- 20 tables, toutes avec RLS
select count(*) from pg_tables where schemaname='public' and rowsecurity;   -- 20
select count(*) from pg_tables where schemaname='public';                    -- 20

-- aucun privilège sur les tokens → 0 ligne
select grantee, column_name from information_schema.column_privileges
 where table_name='brightspace_connections'
   and grantee in ('anon','authenticated')
   and column_name in ('access_token_enc','refresh_token_enc');
```

Rien d'autre n'est requis pour cette étape. Les secrets et le déploiement des
Edge Functions relèvent de `BRIGHTSPACE_SETUP.md`.

---

## 7. Ce qui reste à faire (et qui n'est pas fait)

**Les tables existent et sont protégées. Le frontend n'écrit pas encore
dedans.** Aujourd'hui, en dehors des matières/chapitres Brightspace, les
données produit restent dans `localStorage`. Supabase est **prête** à devenir la
source principale ; elle ne l'est pas encore.

L'ordre de bascule recommandé, du plus utile au moins urgent :

| Phase | Contenu | Pourquoi dans cet ordre |
|---|---|---|
| 1 | Cloisonner IndexedDB par compte | seule vraie faille d'isolation restante (les PDF importés ne sont pas cloisonnés par compte, contrairement à `localStorage`) |
| 2 | Couche de synchronisation générique (`lsGet`/`lsSet` → Supabase) | tout le reste en dépend |
| 3 | `progress` + `question_stats` | c'est ce que l'utilisateur perd aujourd'hui en changeant d'appareil |
| 4 | `user_stats` / `daily_stats` / `activities` / `chapter_visits` | rend « Ma progression » et « Mes statistiques » multi-appareils |
| 5 | Matières/chapitres manuels et PDF (via `local_id`) | réconciliation des données déjà créées localement |
| 6 | `study_plans` | dépend de 3 et 5 |
| 7 | Storage pour les binaires PDF | coût de stockage à arbitrer d'abord |

---

## 8. Statut

| Élément | Statut | Preuve |
|---|---|---|
| Réutilisation des tables existantes, zéro doublon | **PASS** | §1 — 11 familles sur 16 sans nouvelle table |
| 5 nouvelles tables (colonnes, PK, FK, contraintes, index, timestamps) | **PASS** | §2 + migration appliquée sur PostgreSQL 16.13 |
| Migration compatible avec le schéma actuel | **PASS** | `schema.sql` → `001` → `002` appliqués à la suite sans erreur sur base neuve |
| Migration idempotente | **PASS** | 002 rejouée deux fois, sortie identique, aucune erreur |
| Aucune migration destructive | **PASS** | aucun `drop table`, `drop column` ni `delete` dans 002 ; seuls des `create … if not exists` et des `create policy` |
| RLS empêchant A→B et B→A | **PASS** | 160 vérifications croisées, 0 FAIL |
| Tests RLS SELECT / INSERT / UPDATE / DELETE | **PASS** | 335 vérifications, 0 FAIL, rejouables |
| Secrets Brightspace hors de portée du frontend | **PASS** | §4.1 + 5 vérifications dédiées |
| Intégrité référentielle croisée | **PASS** | §4.2 + 4 vérifications dédiées |
| Migrations appliquées sur **ton** projet Supabase | **NOT TESTED** | nécessite ton accès — §6 |
| Supabase = source persistante principale du produit | **PARTIAL** | tables prêtes et protégées ; la bascule du frontend n'est pas faite — §7 |
| Comportement des tables sous charge réelle (volumétrie, latence) | **NOT TESTED** | aucune donnée réelle n'y transite encore |
