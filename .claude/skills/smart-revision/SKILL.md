---
name: smart-revision
description: Fonctionnement réel du moteur de recommandation "Révision intelligente" (smart-revision.js) et du moteur "Mes statistiques" (statistics.js) qui en réutilise les seuils de confiance. À consulter avant de toucher à ces deux fichiers, à leurs ponts dans index.html, ou à toute logique de recommandation/priorisation.
---

# Smart Revision (et Statistics, qui en dépend)

## Principe non négociable

Le moteur doit rester **déterministe, indépendant du DOM, indépendant de
l'UI, indépendant de Supabase, indépendant de WebLLM/WebGPU, testable,
réutilisable**. `smart-revision.js` et `statistics.js` sont chacun une
IIFE qui expose un objet sur `window` (`window.LyonSmartRevision`,
`window.LyonStatistics`) ; ils ne lisent **jamais** `state`, le DOM, ou
`localStorage` directement — tout ce dont ils ont besoin leur est passé en
argument par un pont dans `index.html`. C'est ce qui permet de les tester
en Node sans navigateur (`node -e "global.window=global;
require('./smart-revision.js'); ..."`) et ce qui les rend réutilisables
par un futur assistant IA, une future appli mobile, ou un futur planning
automatique — **ne jamais leur faire lire `state` directement**, même pour
une "petite" info.

## Architecture en 3 couches (voir aussi `frontend-architecture`)

1. **Faits** (dans `index.html`) : `buildChapterFacts()` construit, pour
   chaque chapitre, un objet de faits à partir des fonctions déjà
   existantes (`chapterMetrics`, `qstat`, `userChapterProgress`,
   `state.dash.wrongQuestions`, `state.progress`/`state.flashProgress`).
2. **Moteur pur** (`smart-revision.js`) : `computeRecommendations(facts,
   opts)` transforme ces faits en recommandations triées par priorité ;
   `buildSession(recommendations, targetMinutes, fallback)` construit une
   séance dans une enveloppe de temps.
