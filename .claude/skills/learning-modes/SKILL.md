---
name: learning-modes
description: Les modes de révision réellement présents dans ANAQUIZZ, leur fonction pédagogique distincte, et comment ils sont reliés entre eux. À consulter avant d'ajouter ou de modifier un mode de révision.
---

# Learning Modes

## Modes réellement présents (vérifiés dans index.html)

| Mode | Onglet (`state.tab`) | Fonction pédagogique | Moteur |
|---|---|---|---|
| **Quiz** | `quiz` (+ `flash` séparé) | Vérifier une connaissance précise, à choix multiple, avec correction immédiate et explication | Déterministe, questions du programme ou générées (voir `quiz-system`) |
| **Flashcards** | `flash` | Mémorisation active (recto/verso), auto-évaluation "Je savais"/"À revoir" | Déterministe, pas de correction automatique — l'utilisateur juge lui-même |
| **Interrogation orale** | `oral` | S'entraîner à répondre à l'oral, une question ouverte à la fois, avec correction | **Pilotée par l'assistant IA** (`startOralDrill()` → `aiOpenFromChapter("drill", ...)` ou `libRunUserChapterAI(ch,"drill")`), pas un moteur déterministe séparé |
| **Questions ouvertes** | `ai` (label de nav "Questions ouvertes") | Poser une question libre à l'assistant IA, obtenir une réponse contextualisée | Assistant IA (voir `ai-system`) — ce n'est pas un mode de quiz distinct, c'est l'accès à l'assistant IA lui-même |
| **Examens blancs** | `exam` (+ hub `exams`) | Simuler une épreuve chronométrée sur plusieurs chapitres, avec bilan | Déterministe, séparé du quiz classique (voir "Ne jamais mélanger avec le quiz" plus bas) |
| **Révision intelligente** | `smart` | Séance construite automatiquement à partir des priorités réelles de l'utilisateur, en réutilisant quiz/flashcards existants | Voir le Skill `smart-revision` |

## Chaque mode garde une fonction pédagogique distincte

- Le **quiz** teste une connaissance précise avec une bonne réponse
  objective. Les **flashcards** entraînent le rappel actif, sans
  correction automatique (auto-évaluation honnête). Ne pas fusionner ces
  deux logiques : un quiz ne doit pas devenir une flashcard déguisée, et
  inversement.
- L'**interrogation orale** simule une vraie situation d'oral — questions
  ouvertes, pas de choix multiple, correction qualitative par l'IA. C'est
  volontairement différent du quiz écrit.
- Les **examens blancs** simulent une épreuve complète (plusieurs
  chapitres, chronométrage) — voir la section 7quinquies (« MODE EXAMEN »)
  dans `index.html`, avec son propre état `state.exam` et ses propres
  écrans (`renderExamSetup`/`renderExamRunning`/`renderExamResults`).
  **Important** : le mode examen (`.opt`, `.card.results`, voir
  `renderExamRunning`/`renderExamResults`) partage historiquement
  certaines classes CSS avec l'ancien écran de quiz — avant de modifier le
  CSS ou le HTML d'un des deux, vérifier par recherche de la classe
  concernée qu'elle n'est pas partagée avec l'autre (voir `premium-ui`
  pour le namespace `qz-`, introduit précisément pour que le quiz premium
  actuel n'ait plus ce risque avec l'examen).

## Identité produit cohérente sans devenir identiques

Chaque mode réutilise les mêmes primitives (mêmes données de chapitre,
même moteur de citation "Dans ton cours" pour quiz et flashcards, mêmes
tokens de design — voir `premium-ui`) mais garde son propre écran et sa
propre logique de progression. Ne pas créer un mode générique unique "qui
fait tout" : la distinction entre modes est volontaire et pédagogique, pas
accidentelle.

## Réutilisation entre modes déjà en place, à préserver

- « Dans ton cours » (citation exacte + surbrillance) est implémenté une
  fois pour les flashcards (`renderFlashSourcePanel`) et une fois pour le
  quiz (`renderQuizCoursePanel`), tous deux construits sur les mêmes
  primitives génériques de localisation de citation dans le texte source
  — mais ce sont deux fonctions distinctes, jamais fusionnées, pour ne
  jamais risquer de casser l'une en modifiant l'autre.
- « Révision intelligente » lance une **vraie session** de quiz ou de
  flashcards existante (`startQuiz()`/`startFlashDeck()`), avec un simple
  hook conditionnel dans `nextQuestion()`/`judgeCard()`
  (`state.smartSession`) pour enchaîner les étapes — ce n'est jamais une
  troisième implémentation parallèle du quiz ou des flashcards.

## Avant d'ajouter un nouveau mode

1. Vérifier qu'aucun mode existant ne remplit déjà ce besoin.
2. Définir sa fonction pédagogique distincte en une phrase.
3. Réutiliser les primitives existantes (citation de cours, suivi de
   maîtrise, historique d'activité — voir `quiz-system`/`smart-revision`)
   plutôt que d'en recréer des équivalentes.
4. Lui donner son propre écran (`renderX()`/`attachXEvents()`) et son
   propre namespace CSS (voir `premium-ui`), jamais partagé avec un mode
   existant.
