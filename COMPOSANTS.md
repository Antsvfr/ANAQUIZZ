# REV-EM — Bibliothèque de composants

Ce document décrit les composants réutilisables de REV-EM : à quoi chacun
sert, quand ne PAS l'utiliser, et sous quel nom l'appeler.

Il complète `DIRECTION_ARTISTIQUE.md` (les principes) et ne le répète pas.
Les tokens sont ceux du design system posé à l'étape 3 : **aucun composant
ici n'introduit une valeur littérale de couleur, de taille ou d'espace.**

- **Source unique** : tous les styles vivent dans le `<style>` d'`index.html`.
  Il n'existe pas de second système.
- **Galerie vivante** : `components.html` lit ce `<style>` au chargement et
  rend tous les composants côte à côte. Si un composant change, la galerie
  change ; si la galerie casse, l'application est cassée.
- **Vérification** : `tests/components.test.mjs` (181 vérifications, dans un
  vrai navigateur, à 1440 / 768 / 375).

---

## 1. Les quatre catégories de surface

C'est la décision la plus structurante du système. **Tout ne va pas dans une
carte.**

| Catégorie | Classe | Ce que c'est | Ce que ce n'est pas |
|---|---|---|---|
| **Surface principale** | `.surface` | Le fond de l'écran. Ivoire, aucune bordure, aucune ombre, aucun rayon. | Une page n'est pas une carte. |
| **Feature block** | `.block.block--feature` (alias : `.card`) | Une unité fonctionnelle autonome : un formulaire, un lecteur de quiz, une matière, une séance. | Un paragraphe, un bouton isolé, un chiffre seul. |
| **Information block** | `.block.block--info` | De l'information à lire. Pas de boîte : la typographie et l'espace la détachent. Variante `.is-aside` pour une mise à l'écart (filet de gauche). | Une carte décorative. |
| **Action block** | `.block.block--action` | Un regroupement d'actions : bas de formulaire, barre de sélection. Aplat creusé, sans ombre. Modificateurs : `.is-end`, `.is-between`, `.is-bare`, et `.is-spacer` sur un élément vide pour pousser les actions à droite. | Un endroit où glisser aussi du texte explicatif long. |

**Règle** : une carte représente une vraie unité logique. Si le contenu
n'est ni manipulable ni autonome, c'est un *information block*.

### Garde-fou contre les cartes imbriquées

Il est appliqué par le CSS, pas seulement par la discipline :

- un feature block **dans** un feature block perd son ombre ;
- au **troisième** niveau, il perd sa boîte entière (fond, bordure, padding).

À ce stade, le regroupement doit se faire par l'espace et la typographie.

---

## 2. Hiérarchie des actions — cinq niveaux, aucun sixième

| Niveau | Nom canonique | Alias historique | Usage |
|---|---|---|---|
| PRIMARY | `.btn.btn--primary` | `.btn.red` | L'action de l'écran. **Une seule.** Rouge emlyon. |
| SECONDARY | `.btn.btn--secondary` | `.btn.outline` | Action alternative importante. Surface blanche + filet. |
| TERTIARY | `.btn.btn--tertiary` | `.btn-text` | Action discrète, annulation. Sans aplat. |
| LINK | `.link` | — | Navigation légère. Variantes `.link--quiet`, `.link--external`. |
| DESTRUCTIVE | `.btn.btn--destructive` | `.btn.danger` | Suppression. Rouge d'erreur **en texte** ; l'aplat (`.solid`) n'apparaît qu'en confirmation. |

Les deux noms fonctionnent : les noms canoniques ont été **ajoutés** aux
sélecteurs existants, ils ne les remplacent pas. Rien n'a régressé.

- **Tailles** : `.small` (32) · défaut (40) · `.large` (48). Le 48 est réservé
  à l'action unique d'un état vide ou d'un bloc focal. Pas de bouton énorme.
