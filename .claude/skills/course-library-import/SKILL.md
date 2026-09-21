---
name: course-library-import
description: Bibliothèque de matières/chapitres, import de documents, génération de contenu pédagogique (fiche/quiz/flashcards) à partir d'un cours. À consulter avant de toucher à l'import, au traitement de fichiers, ou à la génération de contenu depuis un cours.
---

# Course Library & Import

## Ce qui existe réellement

- **Bibliothèque** (`state.tab === "library"`) : matières intégrées
  (`SUBJECTS`) + matières créées par l'utilisateur (`state.userSubjects`),
  chapitres intégrés (`CHAPTERS`) + chapitres utilisateur
  (`state.userChapters`, forme : `{id, subjectId, num, title, desc,
  content, summary, aiQuiz:[], aiFlashcards:[]}`).
- **Documents** (`state.documents`, section « 15septies. DOCUMENTS ») :
  import local de fichiers (ressources, sujets d'examen), séparé de
  l'import de cours ci-dessous.
- **Import de cours** (`state.courseImport`, section « 7ter. IMPORTATION
  DE COURS ») : pipeline complet fichier → contenu pédagogique structuré.
- **Fichier PDF original** : stocké tel quel dans **IndexedDB**
  (`em-lyon-revision-files`/`pdfs`, indexé par identifiant de chapitre —
  `saveCourseFileBlob`/`getCourseFileBlob`/`deleteCourseFileBlob`), pas
  dans `localStorage` (trop volumineux). **Point d'attention réel** : ce
  stockage n'est actuellement **pas** namespacé par compte contrairement
  à `localStorage` (voir `supabase-auth-data`) — à garder en tête avant
  toute évolution qui en dépendrait pour plusieurs comptes sur le même
  navigateur.

## Pipeline d'import de cours (vérifié dans index.html)

1. `courseImportProcessFile(index)` — extraction du texte du fichier.
2. Si le texte dépasse `COURSE_CONDENSE_THRESHOLD` (20 000 caractères) :
   `buildWorkingCourseText()` découpe en morceaux (`chunkCourseText()`) et
   condense chaque morceau (`condenseCourseChunk()`, un appel IA par
   morceau, annulable via `signal.cancelled`) pour rester dans la capacité
   du modèle sans perdre d'information — puis recompose un texte de
   travail borné à `COURSE_GEN_CONTEXT_CHARS` (7 000 caractères).
3. Génération, **deux chemins possibles** :
   - **Avec IA** : `courseImportGenerate(index)` → `courseImportRunAllSteps()`
     (fiche, résumé, questions de révision, flashcards, quiz — chaque
     étape individuellement rejouable via `courseImportRetryStep()` en
     cas d'échec, sans perdre les étapes déjà réussies).
   - **Sans IA** : `courseImportSaveWithoutAI(index)` → règles locales
     `buildHeuristicCourseMaterials()` (mode simplifié, voir `ai-system`),
     qui déclare honnêtement dans `item.failedSteps` les étapes qu'elle
     n'a pas pu produire (ex. `summary`/`reviewQuestions` toujours absents
     en mode heuristique) plutôt que de simuler un résultat.
4. `courseImportFinalize(index, opts)` — écrit le résultat dans un
   chapitre (`courseImportApplyGeneratedToChapter()`), avec `opts.aiSkipped`
   pour savoir a posteriori si le contenu vient du modèle ou du mode
   simplifié.

## Règles

- **Ne jamais détruire le texte source.** Le texte extrait du fichier
  original (`item.extractedText`/`ch.originalText`) est conservé même
  après condensation/génération — la condensation ne sert qu'à construire
  un texte de travail plus court pour l'IA, jamais à remplacer la source.
  C'est cette source qui permet la citation exacte "Dans ton cours" (voir
  `quiz-system`/`learning-modes`).
- **Conserver les sources**, ne jamais les écraser lors d'une régénération
  (voir "Régénérer le quiz"/"Régénérer les flashcards" dans la
  bibliothèque : le contenu précédent n'est remplacé qu'après succès de
  la nouvelle génération, jamais avant).
- **Gérer les erreurs explicitement.** `classifyGenerationError(e)`
  distingue mémoire/WebGPU/annulation/timeout/générique avec un message
  utilisateur adapté à chacun (voir `ai-system`) — ne jamais afficher un
  message d'erreur générique quand la cause réelle est identifiable.
- **États de chargement visibles.** `courseImportRunAllSteps` avance étape
  par étape avec un état affiché (`item.status`, `item.genStepIndex`) —
  toute nouvelle étape longue doit avoir un état intermédiaire visible,
  jamais un écran figé sans indication.
- **Permettre la correction du contenu généré automatiquement.** Voir les
  éditeurs déjà en place pour un quiz/des flashcards générés
  (`ch.aiQuiz`/`ch.aiFlashcards` éditables carte par carte/question par
  question dans la bibliothèque) — tout nouveau contenu généré doit rester
  corrigible par l'utilisateur, jamais figé.
- **Documents volumineux.** Le découpage/condensation (`chunkCourseText`/
  `buildWorkingCourseText`) existe précisément pour ça — réutiliser ce
  mécanisme plutôt qu'en écrire un nouveau pour toute future
  fonctionnalité qui doit traiter un texte long avec l'IA.
- **Éviter les appels IA inutiles.** Un texte sous le seuil de
  condensation ne déclenche aucun appel de condensation. Une régénération
  ne doit relancer que les étapes réellement demandées (voir
  `courseImportRetryStep`, étape par étape), jamais tout le pipeline pour
  corriger une seule étape.
