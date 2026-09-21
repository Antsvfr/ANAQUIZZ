---
name: i18n-accessibility-responsive
description: Système de traduction (translations.js), accessibilité et responsive. À consulter avant d'ajouter un texte utilisateur, une nouvelle vue, ou de toucher au CSS responsive.
---

# i18n, Accessibility & Responsive

## Système de traduction (`translations.js`, `window.LyonI18n`)

- 5 langues : `fr` (défaut), `en`, `es`, `de`, `it`. 355 clés par langue à
  ce jour, **parité stricte obligatoire** — toute clé ajoutée dans une
  langue doit l'être dans les 5, sans exception.
- API : `t(key, vars)`, `setLang(lang)`, `getLang()`, `onChange(fn)`,
  `localeTag()`, `flag(lang)`.
- Placeholders : `{nomDeVariable}` dans la chaîne, remplacé via
  `t(key, {nomDeVariable: valeur})` (voir `t()` dans `translations.js` —
  remplacement littéral par `split/join`, pas de pluralisation
  automatique : une variable numérique s'accompagne souvent d'une légère
  imprécision grammaticale acceptée dans ce projet plutôt que doubler les
  clés pour singulier/pluriel).
- Si une clé manque dans la langue courante, `t()` retourne la version
  française ; si elle manque partout, elle retourne **la clé brute
  elle-même** — un texte du genre `stats.foo_bar` visible à l'écran est
  donc un signal fiable d'oubli à corriger.
- Espaces de noms déjà utilisés (préfixe avant le premier point) :
  `nav`, `dashboard`, `progress`, `smart`, `stats`, `quiz`, `settings`,
  `myspace`, `account`, `auth`, `greeting`, `lang`, `date`. Une nouvelle
  fonctionnalité crée son propre préfixe (ex. `stats.*`), cohérent avec ce
  pattern.

## Règle absolue

**Toute nouvelle chaîne visible par l'utilisateur passe par
`t("namespace.cle", vars)`** — jamais de chaîne française en dur dans une
nouvelle fonction de rendu, jamais de `if(lang === "fr")`, jamais un
deuxième système de traduction. Exception assumée et déjà en place : le
contenu pédagogique lui-même (matières, chapitres, questions, fiches,
flashcards, cours importés par l'utilisateur ou l'IA) n'est **jamais**
traduit automatiquement — ce n'est pas l'objet de ce système.

## Ne jamais concevoir pour une longueur de texte fixe

L'allemand en particulier produit des chaînes nettement plus longues que
le français pour un même sens — un composant qui a l'air bien en français
peut déborder en allemand. Toujours tester au moins l'allemand (`de`) sur
tout nouveau composant texte-sensible (carte, bouton, tuile).

## Responsive

- Pas de fichier CSS séparé : tout vit dans le `<style>` d'`index.html`.
- Breakpoints déjà utilisés dans le projet (les reprendre plutôt que d'en
  introduire un nouveau sans raison) : `max-width:375–420px` (petit
  mobile), `480–600px`, `680px` (le plus fréquent — bascule mobile
  générale), `760–860px` (tablette), `min-width:900px`.
  Tester au minimum : petit iPhone (~375px), grand iPhone (~390–430px),
  tablette (~800px), desktop (≥1280px).
- Aucun débordement horizontal, aucun texte coupé, aucune carte trop
  large, aucun bouton inaccessible — vérifier concrètement
  (`element.scrollWidth > element.clientWidth`), pas seulement
  visuellement.

## Accessibilité

- Focus clavier visible sur tout élément interactif nouveau.
- `aria-label` sur les éléments dont le rôle n'est pas évident par le
  texte visible seul (icônes seules, zones cliquables sans libellé).
- Contraste suffisant — réutiliser les couleurs déjà définies (`--ink`,
  `--ink-soft`, `--muted` sur `--surface`/`--bg`, voir `premium-ui`),
  jamais une couleur inventée à la volée pour du texte.
- Zones tactiles suffisamment grandes (~44×44px), en particulier sur
  mobile.
- `@media (prefers-reduced-motion: reduce)` : toute animation qui porte
  une information doit avoir un équivalent statique sous cette requête
  (voir `premium-ui` pour le pattern déjà en place).
- Une information importante ne doit jamais reposer **uniquement** sur un
  graphique/une couleur — toujours une forme textuelle équivalente
  disponible (ex. un pourcentage affiché en chiffres à côté de l'anneau
  de maîtrise, pas seulement la portion colorée).