- **Pointeur grossier** : toute cible passe à 44 px (`@media (pointer: coarse)`).
- **Désactivé** : perd sa couleur d'action et doit dire pourquoi (`title`).
- **Chargement** : `.is-loading` — le libellé s'efface, la largeur ne saute pas.
- **Un lien navigue, il n'agit pas.** S'il agit, c'est un bouton.

---

## 3. Titres

| Classe | Rôle |
|---|---|
| `.eyebrow` | Sur-titre en chasse fixe : la catégorie. Un repère, pas une décoration. |
| `.t-page` | Titre de page (serif Newsreader). |
| `.t-section` | Titre de section. |
| `.t-block` | Titre d'un bloc. |
| `.t-sub` | Sous-titre : il **explique** le titre, il ne le répète pas. |
| `.page-head` | L'en-tête de page : sur-titre, titre, sous-titre — et rien d'autre. |
| `.section-head` | Marqueur de section : libellé en chasse fixe + filet jusqu'au bord. Aucune boîte. |

Au-delà de quatre niveaux, c'est que la page a besoin d'être découpée, pas
d'un cinquième niveau.

---

## 4. Badges et statuts — deux composants, souvent confondus

- `.badge` — **classe** l'objet : niveau, matière, type, nombre. Stable.
  Variantes : `.badge--outline`, `.badge--accent`, `.badge--count`.
- `.status` — dit son **état** : à commencer, à réviser, maîtrisé, en erreur.
  Il évolue. Variantes : `.neutral`, `.warning`, `.success`, `.error`.

Un objet peut porter les deux ; il ne porte jamais deux statuts.
**La couleur ne porte jamais seule l'information** : le libellé la double
toujours.

---

## 5. Séparateurs

`.divider` (+ `.divider--tight`, `.divider--vertical`), `.list-ruled` pour une
liste filetée entre ses lignes.

Un filet sépare deux choses de **même nature**. Entre deux natures
différentes, c'est l'espace qui sépare.

---

## 6. Champs

Ordre imposé : **libellé, champ, aide, erreur.** Le libellé est au-dessus —
jamais un placeholder à la place d'un libellé.

| Classe | Rôle |
|---|---|
| `.field` / `.field-row` | Conteneur d'un champ / de deux champs côte à côte (ils retombent l'un sous l'autre en compact). |
| `.field-label` | Libellé (`.is-optional` pour « facultatif »). |
| `.input` / `.select` / `.textarea` | Les trois contrôles. Même rayon, même filet, même hauteur (40 px). |
| `.field-hint` | Aide sous le champ. |
| `.field-error` | Message d'erreur. |
| `.choice` | Case à cocher / bouton radio — la cible cliquable est le libellé entier. |

Les champs historiques `.ai-select` / `.ai-textarea` **rejoignent cette
famille** : leur ancienne définition a été supprimée, pas dupliquée. Le
chevron de liste déroulante est réservé aux vrais `<select>` — `.ai-select`
est aussi posée sur des `<input>` dans la bibliothèque, et leur coller une
flèche serait un mensonge visuel.

**Erreur** : la bordure rouge ne porte jamais l'information seule.
`.field-error` l'écrit et `aria-invalid="true"` la dit aux lecteurs d'écran.

---

## 7. Encadrés

`.callout` + un ton : `.info`, `.warning`, `.success`, `.error`.
Un seul composant, quatre tons. Titre optionnel : `.callout-title`.

Le détail technique va derrière un `<details>`, jamais dans le flux.

---

## 8. Mesures

- `.stat` / `.stat-label` / `.stat-value` — **le chiffre clé, sans boîte.**
  `.stat-row` les aligne, séparés par un filet.
  (La barre historique `.statbar > .stat` garde sa boîte : elle appartient à
  la barre, pas au chiffre.)
- `.meter` / `.meter-fill` — une seule famille pour toutes les progressions.
- `.segmented` — contrôle segmenté, à la place des pastilles à emoji.

---

## 9. Menus

`.menu`, `.menu-label`, `.menu-item`, `.menu-sep` — même famille que les
menus de l'en-tête.

