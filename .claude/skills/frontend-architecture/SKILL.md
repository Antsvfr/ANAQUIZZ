---
name: frontend-architecture
description: Comment ajouter/modifier du code dans un projet monolithique sans build (index.html ~14 600 lignes) sans le dégrader. À consulter avant d'ajouter une fonction, un fichier, ou d'envisager un refactor.
---

# Frontend Architecture

## Constat réel du projet

`index.html` est un seul fichier de ~14 600 lignes contenant HTML, CSS
(`<style>`) et JavaScript (`<script>`, ~490 fonctions top-level), sans
build, sans framework, sans module ES pour le script principal (les
modules séparés — `auth.js`, `translations.js`, `smart-revision.js`,
`statistics.js` — sont chargés en `<script>` classique, pas `type="module"`,
et exposent un objet sur `window`). C'est un fait, pas un problème à
corriger d'urgence : le projet est stable et fonctionne ainsi. Le travail
consiste à **améliorer progressivement**, jamais à réécrire.

## Règles

- **Analyser avant de modifier.** Chercher les fonctions/sections
  existantes avant d'écrire quoi que ce soit (`grep -n "^function "` est
  souvent le point de départ le plus rapide dans ce projet).
- **Éviter les réécritures inutiles.** Ne jamais réécrire une fonction
  qui marche pour "faire plus propre" sans besoin réel derrière.
- **Réduire progressivement la complexité**, pas d'un coup. Chaque tâche
  peut améliorer localement ce qu'elle touche, sans se donner pour
  mission de "nettoyer" tout le fichier.
- **Réutiliser les fonctions existantes** plutôt que d'en dupliquer une
  variante. Exemple observé et à suivre : `getChapterStatistics()`
  (`statistics`) réutilise `chapterMetrics()`/`qstat()`/
  `userChapterProgress()` au lieu de recalculer la maîtrise autrement ;
  `statsReviseChapter()` réutilise le moteur `smart-revision` avant de
  retomber sur `startQuiz()`/`startFlashDeck()` existants.
- **Éviter la duplication.** Si une même donnée doit être groupée/formatée
  à deux endroits, factoriser en une petite fonction partagée plutôt que
  copier-coller (voir `groupActivityByDay()`, extrait volontairement en
  fonction séparée de `renderProgress()` pour être réutilisé par
  `renderStatsOverview()` sans dupliquer la logique — tout en choisissant
  sciemment de NE PAS modifier `renderProgress()` elle-même, pour ne pas
  risquer de régresser une fonctionnalité déjà en production).
- **Éviter les variables globales inutiles.** Le fichier en a déjà
  beaucoup par nécessité historique (`state`, `QUESTIONS`, `CHAPTERS`,
  `SUBJECTS`, `FICHES`, `FLASHCARDS`...) — ne pas en ajouter de nouvelles
  sans qu'elles servent réellement plusieurs fonctions.
- **Créer un module séparé seulement quand ça apporte une vraie valeur.**
  Le critère déjà appliqué avec succès dans ce projet : un module séparé
  (`smart-revision.js`, `statistics.js`) a du sens quand la logique est
  **pure** (aucune dépendance DOM/state) et **réutilisable par plusieurs
  futurs consommateurs** (dashboard, page dédiée, futur assistant IA,
  future appli mobile). Une logique qui lit/écrit `state` directement n'a
  pas vocation à devenir un module séparé — elle reste dans `index.html`
  comme fonction "pont" (voir `buildChapterFacts()`/`getStatistics()`).
- **Conserver les contrats existants.** Ne pas changer la signature d'une
  fonction déjà appelée à plusieurs endroits sans mettre à jour tous les
  appelants et avoir vérifié qu'aucun ne dépend de l'ancien comportement.
- **Ne pas déplacer du code uniquement pour le déplacer.** Un déplacement
  n'est justifié que s'il réduit un risque réel ou une duplication réelle.

## Pattern architectural déjà en place : "faits → moteur pur → pont → UI"

Observé sur `smart-revision.js`/`statistics.js` et à réutiliser pour toute
future logique de calcul substantielle :

1. **Faits** : une fonction dans `index.html` lit l'état réel
   (`state`, `QUESTIONS`, `CHAPTERS`...) et produit un objet de données
   simple (ex. `buildChapterFacts()`).
2. **Moteur pur** : un module séparé (`window.LyonXxx`) transforme ces
   faits en résultat, sans connaître `state`/le DOM — testable en Node
   sans navigateur.
3. **Pont** : une fonction dans `index.html` appelle le moteur pur et
   expose un point d'entrée simple (`getStatistics()`,
   `getSmartRevisionRecommendations()`).
4. **UI** : les fonctions `renderX()`/`attachXEvents()` consomment
   uniquement le pont, jamais le moteur pur directement.

## Pattern de rendu déjà en place

`render()` dispatche sur `state.tab` : chaque onglet a sa paire
`renderX()` (retourne une chaîne HTML) / `attachXEvents()` (attache les
listeners après `content.innerHTML = ...`). Les écrans à sous-états
(quiz, flashcards, examen) ajoutent un `state.xScreen`/`state.xView`
interne. Une nouvelle fonctionnalité avec plusieurs écrans doit suivre ce
même pattern (voir `state.statsView = {view, subjectId, chapterId}` pour
« Mes statistiques »), pas en inventer un autre.

## Persistance

Toujours passer par `lsGet(key)`/`lsSet(key, value)` (jamais
`localStorage` directement) et par les constantes `KEY_*` déjà déclarées.
Voir `supabase-auth-data` pour le mécanisme de scoping par compte que ces
deux fonctions appliquent automatiquement.
