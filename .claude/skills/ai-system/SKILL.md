---
name: ai-system
description: Fonctionnement réel de l'assistant IA (WebLLM local, ai-worker.js et le pipeline dans index.html). À consulter avant de toucher à l'assistant IA, aux appels de génération, ou à ai-worker.js.
---

# AI System

## Ce qui est réellement en place

L'IA est **WebLLM** (`@mlc-ai/web-llm`), exécutée **entièrement dans le
navigateur de l'utilisateur** via WebGPU — **aucun serveur à nous,
aucune clé API**. Le modèle est téléchargé depuis Hugging Face par le
navigateur lui-même et mis en cache par le navigateur (voir
`ai-worker.js`, 23 lignes, qui ne fait que brancher
`WebWorkerMLCEngineHandler` sur les messages du thread principal — toute
la logique produit vit dans `index.html`).

Deux modèles au choix (`AI_MODELS`, `state.aiModelChoice` = `auto`/
`small`/`large`) : `small` (Llama-3.2-1B, ≈0,9 Go, plus rapide) et `large`
(Llama-3.2-3B, ≈1,9 Go, meilleure qualité) — `pickModelForDevice()` choisit
automatiquement en mode `auto`.

## Séparation des responsabilités (déjà en place, à respecter)

1. **Préparation du contexte** : `buildPrompt(action, extra)` assemble le
   prompt à partir de builders de contexte dédiés —
   `chapterContext(chId)`, `questionContext(q, givenIdx)`,
   `errorsContext(limit)`, `profileContext()`. Une nouvelle action IA doit
   ajouter/réutiliser un builder de contexte, jamais construire son prompt
   à la main dans la fonction d'exécution.
2. **Appel IA** : `aiSend()`/`aiRun(action, extra)` (chapitre) et
   `courseAiSend()` (import de cours) pilotent l'appel réel, toujours
   avec un timeout (`withGenTimeout(promise, ms, label)`, qui interrompt
   proprement le moteur WebLLM — `webllmEngine.interruptGenerate()` — au
   lieu de laisser une génération tourner indéfiniment).
3. **Validation** : la sortie structurée (JSON attendu pour
   quiz/flashcards/fiches) est extraite de façon tolérante
   (`extractJsonObject()`, répare les virgules traînantes) — **jamais
   imposée aveuglément** : chaque champ manquant a un repli sûr côté
   appelant.
4. **Affichage** : `renderAIMarkdown()`/`renderFicheStructuredHtml()`/
   `markdownLiteFicheHtml()`, toujours après échappement (voir
   `performance-security`).

Ne pas mélanger ces étapes dans une seule fonction pour une nouvelle
action IA — suivre ce découpage.

## Gestion des erreurs et timeouts (déjà en place)

`classifyGenerationError(e)` classe toute erreur en 5 catégories avec un
message utilisateur français adapté, jamais un message technique brut :
`memory` (mémoire insuffisante), `webgpu` (accélération perdue),
`cancelled`, `timeout`, `generic` (avec `detail` conservé pour la
console). Réutiliser cette fonction pour toute nouvelle erreur liée à
l'IA, plutôt que d'inventer un nouveau message.

`checkWebGPUCompatibility()` distingue API absente / adaptateur
introuvable / adaptateur trouvé mais périphérique impossible à
initialiser — utilisé pour le diagnostic affiché à l'utilisateur
(`aiDiagnosticPanelHtml()`) avant même de tenter un chargement.

## Fallback — le principe le plus important de ce Skill

**L'IA doit compléter les systèmes déterministes existants, jamais les
remplacer sans repli.** Exemple déjà implémenté et à suivre pour toute
nouvelle action IA sur un chapitre du programme intégré :
`aiRunHeuristicChapterAction(action)` — si `state.aiStatus !== "ready"`
et que l'action est marquée `heuristic` dans `AI_ACTIONS`, on retombe sur
`buildHeuristicCourseMaterials()`/`heuristicSummary()` (règles locales,
sans modèle, à partir de la fiche déjà rédigée) plutôt que de bloquer
l'utilisateur. Le mode simplifié se signale explicitement
(« ⚙️ Mode simplifié (sans IA) ») — **jamais présenté comme une vraie
réponse IA**.

## Ne jamais présenter une réponse IA comme une vérité

Tout contenu généré (quiz, flashcards, fiches, réponses libres) reste
**corrigible par l'utilisateur** (voir `course-library-import`) et n'est
jamais marqué comme faisant autorité au même titre que le contenu du
programme officiel. Une citation "Dans ton cours" doit toujours être une
citation exacte du texte source, jamais une paraphrase du modèle (voir
`quiz-system`).

## Éviter les appels inutiles

- Un texte sous `COURSE_CONDENSE_THRESHOLD` ne déclenche aucun appel de
  condensation (voir `course-library-import`).
- Une régénération ne relance que l'étape demandée
  (`courseImportRetryStep`), jamais tout le pipeline.
- `aiEngineBusy()` empêche de lancer une action IA pendant qu'une autre
  est déjà en cours — toute nouvelle action doit vérifier cet état avant
  de démarrer.

## Secrets

Aucune clé API, aucun secret ne doit jamais être introduit pour l'IA —
WebLLM ne nécessite ni clé ni compte. Si une future fonctionnalité
introduit un vrai appel à un service IA distant, voir
`performance-security` avant de toucher au frontend.
