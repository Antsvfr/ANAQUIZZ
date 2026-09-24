# ANAQUIZZ / Lyon Révision — gouvernance Claude Code

Ce fichier est la couche de gouvernance générale du projet. Il explique ce
qu'est le produit et pose les règles transversales. Pour le détail
technique d'un domaine précis, consulte le Skill correspondant
(`.claude/skills/<nom>/SKILL.md`) — ce fichier ne recopie pas leur contenu.

## Le produit

**Anaquizz** (nom d'affichage courant dans l'interface : « Lyon Révision »)
est une plateforme de révision pour étudiants : matières, chapitres, fiches
de cours, quiz, flashcards, interrogation orale, examens blancs, import de
cours, un assistant IA local, un moteur de recommandation de révision
(« Révision intelligente »), une page de progression (« Ma progression »)
et une page de statistiques (« Mes statistiques »).

Objectif produit : que l'utilisateur comprenne toujours où il en est, ce
qu'il maîtrise, ce qui reste fragile, et quoi faire ensuite — sans jamais
lui présenter une donnée inventée comme si elle était réelle.

## Architecture observée (voir `project-context` pour le détail)

Site statique sans build, sans framework, sans bundler : un seul gros
fichier `index.html` (~14 600 lignes, ~490 fonctions, HTML+CSS+JS inline)
plus quelques modules JS autonomes chargés en `<script>` classique, dans
cet ordre : `supabase-config.js` → SDK Supabase (CDN) → `auth.js` →
`translations.js` → `smart-revision.js` → `statistics.js` → le script
principal d'`index.html`. `ai-worker.js` est chargé séparément, à
l'exécution, comme Web Worker. Aucun de ces modules ne modifie ce
découpage sans raison réelle.

## Règles de modification du code

- **Analyser avant de modifier.** Toujours lire le code concerné et
  comprendre ses dépendances réelles avant de le changer — jamais deviner
  une architecture qui n'existe pas.
- **Réutiliser l'existant.** Avant d'écrire une nouvelle fonction, chercher
  si une fonction équivalente existe déjà (particulièrement vrai pour les
  calculs de maîtrise/progression/confiance — voir `smart-revision.js` et
  `statistics.js`, qui existent précisément pour être réutilisés par
  d'autres fonctionnalités).
- **Ne jamais casser l'existant.** Aucune fonctionnalité, aucune donnée
  utilisateur, aucune traduction existante ne doit régresser silencieusement.
- **Pas de réécriture sans nécessité.** Ne jamais réécrire `index.html`
  entièrement, remplacer une architecture qui fonctionne, supprimer une
  fonctionnalité pour simplifier, ou changer une technologie sans raison
  vérifiable.
- **Compatibilité ascendante.** Toute nouvelle structure de données doit
  prévoir une valeur par défaut pour les données existantes qui ne l'ont
  pas encore (voir le pattern déjà utilisé partout dans `loadAllData()`).

## Règles de qualité et UX/UI

Voir `premium-ui` pour le détail. En résumé : compréhension avant
efficacité avant simplicité avant cohérence avant esthétique avant
innovation. « Premium » ne veut pas dire décoratif.

## Règles de sécurité (voir `performance-security` et `supabase-auth-data`)

- Ne jamais exposer de secret, de `service_role key`, de credential ou de
  token privé côté frontend. La clé Supabase `anon` n'est pas un secret
  (elle est conçue pour être publique), mais la sécurité réelle des
  données repose exclusivement sur les policies RLS côté base — jamais sur
  le frontend.
- Toujours échapper le HTML injecté dynamiquement (`escapeHtml()`, déjà
  utilisé partout dans `index.html`) — jamais de `innerHTML` avec du texte
  utilisateur non échappé.

## Règles de performance

Pas de recalcul inutile, pas de listener dupliqué, pas d'appel IA/réseau
superflu. Les moteurs de calcul (`smart-revision.js`, `statistics.js`)
sont volontairement recalculés à la demande plutôt que mis en cache : leur
volumétrie réelle ne le justifie pas (mesuré : quelques millisecondes même
sur un historique synthétique de plusieurs centaines de jours) — ne pas
ajouter de cache sans mesurer un vrai problème de performance d'abord.

## Règles IA (voir `ai-system`)

L'IA (WebLLM, en local dans le navigateur, sans clé API ni serveur à
nous) complète les systèmes déterministes existants, elle ne les remplace
pas. Chaque fonctionnalité qui dépend de l'IA doit avoir un comportement
défini quand l'IA est indisponible (WebGPU absent, modèle non chargé,
timeout) — voir le mode simplifié déjà implémenté
(`aiRunHeuristicChapterAction`).

