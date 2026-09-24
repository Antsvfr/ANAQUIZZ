# Configuration Supabase — Lyon Révision

Ce document explique comment brancher le compte utilisateur + la synchronisation
cloud de Lyon Révision sur un projet Supabase. Il est écrit pour être suivi
dans l'ordre, une seule fois, par la personne qui gère le déploiement.

**État actuel du projet à la date de ce document** : le schéma SQL
(`supabase/migrations/000_schema.sql`) et ce guide existent, mais **le code frontend
(`index.html`) n'appelle pas encore Supabase** — l'authentification et la
synchronisation sont les étapes suivantes du chantier, une fois ce schéma
validé et le projet Supabase créé. Le site continue de fonctionner
exactement comme avant (100% local) tant que ces étapes ne sont pas faites.

---

## 1. Créer le projet Supabase

1. Va sur [supabase.com](https://supabase.com), crée un compte si besoin.
2. "New project" → choisis une organisation, un nom (ex. `lyon-revision`),
   un mot de passe de base de données (généré automatiquement, à conserver
   dans un gestionnaire de mots de passe — ce n'est PAS la clé qu'on utilise
   côté frontend), et une région proche de tes utilisateurs (ex. `eu-west`).
3. Attends la fin du provisionnement (1-2 minutes).

## 2. Récupérer l'URL du projet

Dashboard Supabase → **Project Settings** (icône ⚙️) → **API**.

- Copie la valeur **"Project URL"** (ex. `https://xxxxxxxxxxxx.supabase.co`).

## 3. Récupérer la clé publique

Sur la même page (**Project Settings → API**) :

- Copie la clé **"anon" "public"** (PAS la "service_role" — voir la section
  "Variables secrètes / publiques" plus bas, c'est critique).

## 4. Configurer le frontend avec ces deux valeurs

```bash
cp supabase-config.example.js supabase-config.js
```

Ouvre `supabase-config.js` et remplace les deux placeholders par l'URL et la
clé récupérées aux étapes 2-3. Ce fichier est ignoré par git
(`.gitignore`) — voir ce fichier pour le détail de ce qui peut/ne peut pas
être exposé.

## 5. Créer les tables

> **Tout le schéma vit dans `supabase/migrations/`, et s'applique dans
> l'ordre numérique à partir de `000_schema.sql`.** Il n'y a rien à exécuter
> ailleurs. Si tu ne sais pas où tu en es, exécute d'abord
> [`supabase/tests/00_diagnostic.sql`](supabase/tests/00_diagnostic.sql) : il
> ne modifie rien et te dit exactement quels fichiers lancer, dans quel ordre.
>
> *(Historique : ce fichier s'appelait `supabase/schema.sql` et se trouvait
> hors du dossier des migrations. Comme on ne le voyait pas en parcourant
> `migrations/`, on croyait pouvoir commencer à `001` — et on tombait sur un
> `relation "public.subjects" does not exist` qui ne disait pas quoi faire.
> Il a été renommé `000_schema.sql` et déplacé ; les migrations suivantes
> vérifient désormais leurs prérequis et s'arrêtent avec un message clair.)*

Dashboard Supabase → **SQL Editor** → **New query**. Colle l'intégralité du
contenu de [`supabase/migrations/000_schema.sql`](supabase/migrations/000_schema.sql) et exécute ("Run").

Ce script est idempotent (`if not exists`, `or replace`) : tu peux le relancer
sans risque s'il y a une erreur au milieu, une fois le problème corrigé — et
**tu dois le relancer** si ton projet a été initialisé avant le 20/09 (v2
profil enrichi), même s'il tournait déjà correctement : les `alter table`
ajoutés ne touchent que ce qui manque, aucune donnée existante n'est perdue.

Il crée/met à jour :
- 13 tables (`profiles`, `subjects`, `chapters`, `progress`, `question_stats`,
  `exam_history`, `badges`, `ai_cards`, `course_notes`, `planning_events`,
  `ai_history`, `preferences`, `documents`) ;
- les index nécessaires ;
- les triggers `updated_at` automatiques ;
- **toutes les policies RLS** (voir section 6) ;
- le bucket Storage privé `avatars` (photos de profil) + ses policies.

**Changement du 20/09 (v2 — profil enrichi) :** `profiles` gagne
`first_name`, `last_name`, `phone`, `avatar_url` (`display_name` sert
toujours de pseudo, pas de colonne dupliquée). La colonne `user_code`
(`LYON-XXXXXX`) et sa fonction de génération ont été **supprimées** : ce code
n'était affiché qu'à titre indicatif dans "Mon espace" et n'était utilisé par
aucune autre fonctionnalité de l'application (pas de connexion par code, pas
de partage, pas de synchronisation par code) — il a donc été retiré plutôt
que maintenu sans usage réel.

## 6. Vérifier les policies RLS

Dashboard Supabase → **Authentication → Policies** (ou **Table Editor** →
sélectionner une table → onglet "Policies").

Pour **chaque** table listée ci-dessus, vérifie que :
- "Row Level Security" est marqué **Enabled** (le script l'active déjà,
  ceci est une vérification, pas une action) ;
- 4 policies existent (`select`, `insert`, `update`, `delete` — 2 pour
  `profiles`, qui n'autorise pas d'insert/delete côté client, voir le
  commentaire dans `schema.sql`) ;
- chaque policy utilise bien `auth.uid() = user_id` (ou `= id` pour
  `profiles`/`ai_history`/`preferences`).

**Ne passe pas à la suite tant que ce point n'est pas vérifié.** C'est la
seule chose qui empêche un utilisateur de lire/modifier les données d'un
autre. Un test concret est décrit dans la section 11.

**Bucket `avatars` (Storage) :** Dashboard Supabase → **Storage**, vérifie
qu'un bucket `avatars` existe et est marqué **Private** (pas de bouton "Make
public" activé — le script le crée déjà privé, ceci est une vérification).
Dans **Storage → Policies**, vérifie que 4 policies existent sur
`storage.objects` pour ce bucket (`avatars_select_own`, `avatars_insert_own`,
`avatars_update_own`, `avatars_delete_own`), chacune limitée au dossier
`<user_id>/…` du propriétaire — testé directement contre PostgreSQL avant
livraison (voir le rapport de cette étape), mais à revérifier ici sur ton
projet réel comme pour le reste des policies.

## 7. Configurer l'authentification (Auth)

Dashboard Supabase → **Authentication → Providers** :

- **Email** doit être activé (c'est le cas par défaut).
- Décide si tu actives ou non la confirmation d'email obligatoire
  (**Authentication → Settings → "Confirm email"**). Recommandation pour un
  usage lycée/prépa : la laisser activée (évite les faux comptes), mais
  c'est ton choix.
- **Authentication → Settings → Site URL** : renseigne l'URL finale de ton
  site GitHub Pages (voir section 8) : `https://antsvfr.github.io/REV-EM/`.
- **Authentication → Settings → Redirect URLs** : ajoute la même URL (et,
  si tu testes en local, `http://localhost:8860` ou équivalent). Nécessaire
  pour les liens envoyés par email (confirmation, mot de passe oublié) —
  sans ça, Supabase refusera de rediriger vers ton site après un clic sur
  un lien reçu par email.

## 8. Spécificités GitHub Pages

- Le site est 100% statique : Supabase est le seul "backend", accessible
  directement en JavaScript depuis le navigateur (pas de serveur
  intermédiaire, pas de CORS à configurer manuellement — l'API Supabase
  autorise déjà les requêtes cross-origin depuis n'importe quel domaine ;
  la sécurité vient de RLS, pas d'une restriction CORS).
- Vérifie l'URL exacte de ton site publié (Settings → Pages du dépôt
  GitHub) : si le dépôt s'appelle `ANAQUIZZ` et n'est pas un site
  "utilisateur/organisation", l'URL est probablement du type
  `https://antsvfr.github.io/REV-EM/` (avec le nom du dépôt dans le
  chemin) — c'est CETTE URL exacte qu'il faut renseigner dans "Site URL" et
  "Redirect URLs" à l'étape 7, sous-chemin compris.
- Aucune variable d'environnement n'est injectée au moment du build
  (GitHub Pages ne fait pas de build pour un site statique simple) : c'est
  pour ça que la configuration passe par le fichier `supabase-config.js`
  décrit en section 4, chargé comme un script normal par `index.html`.

## 9. Lancer le site

Ouvre `index.html` (en local via un petit serveur HTTP, ex.
`python3 -m http.server`, ou directement via GitHub Pages une fois déployé).
Tant que le code d'authentification n'est pas encore branché (voir l'état
en haut de ce document), le site fonctionne comme avant ; une fois branché,
tu devrais voir un bouton "Connexion" dans la navigation.

## 10. Tester la création de compte

Une fois le code d'authentification en place (étape ultérieure du chantier) :
1. Crée un compte de test avec une adresse email que tu contrôles.
2. Vérifie dans Dashboard Supabase → **Table Editor → profiles** qu'une
   ligne est apparue automatiquement, avec un `user_code` du type
   `LYON-XXXXXX`.
3. Vérifie dans **Authentication → Users** que l'utilisateur apparaît.

## 11. Tester la synchronisation ET l'isolation entre deux utilisateurs

C'est le test de sécurité le plus important du projet (voir section
"Sécurité" ci-dessous pour le détail complet). En résumé :
1. Crée deux comptes de test (A et B).
2. Connecté en A, crée une matière et un chapitre.
3. Déconnecte-toi, connecte-toi en B.
4. Vérifie que B ne voit AUCUNE donnée de A.
5. Dans **Table Editor**, avec le rôle "anon" simulé (ou via l'API REST
   directement avec le token de B), tente une lecture des lignes de A par
   leur `id` — la réponse doit être vide, jamais les données de A.

---

## Variables secrètes / publiques — ce qui peut être exposé et ce qui ne doit JAMAIS l'être

| Valeur | Où elle vit | Peut être dans le frontend ? |
|---|---|---|
| `SUPABASE_URL` | `supabase-config.js` | ✅ Oui — c'est juste une adresse d'API, pas un secret. |
| Clé **anon / public** | `supabase-config.js` | ✅ Oui — conçue pour ça. La sécurité vient de RLS, pas du secret de cette clé. |
| Mot de passe de la base de données (choisi à la création du projet) | À conserver dans un gestionnaire de mots de passe | ❌ Jamais dans le code. Ne sert qu'à une connexion Postgres directe (rare, admin). |
| Clé **service_role** | Dashboard Supabase uniquement | ❌ **JAMAIS**, nulle part dans ce dépôt, ni dans le frontend ni committée. Elle contourne totalement RLS : quiconque l'obtient a un accès complet à toutes les données de tous les utilisateurs. |
| Mots de passe des utilisateurs finaux | Gérés entièrement par Supabase Auth (hashés côté Supabase) | ❌ Jamais stockés, ni en clair ni hashés, dans localStorage ou une table personnalisée de ce projet. |

Si une fonctionnalité future a besoin d'un accès élevé (ex. suppression de
compte complète, opération d'administration), elle doit passer par une
**Supabase Edge Function** (code exécuté côté Supabase, pas dans le
navigateur) qui, elle seule, peut utiliser la clé `service_role` — cette clé
reste alors dans les secrets de la Edge Function, jamais dans le dépôt Git
ni dans `index.html`.

---

## 12. Persistance multi-appareils — ce qu'il reste à faire à la main

Cette section remplace l'ancien « ce que ce document ne couvre pas encore » :
le branchement du frontend est fait (voir `user-data.js` et
`SYNC_UTILISATEUR.md`). Il reste trois choses à faire **dans le dashboard
Supabase**, que le code ne peut pas faire à ta place.

### 12.1 Appliquer les migrations, dans l'ordre

**Commence par le diagnostic**, qui ne modifie rien :

```
supabase/tests/00_diagnostic.sql
```

Il liste les six migrations, dit lesquelles sont déjà appliquées, et te donne
la liste exacte de celles qu'il te reste à exécuter. Il signale aussi le seul
point destructif du schéma : si ta table `profiles` date de la v1 et contient
encore une colonne `user_code`, `000_schema.sql` la **supprimera** avec son
contenu (c'était voulu — ce code n'était utilisé par rien).

Puis, SQL Editor → coller et exécuter, l'un après l'autre :

| Fichier | Ce qu'il fait |
|---|---|
| `supabase/migrations/000_schema.sql` | les 13 tables de base, RLS, bucket `avatars` |
| `supabase/migrations/001_brightspace.sql` | provenance des contenus importés |
| `supabase/migrations/002_centralisation.sql` | `user_stats`, `daily_stats`, `activities`, `chapter_visits`, `study_plans` |
| `supabase/migrations/003_sync_layer.sql` | index d'import non partiels, journal |
| `supabase/migrations/004_oauth_hardening.sql` | durcissement OAuth |
| **`supabase/migrations/005_user_sync.sql`** | **les clés naturelles qui rendent l'écriture multi-appareils idempotente** |

Toutes sont idempotentes : tu peux les relancer, y compris celles déjà
passées, sans créer de doublon (vérifié — tables, index et policies restent
au même nombre après un rejeu complet). La seule opération destructive de
toute la série est la suppression de `profiles.user_code` signalée ci-dessus.

**Si tu te trompes d'ordre, rien de grave** : chaque migration vérifie ses
prérequis avant d'écrire quoi que ce soit et s'arrête avec un message qui
nomme le fichier manquant et rappelle l'ordre complet.

Puis, pour vérifier que tout est en place, exécute ces trois fichiers de test —
chacun doit afficher `0 FAIL` sur sa ligne `RÉSUMÉ` :

```
supabase/tests/user_sync_tests.sql          18 vérifications
supabase/tests/rls_tests.sql               338 vérifications
supabase/tests/sync_idempotency_tests.sql   18 vérifications
```

Ils créent deux comptes de test aux UUID sentinelles et les suppriment à la
fin, y compris en cas d'échec. Aucune donnée réelle n'est lue ni touchée.

### 12.2 Activer la confirmation d'e-mail

**Authentication → Sign In / Providers → Email** :

- **Confirm email** : activé. C'est ce qui déclenche l'envoi du lien de
  confirmation à l'inscription. Sans lui, `signUp()` ouvre directement une
  session et l'écran « Vérifie ta boîte mail » ne s'affiche jamais.
- **Secure email change** : activé si tu veux qu'un changement d'adresse
  exige une confirmation sur l'ANCIENNE **et** la nouvelle. REV-EM gère les
  deux configurations sans changement de code.

### 12.3 Déclarer les URL de redirection

**Authentication → URL Configuration** :

- **Site URL** : `https://antsvfr.github.io/REV-EM/`
- **Redirect URLs** : la même, plus celles depuis lesquelles tu testes
  (`http://localhost:9109/index.html`, par exemple).

C'est **indispensable** : REV-EM passe `emailRedirectTo` à chaque envoi
(inscription, renvoi, changement d'adresse, mot de passe oublié) pour que le
lien ramène là où l'utilisateur était. Supabase refuse toute URL non déclarée,
et le lien retombe alors sur la Site URL — voire échoue.

### 12.4 Les modèles d'e-mail (facultatif)

**Authentication → Email Templates** : les modèles par défaut fonctionnent.
Si tu les personnalises, garde `{{ .ConfirmationURL }}` — c'est le lien que
REV-EM sait interpréter au retour.

---

## Ce que ce document ne couvre toujours pas

- **La délivrabilité réelle des e-mails.** Le SMTP par défaut de Supabase est
  limité en volume et destiné aux tests. Pour un usage réel, configure un SMTP
  personnalisé (Authentication → SMTP Settings). Aucun test automatisé ne peut
  établir qu'un e-mail arrive : seul un envoi réel le dira.
- **La suppression de compte par l'utilisateur.** Elle exige une Edge Function
  avec la `service_role key` (le navigateur n'a pas le droit de supprimer un
  compte). Le bouton existe et annonce honnêtement que ce n'est pas encore
  disponible.
