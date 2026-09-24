---
name: project-context
description: Carte structurelle vérifiée d'ANAQUIZZ / Lyon Révision — fichiers, responsabilités, architecture observée. À consulter avant toute tâche non triviale, pour savoir où vivent les choses avant de les modifier.
---

# Project Context — ANAQUIZZ / Lyon Révision

## Identité et objectifs

Plateforme de révision pour étudiants. Nom de code du dépôt : ANAQUIZZ.
Nom affiché dans l'interface : « Lyon Révision ». Objectif : que
l'utilisateur comprenne toujours où il en est (maîtrise, fragilités,
temps investi), reçoive des recommandations de révision explicables et
jamais inventées, et retrouve une expérience cohérente entre desktop et
mobile.

## Règle essentielle

**Avant toute modification significative, inspecter le code concerné et
comprendre ses dépendances réelles avant de modifier quoi que ce soit.**
Ce projet n'a pas de tests automatisés ni de types — la seule protection
contre la régression est la lecture attentive du code existant.

## Fonctionnalités observées

- Authentification par compte (email/mot de passe, Supabase Auth) + usage
  invité (sans compte) pleinement supporté.
- Bibliothèque de matières/chapitres : contenu intégré au programme
  (`SUBJECTS`/`CHAPTERS`/`QUESTIONS`/`FICHES`/`FLASHCARDS`, codés en dur
  dans `index.html`) + contenu créé/importé par l'utilisateur
  (`state.userSubjects`/`state.userChapters`).
- Quiz classiques (programme intégré) et quiz générés par IA/import
  (`ch.aiQuiz`).
- Flashcards intégrées et générées par IA/import (`ch.aiFlashcards`,
  `state.aiCards` pour les cartes IA ajoutées à un chapitre intégré).
- Interrogation orale, questions ouvertes (assistant IA), examens blancs.
- Import de cours (fichiers) avec génération de fiche/quiz/flashcards.
- Assistant IA local (WebLLM, dans le navigateur) : résumé, quiz,
  flashcards, questions libres, aide contextuelle.
- Dashboard, « Ma progression », « Révision intelligente », « Mes
  statistiques », Planning, Mon espace, Réglages.

## Architecture observée

Site statique, aucun build, aucun framework, aucun bundler. Pas de
`package.json`. Hébergement statique (GitHub Pages).

```
index.html                 ~14 600 lignes — HTML + CSS (inline <style>) + JS (inline <script>)
auth.js                    345 lignes — window.LyonAuth (Supabase Auth)
translations.js            ~1 900 lignes — window.LyonI18n (i18n, 355 clés × 5 langues)
smart-revision.js          245 lignes — window.LyonSmartRevision (moteur pur)
statistics.js               151 lignes — window.LyonStatistics (moteur pur)
ai-worker.js                 23 lignes — Web Worker WebLLM (chargé à l'exécution, pas en <script src>)
supabase-config.js          config locale (gitignored), URL + clé anon
supabase-config.example.js  gabarit documenté de supabase-config.js
supabase/migrations/000_schema.sql         473 lignes — schéma Postgres/RLS (13 tables, 1 seule réellement utilisée)
SETUP_SUPABASE.md           guide de configuration Supabase
```