## Règles Supabase et données utilisateur (voir `supabase-auth-data`)

- `auth.js` gère exclusivement l'authentification/le profil (table
  `profiles` + bucket `avatars`). Les données produit (progression, quiz,
  flashcards, planning, documents, statistiques) sont **synchronisées avec
  Supabase par `user-data.js`** depuis l'étape « comptes multi-appareils » :
  pour un compte connecté, **Supabase est la source de vérité** et
  `localStorage` n'est plus qu'un cache. Voir `SYNC_UTILISATEUR.md`.
- Restent volontairement locaux à l'appareil : le binaire des documents et
  les PDF importés (`IndexedDB`), pour des raisons de volume.
- Pour un **invité** (pas de compte, ou Supabase non configuré), rien de
  tout cela ne s'active : `localStorage` reste la seule persistance. C'est
  un état normal du produit, jamais un cas d'erreur.
- Le schéma s'installe par `supabase/migrations/`, **dans l'ordre numérique
  à partir de `000_schema.sql`**. Ne jamais supposer qu'une migration peut
  s'appliquer seule : chacune vérifie ses prérequis et refuse de s'exécuter
  sinon.
- Depuis le correctif de cloisonnement par compte, `localStorage` est
  scopé par identifiant de compte connecté (`currentStorageNamespace()`
  dans `index.html`) : ne jamais contourner ce mécanisme en lisant/écrivant
  `localStorage` directement — toujours passer par `lsGet`/`lsSet`.
- Aucune donnée d'un utilisateur ne doit jamais être visible par un autre.

## Règles de test et de non-régression (voir `testing-code-review`)

Après toute modification significative : vérifier la syntaxe, tester le
comportement réel (jamais juste "ça devrait marcher"), le responsive, les
états vides/erreur, les traductions, l'absence de régression sur les
fonctionnalités voisines. Ne jamais prétendre avoir testé quelque chose
qui ne l'a pas réellement été.

## Comment utiliser les Skills

Chaque Skill couvre un domaine du produit. Consulte-le **avant** de
modifier du code dans son domaine, pas après :

| Skill | Consulter quand... |
|---|---|
| `project-context` | avant toute tâche, pour la carte du projet |
| `premium-ui` | on crée/modifie une interface |
| `frontend-architecture` | on ajoute du code à `index.html` ou on envisage un refactor |
| `quiz-system` | on touche aux questions, à la correction, aux scores |
| `learning-modes` | on touche à un mode de révision (quiz/flashcards/oral/examen) |
| `course-library-import` | on touche à la bibliothèque, aux cours, à l'import |
| `smart-revision` | on touche à `smart-revision.js` ou aux recommandations |
| `ai-system` | on touche à l'assistant IA, à WebLLM, ou à `ai-worker.js` |
| `supabase-auth-data` | on touche à `auth.js`, Supabase, ou au stockage local |
| `i18n-accessibility-responsive` | on ajoute un texte, une vue, ou touche au responsive |
| `performance-security` | avant d'ajouter une dépendance, un appel réseau, une entrée utilisateur |
| `testing-code-review` | avant de considérer une tâche terminée |

## Fin de tâche

À la fin d'une tâche significative, résumer : modifications réalisées,
fichiers modifiés, fonctionnalités ajoutées, fonctionnalités préservées,
vérifications réalisées, problèmes éventuels, prochaines améliorations
possibles — sans transformer automatiquement une suggestion en
modification non demandée.
