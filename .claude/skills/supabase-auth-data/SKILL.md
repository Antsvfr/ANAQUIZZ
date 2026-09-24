---
name: supabase-auth-data
description: Authentification (auth.js), session, schéma Supabase réel, et le mécanisme de cloisonnement des données locales par compte. À consulter avant de toucher à auth.js, à Supabase, ou à la persistance locale.
---

# Supabase, Auth & Data

## Authentification (`auth.js`, `window.LyonAuth`)

- Responsabilité unique : connexion/inscription/déconnexion/session/profil.
  Ne touche **jamais** au DOM, à `render()`, ni aux données locales — voir
  son propre commentaire d'en-tête.
- `state.status` : `idle` → `signed-out`|`signed-in` (jamais d'autre
  valeur). `state.user` (objet Supabase Auth), `state.profile` (ligne de
  la table `profiles`), `state.busy`.
- `LyonAuth.available = configLooksReal && sdkReady` — `false` si
  `supabase-config.js` est absent/non renseigné ou si le SDK Supabase n'a
  pas chargé (ex. CDN bloqué). **Dans ce cas le site fonctionne
  intégralement en mode invité** — ne jamais traiter `available === false`
  comme une erreur bloquante.
- Un seul abonnement `client.auth.onAuthStateChange` pour toute la durée
  de vie de la page (protégé par `initStarted`) — ne jamais en ajouter un
  second.
- `humanError(err)` traduit les erreurs Supabase/Postgrest en messages
  courts en français, sans détail technique côté utilisateur (le détail
  reste en console) — réutiliser pour toute nouvelle erreur d'auth.

## Schéma Supabase réel (`supabase/schema.sql`, 473 lignes, 13 tables)

`profiles`, `subjects`, `chapters`, `progress`, `question_stats`,
`exam_history`, `badges`, `ai_cards`, `course_notes`, `planning_events`,
`ai_history`, `preferences`, `documents`.

**Ce n'est plus vrai que toutes les données sont locales.** Jusqu'à l'étape
« comptes multi-appareils », une seule table était lue/écrite par le
frontend (`profiles`, depuis `auth.js`). Depuis, **`user-data.js`
(`window.LyonUserData`) lit et écrit les 18 tables de données
personnelles** : Supabase est la source de vérité pour un compte connecté,
`localStorage` est devenu un cache. Voir `SYNC_UTILISATEUR.md` pour
l'architecture complète (domaines, stratégie de conflit, suppressions).

Migrations à appliquer dans l'ordre : `schema.sql`, puis `001` → `005`.
La `005_user_sync.sql` ajoute les **clés naturelles** (`unique (user_id,
local_id)` sur subjects/chapters/documents/planning_events,
`(user_id, taken_at)` sur exam_history) sans lesquelles l'écriture
multi-appareils ne peut pas être idempotente. Index **non partiels**,
pour la même raison qu'en 003 : `on conflict` ne sait pas utiliser un
index partiel.

**Reste local, volontairement** : le binaire des documents et les PDF
importés (volume), et `dash.wrongQuestions` (doublon de `question_stats`
indexé par un index positionnel — reconstruit à la lecture).

## RLS (Row Level Security)

Chaque table applique `auth.uid() = user_id` (ou `= id` pour `profiles`)
en `select`/`insert`/`update`/`delete` — générées pour la plupart des
tables par une boucle SQL (`create policy ... using (auth.uid() =
user_id)`), avec des policies explicites pour `profiles`/`ai_history`/
`preferences`. Le bucket Storage `avatars` a ses propres policies RLS
(`avatars_select_own`, etc.). **Toujours vérifier que RLS reste actif et
scopé par `auth.uid()`** avant toute modification du schéma — la sécurité
réelle repose entièrement là-dessus, jamais sur le frontend.

## Le point de branchement de la synchronisation : `lsSet()`