Ordre de chargement des `<script>` dans `<head>` (important : chaque
module suivant peut s'appuyer sur `window.<Précédent>`) :

```
supabase-config.js → SDK Supabase (CDN) → auth.js → translations.js
  → smart-revision.js → statistics.js → <script> principal d'index.html
```

## Responsabilités des fichiers

- **`index.html`** — tout le reste : données du programme, rendu de
  chaque écran (`render()` dispatch sur `state.tab`), logique de chaque
  mode de révision, persistance locale, pont vers les moteurs purs. ~490
  fonctions top-level (dont les fonctions `async`). Organisé en sections numérotées commentées
  (`1. DONNÉES — QUESTIONS DE QUIZ`, `5. PERSISTANCE`, `6. QUIZ — LOGIQUE`,
  `11bis. ASSISTANT IA — MOTEUR LOCAL`, `15ter. PROGRESSION`, etc. — chercher
  `grep -n "^   [0-9]" index.html` pour la liste à jour).
- **`auth.js`** — authentification et profil uniquement. Ne touche jamais
  au DOM, à `render()`, ni aux données locales. Expose `window.LyonAuth`.
- **`translations.js`** — i18n uniquement. Expose `window.LyonI18n`.
- **`smart-revision.js`** — moteur pur de recommandation de révision.
  Expose `window.LyonSmartRevision`. Voir le Skill `smart-revision`.
- **`statistics.js`** — moteur pur de calcul statistique. Expose
  `window.LyonStatistics`, réutilise
  `LyonSmartRevision.buildConfidence` plutôt que de dupliquer les seuils
  de confiance. Voir le Skill `smart-revision` (pour le principe de
  confiance) et le code lui-même pour le détail.
- **`ai-worker.js`** — pont minimal vers `@mlc-ai/web-llm` dans un Web
  Worker séparé. Aucune logique produit.

## Onglets / navigation (état `state.tab`, voir `render()` dans index.html)

`dashboard`, `library`, `review`, `exam`, `fiches`, `ai`, `oral`,
`progress`, `smart`, `stats`, `settings`, `myspace`, `activities`,
`planning`, `exams`, `flash`, `quiz` (fallthrough par défaut). Chaque
onglet a sa propre paire `renderX()`/`attachXEvents()`.

## Systèmes de données (voir aussi `supabase-auth-data`)

- **Local (`localStorage`)** : quasi toutes les données produit — voir la
  liste des clés `KEY_*` dans `index.html` (section `5. PERSISTANCE`).
  Chargées/sauvegardées via `lsGet(key)`/`lsSet(key, value)`, jamais
  directement via `localStorage.getItem/setItem` ailleurs dans le code.
- **Scoping par compte** : depuis le correctif le plus récent, `lsGet`/
  `lsSet` préfixent chaque clé par un espace dérivé du compte Supabase
  connecté (`currentStorageNamespace()`). Un invité (ou Supabase non
  configuré) utilise un espace vide (comportement historique). Voir
  `supabase-auth-data` pour le détail complet du mécanisme.
- **`IndexedDB`** : usage ponctuel et distinct de `localStorage` — les
  fichiers PDF originaux importés (trop volumineux pour `localStorage`)
  sont stockés dans une base dédiée (`em-lyon-revision-files`, object
  store `pdfs`), indexés par identifiant de chapitre
  (`saveCourseFileBlob`/`getCourseFileBlob`/`deleteCourseFileBlob` dans
  `index.html`). **Non namespacé par compte** contrairement à
  `localStorage` — voir `course-library-import`. WebLLM utilise également
  IndexedDB en interne pour mettre en cache les poids du modèle
  téléchargé (`aiResetCache()` la vide) — ce cache-là est entièrement
  géré par la librairie, jamais directement par le code du projet.
- **Supabase** : une seule table réellement lue/écrite par le frontend —
  `profiles` (+ bucket Storage `avatars`), via `auth.js`. Les 12 autres
  tables de `supabase/migrations/000_schema.sql` (subjects, chapters, progress,
  question_stats, exam_history, badges, ai_cards, course_notes,
  planning_events, ai_history, preferences, documents) existent en base
  mais ne sont interrogées par AUCUN code frontend — vérifié par
  recherche de `.from("...")` dans `index.html`/`auth.js`. Ne jamais
  présumer qu'une donnée y est synchronisée sans l'avoir vérifié à nouveau.

## Authentification

`window.LyonAuth` (voir `auth.js`) : `state.status` (`idle`|`signed-out`|
`signed-in`), `state.user`, `state.profile`, `onChange(fn)`, `init()`,
`signUp`/`signIn`/`signOut`/`resetPassword`/`refreshProfile`/
`updateProfile`/`uploadAvatar`/`removeAvatar`. `LyonAuth.available` est
`false` si `supabase-config.js` est absent/non renseigné ou si le SDK
Supabase n'a pas chargé — dans ce cas le site fonctionne intégralement en
mode invité (comportement volontaire, jamais un état d'erreur bloquant).

## IA

Voir le Skill `ai-system`. En résumé : WebLLM en local (WebGPU), aucun
serveur ni clé API à nous, avec un mode simplifié (règles locales, sans
modèle) qui prend le relais quand l'IA est indisponible pour certaines
actions sur un chapitre intégré (résumé/quiz/flashcards).

## Révision intelligente / Statistiques

Voir le Skill `smart-revision`. `smart-revision.js` et `statistics.js`
sont tous deux des modules **purs** (aucune dépendance DOM/state/réseau),
pontés depuis `index.html` par des fonctions qui lisent l'état réel
(`buildChapterFacts()`, `getStatistics()`, etc.) et n'inventent jamais de
donnée manquante — elles retournent `null`/`available:false` à la place.

## Internationalisation

`window.LyonI18n` (voir `translations.js`) : `t(key, vars)`, `setLang`,
`getLang`, `onChange`, `localeTag()`, `flag()`. 5 langues (fr/en/es/de/it),
355 clés par langue, parité stricte vérifiée à chaque ajout. Voir le Skill
`i18n-accessibility-responsive`.
