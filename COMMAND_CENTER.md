# Command Center — atteindre n'importe quoi en quelques secondes

`Ctrl + K` (Windows/Linux) · `⌘ + K` (Mac) · ou le bouton loupe dans l'en-tête.

```
index.html                    enregistre les SOURCES
   │                          (elles seules connaissent state et la navigation)
   ▼
command-center.js             normalise · score · classe · regroupe
   │                          (ne sait pas ce qu'est une matière)
   ▼
index.html                    affiche, et exécute l'item choisi
```

## Pourquoi deux moitiés

Le moteur ne connaît ni le DOM, ni `state`, ni la navigation. Il trie des
items par pertinence, et rien d'autre. Conséquence : il se teste sous Node en
quelques millisecondes, sans navigateur — `tests/command-center.test.js`,
60 vérifications.

Les sources, elles, vivent dans `index.html` parce qu'elles doivent lire
`state` et fabriquer l'action à exécuter. C'est le même découpage que
`smart-revision.js` et `statistics.js` : un moteur pur, un branchement.

## Ajouter une source

Rien d'autre à écrire. Ni le moteur ni l'interface ne changent.

```js
LyonCommand.registerSource({
  id: "annales", category: "resources", order: 60, limit: 5,
  collect: (ctx) => annalesDisponibles().map(a => ({
    title: a.titre,
    subtitle: a.matiere,
    meta: a.annee,
    icon: "exam",
    keywords: [a.matiere, a.type],
    run: () => ouvrirAnnale(a.id),
  })),
});
```

Pour que la catégorie s'affiche traduite, ajouter `cc.cat_resources` dans
`translations.js` (les cinq langues). Sans la clé, le libellé retombe sur
l'identifiant plutôt que d'afficher une clé brute.

Ré-enregistrer le même `id` **remplace** la source : au rechargement d'un
écran, on ne veut pas deux fois les mêmes résultats.

### Le contrat d'un item

| Champ | Rôle | Poids dans le score |
|---|---|---|
| `title` | ce que l'utilisateur lit | **1** |
| `keywords[]` | synonymes, nom de la matière parente | 0,9 |
| `subtitle` | contexte (la matière, la description) | 0,62 |
| `meta` | aperçu chiffré, aligné à droite | 0,46 |
| `icon` | clé de `DASH_ICONS` | — |
| `run()` | ce qui s'exécute à l'ouverture | — |
| `suggested` | proposé quand le champ est vide | — |
| `boost` | 0 → 0,15, **borné** | — |

`boost` ne peut jamais faire passer une approximation devant une
correspondance exacte : il est plafonné, appliqué après le score, et le
résultat reste borné à 1. Le test 7 du moteur le vérifie avec un boost de 99.

## Tolérer les fautes, concrètement

Six façons de reconnaître un texte, de la plus sûre à la plus permissive. **La
première qui répond gagne**, et son rang fixe le score — sinon une
approximation passerait devant une correspondance exacte.

| | Tapé | Trouve |
|---|---|---|
| 1. égalité | `maths` | Maths |
| 2. début du texte | `math` | **Math**ématiques |
| 3. début d'un mot | `deriv` | Quiz : **Dériv**ation |
| 4. milieu d'un mot | `rivation` | Dé**rivation** |
| 5. lettres dans l'ordre | `drvtn` | **D**é**r**i**v**a**t**io**n** |
| 6. faute de frappe | `dreivation` | Dérivation |

Les accents sont retirés des **deux** côtés : `derivation` trouve
`Dérivation`, et personne n'a à deviner où les mettre.

La faute de frappe est une distance de Damerau-Levenshtein, comparée **mot à
mot** (comparer à un titre entier donnerait toujours une distance énorme). Les
transpositions comptent pour **une** faute : `dreivation` est une inversion de
doigts, pas deux erreurs. Le budget dépend de la longueur — **aucune faute
tolérée sous 4 lettres**, sinon `bac` trouverait `sac`.

Mesuré : **14,7 ms** pour une recherche approximative sur 1 200 items.

## Les sources livrées

| Source | Ce qu'elle apporte |
|---|---|
| `actions` | commencer une révision, importer un cours, créer une matière, lancer un quiz, examen blanc, planning, statistiques… |
| `pages` | les onze destinations de l'application |
| `subjects` | les matières, avec leur nombre de chapitres |
| `chapters` | les chapitres, avec ce qu'ils contiennent réellement |
| `content` | les quiz et les flashcards, **un par contenu existant** |

### Aucune donnée inventée

Un chapitre **sans** quiz ne produit **aucune** entrée « Quiz ». Une action qui
ne mènerait nulle part n'est pas proposée : « Réviser mes erreurs » n'apparaît
que s'il y a des erreurs. C'est vérifié par `tests/command-ui.test.mjs`, qui
cherche explicitement l'absence de « Quiz : Intégration » pour un chapitre qui
n'en a pas.

### La navigation n'est pas réécrite

Chaque destination passe par `handleNavGoto()`, le **même aiguilleur** que la
barre de navigation. Un seul endroit décide où mène quoi ; le Command Center
ne fait que l'appeler.

## Le clavier

| Touche | Effet |
|---|---|
| `Ctrl/⌘ + K` | ouvrir, ou refermer si déjà ouvert |
| `↑` `↓` | parcourir, **en boucle** |
| `Début` `Fin` | première / dernière ligne |
| `Entrée` | ouvrir la ligne active |
| `Échap` | fermer |
| `Tab` | reste dans le panneau (piège à focus) |

Ils sont **affichés** dans le pied du panneau : un raccourci que personne ne
connaît n'existe pas.

Le raccourci est **neutralisé pendant un examen en cours** — le mode sans
distraction ne doit pas pouvoir être percé.

Déplacer la sélection ne re-rend pas la liste : on déplace une classe. À la
vitesse où l'on tient `↓` enfoncé, reconstruire le DOM à chaque pas se verrait.

## Deux choses que la mesure a corrigées

**Le bouton faisait déborder la barre de navigation.** Mesuré : la barre
n'avait que 46 px de marge, et un bouton « Rechercher · Ctrl K » en fait 175.
Le libellé est donc retiré à toutes les largeurs, et 44 px sont rendus à la
navigation (gouttière et gouttières d'onglets). Piège rencontré au passage :
`.topbar-inner` est plafonné à `--width-work`, donc **un point d'arrêt sur la
largeur de la fenêtre ne sert à rien** — à 1600 px comme à 1280, le budget est
identique. Vérifié dans les cinq langues ; l'allemand, le plus large, garde
6 px de marge.

**Sur mobile, l'en-tête recouvrait le champ de saisie.** Le panneau était à
`z-index: 91`, l'en-tête à 100. Il est maintenant à 211 : au-dessus de
l'en-tête et de la bulle IA (200), en dessous des modales (300), pour qu'une
modale ouverte par-dessus reste lisible.

## Tests

| Suite | Vérifie |
|---|---|
| `tests/command-center.test.js` — 60 | normalisation, les six reconnaissances, l'ordre entre elles, distance d'édition, pondération des champs, registre, classement, plafonds, boost borné, volumétrie |
| `tests/command-ui.test.mjs` — 129 | raccourci réel, focus, ↑↓ en boucle, Entrée qui exécute vraiment (page, chapitre, quiz avec ses vraies questions, action), tolérance aux fautes dans le champ, état vide, accessibilité, 3 largeurs, 5 langues, connecté/déconnecté, navigation intacte, Ctrl+K neutralisé en examen |