Toute écriture locale passe par `lsSet()`, et c'est **là** que la
synchronisation est branchée (`cloudNoteLocalWrite`), pas sur les quinze
fonctions `save*()`. Conséquence pratique : **une nouvelle donnée voyage
dès qu'elle déclare sa clé dans `LyonUserData.DOMAINS_BY_STORAGE_KEY`** —
il n'y a aucun appel à ajouter ailleurs, et aucun à oublier.

L'hydratation réécrit le cache local avec ce qui arrive de Supabase :
elle est encadrée par `cloudHydrating`, qui empêche le renvoi immédiat de
ce qu'on vient de recevoir. Toute nouvelle écriture faite pendant une
hydratation doit rester dans cet encadrement.

## Cloisonnement des données locales par compte

**Historique** : jusqu'à un correctif récent, les données locales
(progression, quiz, flashcards, IA, planning, documents) n'étaient
scopées par aucun compte — n'importe quel compte connecté sur le même
navigateur voyait les mêmes données. C'est corrigé. Mécanisme actuel,
entièrement dans `index.html` :

- `currentStorageNamespace()` retourne `"u." + userId + "."` si un
  utilisateur est connecté (`LyonAuth.available && state.status ===
  "signed-in" && state.user`), sinon `""` (invité — comportement
  historique inchangé).
- `lsGet(key)`/`lsSet(key, value)` préfixent **toujours** la clé
  `localStorage` par ce namespace — **ce sont les deux seules fonctions
  autorisées à toucher `localStorage` directement** ; tout nouveau code
  doit passer par elles, jamais par `localStorage.getItem/setItem`
  directement.
- `claimGuestDataForUser(userId)` : migration **unique et non
  destructive**. La première fois qu'un compte se connecte sur un
  navigateur donné, les données invité pré-existantes sont copiées vers
  son espace nommé (rien n'est perdu pour l'utilisateur déjà existant).
  Un marqueur global non namespacé (`storage-claimed-by`) garantit qu'un
  **deuxième compte différent ne peut plus jamais hériter de cette même
  donnée** — il démarre avec un espace strictement vide.
- `handleAuthUserChange()` (appelé par `LyonAuth.onChange`) détecte un
  vrai changement de compte (pas juste un rafraîchissement de session) et
  déclenche `loadDataAndRefreshUi()` (recharge tout l'état + re-render),
  en réinitialisant `state.tab` sur `"dashboard"` pour ne jamais laisser
  affichée une vue qui référence une donnée du compte précédent.
- **Piège déjà rencontré et corrigé** : `loadAllData()` doit **toujours**
  réinitialiser chaque champ à sa valeur par défaut quand la donnée
  chargée est absente (jamais un `if(dash){...}` qui laisserait les
  valeurs EN MÉMOIRE du compte précédent inchangées) — ce garde-fou
  n'avait d'importance que depuis que `loadAllData()` est rappelable
  (changement de compte) ; toute nouvelle donnée ajoutée à `state.dash`/
  `state.planning`/etc. doit suivre ce même pattern de réinitialisation
  inconditionnelle.

## Règles

- Ne jamais exposer de secret : la clé Supabase `anon` (dans
  `supabase-config.js`, gitignored par convention même si elle n'est pas
  un secret au sens strict) est publique par conception — ne jamais
  introduire une `service_role key` côté frontend.
- Ne jamais faire confiance au frontend pour la sécurité : RLS est la
  seule barrière réelle.
- Ne jamais perdre de données lors d'un changement de structure —
  toujours prévoir une valeur par défaut pour les anciennes données (voir
  `frontend-architecture`).
- Ne pas modifier une structure de données (locale ou Supabase) sans
  avoir listé tous ses lecteurs/écrivains actuels.
- Gérer explicitement l'utilisateur non connecté : c'est un état normal
  et pleinement supporté du produit, pas un cas d'erreur.
- Avant de créer une nouvelle table Supabase, vérifier si la donnée peut
  déjà être calculée à partir de l'existant local (voir `smart-revision`) —
  ne pas en créer une "juste au cas où".
