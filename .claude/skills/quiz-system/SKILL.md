---
name: quiz-system
description: Structure des questions, correction, scoring, maîtrise par question, et comment les erreurs alimentent la progression. À consulter avant de créer/modifier des questions, la logique de quiz, ou la génération de questions par IA.
---

# Quiz System

## Structure d'une question (vérifiée dans index.html)

```js
{
  theme: "fondamentaux",         // clé de thème (programme intégré) — voir THEME_META
  q: "Énoncé de la question ?",
  opts: ["A", "B", "C", "D"],    // 4 options
  correct: 0,                    // index de la bonne réponse dans opts
  exp: "Explication affichée après réponse (POURQUOI).",
  // Champs ajoutés en cours de projet, optionnels, jamais requis pour la
  // compatibilité ascendante :
  chapterId: "ch1",              // pour relier au passage du cours ("Dans ton cours")
  sourceQuote: "...",            // citation exacte du cours source
  exampleQuote: "...",           // exemple pertinent trouvé à proximité
  ai: true,                      // true pour une question générée (IA ou heuristique)
  uid: "q1a2b3",                 // identifiant STABLE (hash thème+énoncé), voir plus bas
  id: 0,                         // index dans QUESTIONS — conservé pour compat, PAS un identifiant stable
}
```

Un chapitre utilisateur/IA stocke son quiz dans `ch.aiQuiz` (tableau du
même format). Un chapitre intégré n'a pas de tableau de questions propre :
ses questions sont les entrées de `QUESTIONS` dont `theme` figure dans
`ch.themes`.

## Identifiants : `id` vs `uid`

- `q.id` = index dans `QUESTIONS` au chargement — **jamais stable** si
  l'ordre de `QUESTIONS` change, conservé uniquement pour la compatibilité
  avec d'anciennes données déjà enregistrées sous cette forme
  (`d.wrongQuestions`, historique). Ne jamais l'utiliser pour du nouveau
  code de suivi.
- `q.uid` = `"q" + hash(theme + "|" + question)`, dédupliqué si collision
  (`assignIds()` dans index.html). **C'est la clé de suivi par question**
  (`state.qstats[q.uid]`) — utiliser `uid`, jamais `id`, pour tout nouveau
  système de suivi par question.

## Correction et anti-répétition

- `shuffle(arr)` (Fisher-Yates) mélange le pool de questions à chaque
  lancement de quiz — jamais le même ordre deux fois.
- Sélection intelligente déjà disponible : `poolNever()` (jamais faites),
  `poolWrong()` (dernière réponse fausse), `poolHard()` (taux de réussite
  <50% sur ≥2 tentatives), `poolReview()` (maîtrise <75%),
  `poolExpress(n)` (mélange pondéré erreurs/à-revoir/neuf/aléatoire) —
  réutiliser ces pools plutôt qu'en réécrire un équivalent.

## Maîtrise par question (moteur déjà en place)

- `recordQuestionResult(q, ok)` enregistre chaque réponse dans
  `state.qstats[q.uid] = {seen, correct, wrong, streak, last, lastDate,
  history[10 derniers], theme}`.
- `masteryOf(q)` calcule une maîtrise 0-100 pondérée (réponses récentes
  plus lourdes, bonus de série ≥3, pénalité si une seule réponse jamais
  donnée — "maîtrise non confirmée").
- `masteryTier(m)` classe en 5 paliers : `new`/`critical`/`weak`/`good`/
  `mastered`.
- **Limite réelle et volontaire** : `trackQuizAnswer(q, correct)` **ne
  suit PAS** les questions IA (`if(q.ai){ ...; return; }`) — donc
  `qstats`/`masteryOf`/`d.wrongQuestions` ne couvrent que le programme
  intégré. Un chapitre utilisateur/IA n'a qu'un signal agrégé (meilleur
  score de quiz via `state.progress["chapter:"+id]`). Ne jamais présenter
  un chapitre IA comme ayant des "erreurs récentes" par question — cette
  donnée n'existe pas pour lui (voir `smart-revision`, `hasErrorData`).

## Comment les erreurs alimentent la progression et la révision intelligente

- `trackQuizAnswer` (programme intégré) alimente `state.dash.wrongQuestions`
  (compteur par question, par thème) et `state.qstats`.
- `smart-revision.js`/`statistics.js` (via leurs ponts dans index.html)
  lisent ces mêmes données pour prioriser les recommandations et calculer
  les statistiques d'erreurs — jamais une deuxième source d'erreurs
  inventée. Toute nouvelle fonctionnalité qui a besoin de savoir "quelles
  questions sont ratées" doit lire `state.qstats`/`state.dash.wrongQuestions`,
  pas recalculer autre chose.

## Génération de questions (IA et import de cours)

Voir `ai-system` et `course-library-import` pour le détail du pipeline.
Principes propres au contenu généré :

- Une question doit être **claire, précise, adaptée au niveau, non
  ambiguë** — jamais devinable par la seule formulation, jamais générique.
- Le JSON produit par le modèle est extrait de façon tolérante
  (`extractJsonObject()` répare les virgules traînantes) mais **jamais
  imposé aveuglément** : chaque champ manquant a un repli sûr côté
  appelant plutôt que de faire échouer toute la génération.
- Ne jamais modifier le contenu pédagogique original (définitions,
  exemples, formulations du cours source) lors de la génération — le
  `sourceQuote` doit être une citation exacte, jamais reformulée.

## Cas limites à toujours vérifier

- Quiz avec un pool vide (aucune question ne correspond) → ne jamais
  lancer, retourner silencieusement (pattern déjà utilisé partout :
  `if(!source || source.length === 0) return;`).
- Ancien format de question sans `uid`/`chapterId`/`sourceQuote` → doit
  continuer à fonctionner (voir la logique de résolution rétroactive
  décrite dans le code pour "Dans ton cours").
- Double-clic sur une réponse → `state.answered` empêche une deuxième
  sélection (voir `selectOption()`).