---

## 10. Chargement — trois formes, trois durées

| Composant | Quand |
|---|---|
| `.skeleton` (`.text`, `.title`, `.block`) | On connaît la forme du contenu attendu. |
| `.spinner` (`.spinner--sm`, `.spinner--lg`) | Attente courte et localisée. |
| `.loading-line` | Attente longue — on écrit ce qui se passe. |

---

## 11. États vides et erreurs

Même ossature, deux tons :

- `.empty` — il n'y a rien **encore** : on dit quoi faire.
  `.empty-icon`, `.empty-title`, `.empty-text`, `.empty-actions`.
- `.empty.is-error` — quelque chose a **échoué** : on dit quoi, et on réessaie.
- `.empty--inline` — variante compacte, dans un bloc, pas sur une page entière.

**Une erreur ne dit jamais seulement « une erreur est survenue ».**
Une erreur de champ ou de ligne dans le flux, elle, reste un `.callout.error`.

---

## 12. Survols de page

### Modale

`.modal-backdrop` > `.modal` (`.modal--wide`, `.modal--confirm`), avec
`.modal-head`, `.modal-title`, `.modal-body`, `.modal-foot`, `.modal-close`.

Le fond assombrit **sans flouter** (pas de glassmorphism). En compact, la
modale s'ancre en bas et son pied empile ses actions.

Les modales du calendrier (`.cal-modal-backdrop` / `.cal-modal`) appartiennent
désormais à cette famille : leurs définitions concurrentes ont été supprimées.

### Confirmation — `dsConfirm()`

```js
const ok = await dsConfirm({
  title: "Supprimer « Marketing » et ses 12 chapitres ?",
  body: "Les fiches, quiz, flashcards et l'historique seront perdus.",
  confirmLabel: "Supprimer la matière",
  cancelLabel: "Garder",
  tone: "destructive",          // sinon : confirmation neutre
});
```

- `role="alertdialog"`, `aria-modal`, nommée par son titre ;
- focus **piégé** dans la modale, `Échap` et clic sur le fond répondent « non » ;
- le focus part sur l'action **la moins risquée** ;
- le texte passe par `textContent` : aucun HTML injecté ;
- **le titre nomme la conséquence**, pas l'action : « Supprimer 12 flashcards ? »,
  jamais « Êtes-vous sûr ? ».

Déjà branchée sur les quatre suppressions de la bibliothèque (matière,
chapitre, flashcard, question). Les `window.confirm()` restants sont
toujours valides : les deux mécanismes ne se gênent pas, la migration des
écrans restants est une étape ultérieure.

### Toast — `showToast()`

```js
showToast("Fiche enregistrée.");
showToast("12 flashcards générées.", "success");
showToast("La génération a échoué.", "error");
```

Un toast annonce un **fait accompli**, brièvement. Il ne pose jamais de
question et ne porte jamais une erreur bloquante — celle-là reste dans la
page. `role="status"` + `aria-live="polite"`.

Le nom historique `.app-toast` est conservé : il désigne le même composant.

---

## Règles transversales

- **Responsive** : deux seuils seulement, ceux du système — 1024 (tablette) et
  640 (compact). En compact, les barres d'actions et les pieds de modale
  empilent leurs boutons sur toute la largeur.
- **Accessibilité** : focus clavier visible sur tous les composants
  interactifs ; cibles de 44 px au doigt ; couleur jamais seule porteuse
  d'information ; contrastes AA vérifiés par les tests.
- **Mouvement** : `prefers-reduced-motion` retire les animations des modales,
  des spinners, des squelettes et des toasts — les composants, eux, restent.
- **Performance** : aucun composant n'ajoute de dépendance, de police, ni
  d'image ; la seule ressource embarquée est le chevron des `<select>`, en
  SVG inline dans le CSS.
- **Aucune décoration sans fonction.** Chaque ombre, chaque filet, chaque
  rayon distingue une nature d'objet d'une autre.