3. **Pont** (dans `index.html`) : `getSmartRevisionRecommendations()`
   (point d'entrée public), `buildSmartSessionPlan()`,
   `attachSessionPayload()` (attache le contenu jouable — questions/cartes
   — uniquement aux éléments réellement retenus, pas à tous les
   candidats, pour rester léger).

`statistics.js` suit exactement le même schéma : `getStatistics()`/
`getSubjectStatistics()`/`getChapterStatistics()` (pont) →
`LyonStatistics.computeGlobalMastery/computeEvolution/computeComparison/
computeInsights` (moteur pur), lui-même construit sur les mêmes faits que
smart-revision (`chapterMetrics`, `qstat`, `userChapterProgress`,
`buildScoreEvolution`, `buildChaptersToReview`) — **jamais une deuxième
source de vérité** pour une donnée déjà calculée ailleurs.

## Données réellement utilisées (vérifiées, rien d'autre)

Par chapitre, dans les faits construits par `buildChapterFacts()` :

- `mastery` : `number|null` — maîtrise 0-100, **`null` si jamais tenté**
  (jamais 0 par défaut — voir plus bas "biais évité").
- `masterySampleSize` : nombre de questions répondues ≥1 fois (chapitre
  intégré) ou nombre de tentatives quiz+flashcards (chapitre utilisateur/
  IA) — sert de base à la confiance.
- `hasErrorData` / `recentErrorCount` : **`hasErrorData` est `false` pour
  tout chapitre utilisateur/IA** (les questions IA ne sont jamais suivies
  par `qstats`, voir `quiz-system`) — ne jamais inventer un nombre
  d'erreurs récentes là où cette donnée n'existe pas.
- `lastRevisionAt` : timestamp ou `null`, dérivé du plus récent entre
  `state.dash.recentChapters` (8 dernières visites) et
  `state.dash.recentActivity` (20 dernières sessions) — **limite connue** :
  peut manquer une visite plus ancienne si l'utilisateur a été très actif ;
  ne jamais deviner une date au-delà de ces deux sources.
- `trend` : `"up"|"down"|"flat"|null` — `null` si moins de 2 vraies
  sessions quiz/examen chronométrées pour ce chapitre, sinon comparaison
  dernière session vs moyenne des précédentes (seuil de 8 points pour
  ignorer le bruit).
- `hasQuiz`/`hasFlashcards`/`quizQuestionCount`/`flashcardCount`.

## Confiance (seuils exacts, à réutiliser, jamais dupliquer ailleurs)

`LyonSmartRevision.buildConfidence(sampleSize)` (réutilisé tel quel par
`LyonStatistics.confidenceOf()`) :

| sampleSize | confiance |
|---|---|
| 0 | `insufficient` |
| 1–2 | `low` |
| 3–9 | `moderate` |
| ≥10 | `high` |

La confiance **module** la priorité (`CONFIDENCE_DAMPING`) sans jamais
l'annuler à zéro, et n'est affichée dans l'UI que pour `insufficient`/
`low` (voir `premium-ui`) — jamais pour `moderate`/`high`, où l'afficher
n'apporterait rien.

## Explicabilité — ne jamais transformer en système arbitraire

Chaque recommandation a une **seule** raison choisie parmi une liste fixe
et ordonnée par spécificité (`pickReason()`), jamais culpabilisante :
`reason_recurring_errors` (≥3 erreurs récentes) > `reason_errors_recent`
(1-2) > `reason_declining_trend` > `reason_never_studied` >
`reason_low_mastery` > `reason_not_revised` (≥7 jours) >
`reason_improving_but_fragile` (repli). Les poids de priorité
(`WEIGHTS` dans `smart-revision.js`) sont des constantes **nommées et
commentées**, volontairement simples — si on ajoute/ajuste un facteur,
documenter pourquoi dans le même style, ne jamais rendre la formule
opaque.

## Biais explicitement évité (déjà corrigé une fois, ne pas réintroduire)

- Un chapitre jamais touché a `mastery: null`, jamais `0` — sinon toute
  interface qui affiche cette valeur mentirait ("0% de maîtrise" alors
  qu'il n'y a simplement aucune donnée). Ce bug est déjà survenu deux fois
  dans ce projet (`chapterMetrics()` retourne 0 pour un chapitre jamais
  répondu, `globalMetrics().mastery` idem) — toujours vérifier
  `answered > 0` avant d'utiliser une valeur de maîtrise brute.
- La maîtrise globale (`getStatistics().globalMastery`) est une **moyenne
  pondérée par le volume réel de données** (question par question pour le
  programme intégré, questions+cartes par chapitre utilisateur), jamais
  une simple moyenne de pourcentages par matière — un chapitre de 2
  questions ne doit jamais peser autant qu'un chapitre de 50.
- Un compte sans aucune activité ne doit jamais recevoir de recommandation
  ni de statistique chiffrée par défaut — voir la garde `hasAnyData` dans
  `renderSmartHome()`/`renderStatsOverview()` avant même d'appeler le
  moteur.

## Session de révision intelligente

`startSmartSession(items)` réutilise **intégralement**
`startQuiz()`/`startFlashDeck()` existants (voir `learning-modes`) — un
petit hook conditionnel dans `nextQuestion()`/`judgeCard()`/
`backToPicker()`/`backToFlashPicker()` (actif seulement si
`state.smartSession` existe) enchaîne les étapes vers un écran de bilan
au lieu de l'écran de résultat autonome. **Ne jamais dupliquer la logique
de quiz/flashcards pour la session** — toute évolution du moteur de
session doit continuer à passer par ces mêmes points d'entrée.

## Avant de modifier `smart-revision.js` ou `statistics.js`

1. Le changement change-t-il une **valeur numérique retournée** ou juste
   sa présentation ? Si c'est la valeur, vérifier tous les appelants dans
   `index.html` (dashboard, page dédiée, ponts).
2. Le changement introduit-il une dépendance au DOM/`state`/réseau ? Si
   oui, il n'a pas sa place dans le moteur pur — il doit vivre dans la
   couche "pont" d'`index.html`.
3. Le changement peut-il faire apparaître une recommandation/statistique
   sans donnée réelle derrière ? Si oui, ajouter la garde manquante plutôt
   que de l'ignorer.
