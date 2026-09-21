---
name: premium-ui
description: Standard visuel et d'interaction pour toute nouvelle interface d'ANAQUIZZ. À consulter quand on crée ou modifie un écran, un composant, une carte, un état vide/erreur, ou une animation.
---

# Premium UI

## Priorités, dans cet ordre

1. **Compréhension** — l'utilisateur doit savoir où il est et ce qu'il
   regarde en quelques secondes.
2. **Efficacité** — le chemin le plus court vers l'action utile.
3. **Simplicité** — pas d'élément dont l'utilité n'est pas évidente.
4. **Cohérence** — avec le reste d'Anaquizz, pas juste en interne à l'écran.
5. **Esthétique** — soignée mais jamais au prix des priorités précédentes.
6. **Innovation** — bienvenue seulement une fois 1 à 5 acquis.

**« Premium » ne signifie pas ajouter des effets partout.** Une interface
premium est d'abord une interface qui ne fait jamais hésiter l'utilisateur.

## Design system observé (vérifié dans index.html, tout en CSS inline)

Aucun fichier CSS séparé — tout vit dans le `<style>` d'`index.html`.
Variables CSS déjà définies en tête de fichier, à réutiliser systématiquement
plutôt que d'introduire de nouvelles couleurs/tailles :

- **Couleurs** : `--bg`, `--surface`, `--surface-2`, `--border`,
  `--border-strong`, `--ink`, `--ink-soft`, `--muted`, `--navy*`, `--red*`
  (couleur d'accent principale du produit), `--amber*`, `--green*`, `--blue*`.
- **Rayons** : `--radius-xl` (18px), `--radius-lg` (14px), `--radius-md`
  (10px), `--radius-sm` (7px).
- **Ombres** : `--shadow-xs`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`.
- **Transition** : `--ease` (`cubic-bezier(.22,.9,.32,1)`) — la seule
  courbe d'easing utilisée dans tout le projet, ne pas en introduire une
  autre sans raison.
- **Typographie** : `--font-main`/`--font-heading` (Inter).

## Namespaces CSS par fonctionnalité (pattern déjà établi, à suivre)

Chaque fonctionnalité récente a son propre préfixe de classes CSS, pour ne
jamais risquer de casser une autre fonctionnalité en partageant une classe :
`dash-` (dashboard, le plus ancien/général), `qz-` (quiz premium), `flash-`
(flashcards), `exam-` (mode examen), `lib-` (bibliothèque de cours), `ai-`
(assistant IA), `pg-` (Ma progression), `sr-` (Révision intelligente),
`st-` (Mes statistiques), `badge-` (réussites). **Créer un nouveau préfixe
pour un nouveau composant réellement nouveau ; réutiliser un préfixe
existant seulement pour un composant qui appartient vraiment à cette
fonctionnalité.** Les classes génériques réellement transverses
(`.dash-section`, `.btn`, `.btn-text`, `.m-chip`, `.deckbar-track`) sont
volontairement partagées entre toutes les fonctionnalités — les réutiliser
plutôt que les redéfinir.

## Composants/patterns déjà en place à réutiliser

- Tuiles de synthèse : `.pg-overview` / `.pg-tile` / `.pg-tile-num` /
  `.pg-tile-lbl` (utilisé par « Ma progression » et « Mes statistiques »).
- Badge de maîtrise par tiers : `.m-chip` avec les classes `new`/`critical`/
  `weak`/`good`/`mastered` (voir `masteryTier()` dans index.html).
- Barre de progression : `.deckbar-track`/`.deckbar-fill`.
- Liste d'éléments cliquables avec puce + titre + sous-texte + flèche :
  `.pg-review-list`/`.pg-review-item`.
- États vides positifs (jamais un simple "0" ou "rien") : voir
  `renderStatsEmptyState()`/la branche `!hasAnyData` de `renderSmartHome()`
  dans index.html pour le ton attendu.
- Badge de confiance sur donnée limitée : `.sr-confidence`, affiché
  seulement quand `confidence` vaut `"insufficient"`/`"low"` (voir
  `smart-revision`), jamais partout.

## Exigences non négociables

- Hiérarchie visuelle claire : un titre, un sous-titre, des sections
  identifiables (`.dash-section` + `.section-title`).
- États loading/error/empty/success explicitement gérés pour tout
  contenu asynchrone ou dépendant de données — jamais un écran figé sans
  explication.
- Feedback immédiat sur toute action (clic, sélection, validation).
- Mobile-first en pratique : tester d'abord à 375px de large, jamais
  seulement réduire une mise en page desktop.
- Zones tactiles ≥ 44×44px environ (déjà vérifié systématiquement par
  test sur les fonctionnalités récentes — voir `testing-code-review`).
- Accessibilité (voir `i18n-accessibility-responsive`) : focus visible,
  labels compréhensibles, contraste suffisant.

## Animations et micro-interactions

- Toujours enveloppées dans `@media (prefers-reduced-motion: no-preference)`
  pour les transitions/hover ; prévoir l'état statique équivalent sous
  `@media (prefers-reduced-motion: reduce)` quand une animation porte une
  information (ex. `.st-weekbar-fill{ transition:none; }`).
- Une animation doit servir la compréhension ou le feedback — jamais
  décorative seule. Avant d'ajouter une animation, se demander : qu'est-ce
  que l'utilisateur comprend de mieux grâce à elle ?
- Durée courte (~0.14–0.4s), la même courbe `--ease` partout.

## Éviter la duplication visuelle

Avant de créer un nouveau bloc/carte, vérifier si un bloc existant montre
déjà une information équivalente ailleurs dans l'app (ex. le dashboard a
DÉJÀ une carte « Ma progression » avec mastery/chapitres/questions/temps —
« Mes statistiques » n'a donc reçu qu'un second lien dans cette même
carte plutôt qu'un nouveau bloc redondant). Deux widgets qui répondent à
la même question pour l'utilisateur doivent être fusionnés, pas multipliés.
