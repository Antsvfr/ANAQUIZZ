# REV-EM — Direction artistique

**Statut : spécification.** Aucun code n'a été modifié. Ce document est la
référence à appliquer, et la seule source de vérité des valeurs visuelles.

---

## L'idée directrice

REV-EM ne sert pas à « faire des quiz ». Il sert à **savoir où l'on en est** :
ce qui est acquis, ce qui est fragile, quoi faire ensuite.

Toute l'identité découle de là : **un instrument de mesure académique**.
La rencontre de deux registres, et de deux seulement —

- **l'ouvrage** : autorité, lisibilité, silence, sérif pour la pensée ;
- **l'instrument** : graduation, chiffre juste, chasse fixe pour la mesure.

Ce n'est pas un thème décoratif. C'est un critère de tri : **tout élément qui
ne relève ni de la lecture ni de la mesure n'a pas de raison d'exister.**

### Les cinq règles qui priment sur tout le reste

1. **Une décision par écran.** Un écran répond à une question.
2. **L'autorité vient de l'espace, jamais de la graisse.**
3. **Une carte désigne un objet, jamais un regroupement.**
4. **Le rouge est une signature, pas une couleur d'interface.**
5. **Rien de décoratif.** Si on ne sait pas dire à quoi sert un élément, il saute.

### Le test de la première impression

> *Un professeur d'emlyon voit cet écran par-dessus l'épaule d'un étudiant.
> Pense-t-il « c'est un outil » ou « c'est un projet d'étudiant » ?*

Trois éléments répondent avant le contenu : **les emojis**, **la graisse
généralisée**, **le bandeau rouge**. Ils sont traités en premier.

---

# 1. Typographie

Trois familles, **trois rôles exclusifs**. Une famille ne sort jamais de son rôle.

| Famille | Rôle exclusif | Pourquoi celle-ci |
|---|---|---|
| **Newsreader** | display, titres de page et de section, question de quiz, titres dans les fiches | sérif éditorial contemporain, variable, excellente gestion des accents français ; apporte l'autorité académique sans raideur classique |
| **Public Sans** | toute l'interface : corps, libellés, boutons, navigation, formulaires | grotesque neutre conçu pour l'administration publique : lisible, institutionnel, sans signature « startup » |
| **IBM Plex Mono** | **uniquement** : chiffres, compteurs, graduations, micro-libellés en capitales, dates courtes | apporte le registre « instrument » et garantit des chiffres de largeur constante |

**Ce qui disparaît : Inter.** C'est la police par défaut du template SaaS ; elle
interdit toute reconnaissance.

### Chargement (contrainte : aucun build dans ce projet)

Un seul appel Google Fonts, sous-ensemble latin, `display=swap`, avec
`preconnect` vers `fonts.gstatic.com`. Graisses strictement limitées :
Newsreader 400/600, Public Sans 400/500/600, Plex Mono 400/500.
Pile de repli : `Newsreader, Georgia, serif` · `"Public Sans", system-ui, sans-serif`
· `"IBM Plex Mono", ui-monospace, monospace`.

> À valider à l'étape 3 sur du texte réel : l'aspect d'une police se juge en
> composition, pas sur un échantillon. Si Newsreader s'avère trop contrastée
> en petit corps, replis retenus : **Source Serif 4**, puis **Literata**.

### Échelle typographique — 10 rôles, pas 45 tailles

| Token | Desktop | Mobile | Famille / graisse | Interligne | Usage |
|---|---|---|---|---|---|
| `--t-display` | 40px | 32px | Newsreader 600 | 1.15 | salutation du dashboard, score final |
| `--t-h1` | 30px | 24px | Newsreader 600 | 1.2 | titre de page — **un seul par écran** |
| `--t-h2` | 20px | 18px | Public Sans 600 | 1.3 | titre de section |
| `--t-h3` | 16px | 16px | Public Sans 600 | 1.4 | titre d'objet (carte, ligne) |
| `--t-body` | 16px | 15px | Public Sans 400 | 1.6 | texte d'interface |
| `--t-body-sm` | 14px | 14px | Public Sans 400 | 1.55 | texte secondaire, aide |
| `--t-caption` | 13px | 13px | Public Sans 500 | 1.4 | métadonnée |
| `--t-label` | 11px | 11px | Plex Mono 500, `+0.08em`, capitales | 1.2 | sur-titre de section, unité |
| `--t-data-xl` | 40px | 32px | Plex Mono 400, tabulaire | 1 | chiffre clé |
| `--t-data` | 20px | 18px | Plex Mono 500, tabulaire | 1.2 | chiffre courant |

**Règles absolues**

- Le corps ne descend **jamais** sous 15px. Le plancher de lisibilité est 13px
  (métadonnées uniquement).
- **Trois graisses au total** : 400, 500, 600. Le 700 et le 800 sont supprimés.
  *(État actuel : 88 % du texte en 700-800.)*
- Tout chiffre destiné à être comparé ou qui change en direct est en
  `font-variant-numeric: tabular-nums`.
- Pas de `text-transform: uppercase` en dehors de `--t-label`.
- Une page ne porte qu'un seul `--t-h1`.
- La longueur de ligne est bornée : 68 caractères en lecture, 90 en interface.

---

# 2. Palette

Base **ivoire / encre / blanc**. Le rouge emlyon est une **signature**, pas une
couleur d'interface.

### Neutres — la base

| Token | Valeur | Usage |
|---|---|---|
| `--ivory` | `#FBFAF8` | fond de page. Chaud, papier — jamais le gris bleuté des dashboards |
| `--surface` | `#FFFFFF` | cartes, modales, champs |
| `--ink` | `#16161A` | texte principal, titres. **Jamais `#000`** |
| `--ink-2` | `#4A4A52` | texte secondaire |
| `--ink-3` | `#8A8A93` | métadonnée, texte désactivé, icônes au repos |
| `--rule` | `#E8E5E0` | filet standard (1px) |
| `--rule-strong` | `#D6D2CB` | filet accentué : survol, champ au focus |
| `--wash` | `#F4F2EE` | aplat très léger : survol de ligne, en-tête de tableau |

### Signature

| Token | Valeur | Usage — et **rien d'autre** |
|---|---|---|
| `--red` | `#E31C3D` | action primaire · onglet actif · marque |
| `--red-press` | `#B4152F` | état pressé |
| `--red-wash` | `#FDF2F4` | fond d'une ligne sélectionnée (jamais un bloc entier) |

**Le rouge n'est jamais** : un fond d'en-tête, un sur-titre de section, un
badge de statut, un avatar vide, une couleur de graphique.

### Fonctionnelles — trois, et justifiées

| Token | Valeur | Rôle unique |
|---|---|---|
| `--attention` | `#A66A00` | ocre profond : « fragile », « à revoir », avertissement |
| `--success` | `#1F6B4D` | vert forêt : réponse correcte, objectif atteint |
| `--danger` | `#B3261E` | terre cuite : erreur bloquante, action destructive |

Chacune dispose d'un aplat à 6 % pour les encadrés. **Jamais** employées comme
fond de bouton, sauf `--danger` en confirmation destructive.

### Données

Une **rampe graphite unique** à 5 pas pour tout ce qui est volume ou
progression : `#EDEAE5` → `#C9C5BE` → `#9A958C` → `#5C5850` → `#2A2721`.

Les graphiques n'utilisent aucune couleur : la rampe porte la quantité, le
rouge marque **une seule chose** — la période courante ou la cible.

### La gamme de rouges — un ton par niveau d'organisation

> Révisé après la pose du système : le rouge ne marque plus seulement
> « l'action ». Il marque **à quel étage de l'interface on se trouve**. Plus
> le ton est franc, plus le niveau est haut — on lit la structure d'un écran
> sans lire un mot.

| Ton | Niveau | Ce qu'il marque |
|---|---|---|
| `--accent` `#E31C3D` | **1 · l'écran** | le filet qui ouvre la page, l'onglet courant, l'action principale, le panneau prioritaire |
| `--accent-2` `#EA526C` | **2 · la section** | le repère devant un `.section-title` ou un `.section-head-label` |
| `--accent-3` `#F0899A` | **3 · le groupe** | le libellé d'un panneau (`.dash-panel-label`) |
| `--accent-4` `#F5ADB9` | **4 · l'information** | une définition, un point clé, le cours en cours, l'en-tête d'un tableau — ce qui est mis en avant *à l'intérieur* d'un groupe |

Trois garde-fous, sans lesquels la gamme redeviendrait de la décoration :

- **Un ton ne porte jamais l'information à lui seul.** À chaque niveau, la
  position et la typographie disent déjà de quoi il s'agit (un titre de
  section est un titre ; un libellé de panneau est en chasse fixe). Le ton ne
  fait que confirmer — c'est pourquoi le niveau 4 peut être clair sans rien
  coûter en lisibilité.
- **Les tons clairs n'écrivent jamais de texte.** Un texte rouge reste
  `--accent` (4,67:1 sur blanc). Les niveaux 2 à 4 ne servent que pour des
  filets et des repères.
- **Une donnée n'est pas un niveau d'organisation.** Les jauges, les barres de
  progression et les graphiques gardent `--accent` plein.

Vérifié par `tests/pages.test.mjs` §1 bis : la gamme existe, elle s'éclaircit
strictement d'un niveau à l'autre, chaque niveau emploie son ton, et aucun
texte n'est écrit dans un ton clair.

### Règles de couleur

1. **Trois occurrences de rouge maximum par écran**, une idéalement.
   *(Assoupli : la gamme ci-dessus ajoute des repères structurels, qui ne
   comptent pas comme des « occurrences » — un filet de 2 px n'attire pas
   l'œil comme un aplat. La règle continue de valoir pour les APLATS.)*
2. **Aucun dégradé**, à deux exceptions près : un voile vertical ivoire →
   blanc sur l'en-tête au défilement, et la bannière du tableau de bord
   (voir ci-dessous). Pas de glassmorphism, pas de néon, pas de flou
   décoratif.
3. **La couleur ne porte jamais seule une information** : toujours doublée d'un
   libellé, d'une icône ou d'une position. *(Aujourd'hui : badges de semestre
   gris / noir / rouge sans signification.)*
4. Aucun gris pur : tous les neutres portent une pointe chaude.
5. `0 %` n'est pas un avertissement. Un début se dit en neutre.

### La bannière du tableau de bord — et son plafond de clarté

C'est le seul aplat de marque du produit : un dégradé diagonal à quatre
arrêts, `#5E0A18 → #8E1128 → #B81430 → #D8193A` à 118°, plus deux voiles
radiaux (un clair très faible en haut à droite, un sombre en bas à gauche) et
une trame de points d'un pixel tous les 22 px. Tout est en CSS : pas d'image,
pas de flou, pas de filtre, pas de 3D — coût de rendu nul.

**Le dégradé a un plafond de clarté, et ce n'est pas un choix esthétique.**
Le texte de la bannière est blanc. Le contraste WCAG du blanc tombe sous
4,5:1 dès que le fond dépasse une luminance relative de 0,183 — c'est-à-dire
dès qu'il devient plus clair que le rouge de marque `#E31C3D` (0,175). Une
version antérieure montait jusqu'à `#F2566B` : mesuré sur les pixels
réellement peints, le sous-titre tombait à 3,4:1 et les étiquettes des
mesures à 2,3:1.

D'où trois règles :

- **aucun arrêt du dégradé plus clair que `#E31C3D`** ;
- **le voile clair et la trame comptent** : un point blanc sous une lettre,
  c'est du contraste en moins. Ils sont volontairement à .07 et .13 ;
- **aucun blanc translucide pour le texte.** Sur ce rouge, un blanc à 66 %
  donne 2,3:1. Une `opacity` sur le texte revient exactement au même, en plus
  d'échapper aux audits qui lisent la couleur calculée. La hiérarchie se fait
  par la **typographie** — taille, graisse, chasse, capitales — jamais par
  l'opacité.

Toute retouche du dégradé, du voile ou de la trame doit être **re-mesurée** :
`tests/dashboard.test.mjs` masque le texte, photographie le fond réellement
peint, relève le pixel le plus clair sous chaque libellé et calcule le
rapport. Le seuil retenu est 4,5:1 pour tout le texte de la bannière, y
compris les grands titres auxquels WCAG n'imposerait que 3:1.

### Mode sombre

Hors périmètre v1, mais **les tokens sont structurés pour l'accueillir** :
`--ivory` → `#131210`, `--surface` → `#1B1A18`, `--ink` → `#F2F0EC`, rouge
éclairci à `#FF4D68` pour tenir le contraste. Aucune valeur en dur ne doit
rendre cette bascule impossible.

---

# 3-4. Hiérarchie

### Titres

```
PAGE        label mono  ·  H1 sérif 30px  ·  description body-sm  ·  actions à droite
SECTION     label mono + filet horizontal  ·  H2 20px
OBJET       H3 16px dans la carte ou la ligne
```

Le sur-titre de section (`--t-label`, mono, capitales, `--ink-3`) suivi d'un
filet qui court jusqu'au bord **remplace la carte comme marqueur de section**.
C'est le geste structurel principal de cette direction : il permet de supprimer
la majorité des boîtes sans perdre la lecture.

### Textes

| Niveau | Token | Couleur | Rôle |
|---|---|---|---|
| Principal | `--t-body` | `--ink` | ce que l'utilisateur doit lire |
| Secondaire | `--t-body-sm` | `--ink-2` | explication, aide contextuelle |
| Métadonnée | `--t-caption` | `--ink-3` | date, compteur, provenance |
| Micro-libellé | `--t-label` | `--ink-3` | unité, sur-titre, graduation |

**Un seul niveau secondaire par bloc.** Si trois niveaux de gris cohabitent,
le bloc est mal découpé.

---

# 5. Boutons

Quatre variantes. Pas de cinquième. *(État actuel : 13 variantes, dont 114
liens texte gris sur 223 actions — l'interface n'a pas de direction.)*

| Variante | Fond | Filet | Texte | Emploi |
|---|---|---|---|---|
| **Primaire** | `--red` | — | blanc | l'action de la section. **Une seule** |
| **Secondaire** | `--surface` | 1px `--rule-strong` | `--ink` | action alternative |
| **Discret** | — | — | `--ink` | action tertiaire, annulation |
| **Danger** | — (aplat rouge en modale) | — | `--danger` | destruction, après confirmation |

**Dimensions** — hauteurs 32 / 40 / 48. Le 48 est réservé à l'action unique
d'un état vide ou du bloc focal. Rayon 8px. Padding horizontal 18px (md).
Graisse 500. Cible tactile minimale 44px sur mobile.

**Règles**

- Jamais de flèche `→` accolée. *(91 occurrences aujourd'hui.)*
- Jamais d'emoji.
- Icône facultative, 16px, à gauche, uniquement si elle clarifie.
- Jamais pleine largeur, sauf pied de feuille mobile.
- Un bouton désactivé **dit pourquoi** (titre au survol, ou phrase à côté).
- États : repos → survol (`--rule-strong` / assombrissement 4 %) → pressé
  (`--red-press`, `translateY(1px)`) → focus (anneau 2px `--red` à 2px d'écart).

---

# 6. Cartes

**Une carte désigne un objet.** Un cours, un chapitre, une matière, un examen
passé, un événement. Rien d'autre.

*(État actuel : 245 conteneurs, 62 classes « card », des cartes dans des cartes.)*

**Anatomie** — fond `--surface`, filet 1px `--rule`, rayon 12px, padding 20px,
`--shadow-xs` au repos.
**Survol** — filet `--rule-strong`, `--shadow-sm`, `translateY(-1px)`, 120ms.
**Structure interne** — visuel ou icône (facultatif) · H3 · une ligne de
métadonnée · une mesure · pied d'actions secondaires.

**Interdits**

1. **Une carte ne contient jamais une carte.**
2. Une carte n'est jamais un conteneur de section.
3. Les cartes d'une même rangée ont la même hauteur (pied ancré en bas).
4. Une carte cliquable l'est **en entier** — pas via un lien de 12px dans un
   coin. Si la carte est cliquable, elle ne contient pas de bouton primaire.

---

# 7. Encadrés

**Un seul composant**, quatre tons. *(État actuel : 11 classes d'erreur, 10
d'état vide.)*

Filet vertical de 2px dans la couleur du ton · fond à 6 % · icône tracée 16px ·
titre `--t-h3` · corps `--t-body-sm` · au plus une action discrète.

| Ton | Quand |
|---|---|
| Information | contexte utile, jamais bloquant |
| Attention (`--attention`) | quelque chose demandera une décision |
| Succès (`--success`) | confirmation persistante (un toast suffit sinon) |
| Danger (`--danger`) | échec, perte possible, action irréversible |

**Un encadré par région d'écran.** Le détail technique va derrière un
`<details>` « Détails », jamais dans le flux.

---

# 8. Séparateurs

L'espace sépare. Le filet est l'exception, et n'a que trois emplois :

1. **Sous-ligne de section** : le sur-titre mono, puis un filet jusqu'au bord.
2. **Séparation de lignes** dans une liste (jamais autour de la liste).
3. **Base de l'en-tête** au défilement.

1px, `--rule`. Jamais deux filets à moins de 24px l'un de l'autre. Jamais un
filet là où 32px de vide suffisent.

---

# 9. Icônes

Un seul jeu, **dessiné dans le produit** : `DASH_ICONS` / `dashIcon(name)`
dans `index.html` — tracé 1,6px, grille 24, extrémités arrondies, aucune
surface pleine. Pas de sprite ni de dépendance : douze icônes suffisent
aujourd'hui, et une icône inconnue ne rend rien plutôt que d'injecter quoi
que ce soit. **Plafond : une trentaine.**

*(La note précédente annonçait Lucide via un sprite `<use>` ; ce n'a jamais
été intégré, et un jeu maison de douze tracés évite une dépendance pour un
besoin de cette taille. Le geste visé reste celui de Lucide.)*

Elles sont **toujours décoratives** : le libellé à côté porte le sens,
l'icône le confirme. D'où `aria-hidden="true"` systématique — sans quoi un
lecteur d'écran annoncerait deux fois la même chose.

- Tailles : 16 (dans le texte), 20 (boutons, navigation), 24 (états vides).
- Couleur : toujours `currentColor`. Jamais de remplissage, jamais deux tons.
- Une icône ne remplace jamais un libellé dans la navigation.

### Emojis — la règle

**Zéro emoji dans l'interface.** Ni dans les titres, les boutons, les libellés,
les états vides, les notifications, les cartes, la navigation.
Seule exception : le contenu saisi par l'utilisateur.

*(État actuel : 474 occurrences, 82 emojis distincts. C'est le signal numéro un
du « projet étudiant ».)*

---

# 10. États

### Vide — un composant unique

Icône tracée 24px (`--ink-3`) · titre `--t-h3` · **une** phrase `--t-body-sm`
qui dit quoi faire · un bouton primaire · éventuellement une action discrète.
Hauteur minimale 240px, centré dans la section, **sur l'ivoire — pas dans une
carte**.

Un état vide est une adresse à l'utilisateur, pas un trou. *(Aujourd'hui :
« Mes matières » et « Mes statistiques » sont vides à 85-90 %.)*

### Chargement

**Des squelettes, pas des tourniquets.** Le squelette reprend la géométrie
réelle du contenu attendu : aplat `--wash`, rayon identique, pulsation
d'opacité 1,2 s (pas de balayage lumineux).
Le tourniquet est réservé à l'intérieur d'un bouton en attente.
En dessous de 300 ms, on n'affiche rien.

### Erreur

Encadré « danger » : **ce qui s'est passé · ce qu'on peut faire · une action**.
Jamais de message technique brut. Le détail va derrière « Détails ».

### Succès

Un toast. Jamais une carte, jamais un encadré persistant.

### Désactivé

Opacité 0,45 · `cursor: not-allowed` · **une raison lisible**.
*(Aujourd'hui : 4 actions grisées sur l'écran Assistant sans aucune explication.)*

### Focus

Anneau 2px `--red`, décalé de 2px, `border-radius` hérité. Visible sur fond
clair **et** sur fond encre. Jamais supprimé.

---

# 11. Navigation

Cinq entrées maximum. *(Aujourd'hui : 7 + un sélecteur de langue au même rang.)*

```
Accueil · Matières · Réviser · Planning · Progression
```

« Ressources » et « Import » rejoignent **Matières** (importer un cours, c'est
alimenter ses matières). La langue descend dans le menu du compte.

- Onglet actif : libellé en 500 → 600 + **soulignement rouge 2px**. C'est le
  seul rouge de l'en-tête.
- Menus : chevron 12px tracé, rotation 180° à l'ouverture. Plus de caractère `▾`.
- Panneau : `--surface`, rayon 12, `--shadow-md`, entrée 180ms.
- **Mobile** : feuille latérale pleine hauteur, entrées en 18px, cibles 48px.
  Pas de menu déroulant miniature.

---

# 12. Header

**Le bandeau rouge disparaît.** C'est l'élément le plus visible du produit et
c'est aujourd'hui un aplat saturé qui confisque la couleur signature.

- Hauteur 64px (56 sur mobile), fond `--surface`, filet bas `--rule` **au
  défilement seulement** (au-delà de 8px), avec `--shadow-xs`.
- Gauche : marque. Centre-gauche : navigation. Droite : compte.
- Le contenu s'aligne sur la même grille que la page — pas de pleine largeur
  au-dessus d'une colonne étroite.
- **Correction obligatoire** : à 768px la navigation déborde aujourd'hui
  (« Planning » coupé, compte hors écran).

### Marque

Le carré arrondi rouge portant « EM » est la forme de logo la plus générique
qui soit, et ne porte aucune idée du produit.

**Piste** — un mot-symbole « REV-EM » en Newsreader 600, avec une **graduation**
comme signe : deux à quatre traits verticaux de hauteurs croissantes, en encre,
le dernier en rouge. C'est la mesure, la progression, et un signe qui
fonctionne en 16px comme en favicon. À explorer en trois propositions à
l'étape 3.

### Nom

**Un seul nom : REV-EM.** emlyon est le contexte, pas la marque.
*(Aujourd'hui quatre noms coexistent : « EM Lyon Révision » dans le `<title>`,
« Lyon Révision » dans l'en-tête, « Anaquizz » et « REV-EM » dans les
traductions.)*

---

# 13. Dashboard

Doctrine : **une décision par visite.** L'écran répond à « qu'est-ce que je
fais maintenant ? ».

> **État actuel (à jour).** La composition ci-dessous est la doctrine
> d'origine ; elle a été révisée deux fois depuis. Ce que le code rend
> aujourd'hui :
>
> 1. **la bannière** (aplat de marque, cf. « plafond de clarté » plus haut) :
>    date, salutation, une phrase de contexte vraie, trois mesures réelles ;
> 2. **« Aujourd'hui »** — le planning, devenu la section majeure : barre de
>    navigation (jour précédent / Aujourd'hui / jour suivant) et sélecteur
>    Jour · Semaine · Mois ; en vue jour, le cours en cours sur lavis avec sa
>    jauge et son temps restant, le prochain avec son décompte, puis une
>    **timeline verticale** (colonne d'heures, rail continu, un point par
>    cours à sa couleur, les pauses dites, et le trait rouge de l'heure à sa
>    place réelle) ;
> 3. **« Révision »** — la priorité du moteur, la reprise, les cours récents ;
> 4. **« Ma progression »** — la maîtrise, les quatre mesures, le journal
>    d'activité (« Activité » n'est plus une section à part : les chiffres et
>    ce qu'on vient de faire répondent à la même question) ;
> 5. **« Accès rapides »** — matières puis destinations.
>
> **Une section EST une carte** : fond blanc, filet, rayon, ombre légère, et
> un en-tête toujours composé de la même façon — icône, titre, sous-titre
> d'une ligne, action à droite.
>
> Ce qui évite le « mur de cartes », ce n'est pas d'en mettre moins, c'est
> qu'elles **ne pèsent pas le même poids** : la bannière domine, le planning
> prend toute la largeur, révision et progression se partagent une ligne (la
> révision plus large, parce qu'elle porte l'action), les accès ferment.
> Quatre rangs, pas une grille.
>
> **Règle qui en découle : à l'intérieur d'une carte, plus de carte.** Les
> sous-blocs se séparent par un filet, un aplat ou de l'espace. Le panneau
> prioritaire et le cours en cours sont tenus par un filet accent **à gauche**
> — un seul côté, donc un repère et non une seconde boîte. C'est vérifié à
> chaque exécution par `tests/detail.test.mjs`, qui refuse toute boîte fermée
> sur ses quatre côtés à l'intérieur d'une autre.

```
┌ MERCREDI 23 SEPTEMBRE                    ← label mono
│ Bonjour Anton                            ← display sérif 40px
│
│ ────────────────────────────────────────────────────────
│  LE GESTE DU JOUR                        ← bloc focal, sur ivoire
│  Reprendre « L'échantillonnage »         ← H2
│  Tu as 3 notions fragiles sur ce chapitre. ← body-sm
│  [ Commencer ]  Voir mes matières        ← 1 primaire + 1 discret
│ ────────────────────────────────────────────────────────
│
│ MESURE                                   ← label + filet
│   68 %        342         7 j        12 h 20
│   maîtrise    questions   série      révisé
│   (mono 40px, séparés par des filets verticaux — aucune boîte)
│
│ MES MATIÈRES                             ← label + filet
│   [carte]  [carte]  [carte]              ← objets : cartes justifiées
│
│ ACTIVITÉ RÉCENTE                         ← label + filet
│   ligne · ligne · ligne                  ← liste à filets, pas de carte
```

**Supprimé** : le hero en dégradé bleu→rouge ; les six tuiles « Actions
rapides » (doublon de la navigation) ; le bouton flottant 🤖 et son animation
de rebond ; la mention « localStorage ».

*(Le dégradé est revenu, en rouge et sous condition — voir « La bannière du
tableau de bord ». Les destinations rapides sont revenues aussi, mais en
liste d'actions et non en tuiles : elles ne doublent plus la navigation,
elles donnent accès à ce que la navigation ne montre pas au premier niveau.)*

**Résultat** : de 8 cartes équivalentes à **1 bloc focal + 3 sections**, dont
une seule emploie des cartes.

---

# 14. Pages internes

Un gabarit unique :

```
label mono          (facultatif)
H1 sérif            un seul
description         une ligne, body-sm, --ink-2
                                          [ actions alignées à droite ]
─────────────────── 48px ───────────────────
SECTION 1           label + filet
contenu
─────────────────── 56px ───────────────────
SECTION 2
```

**Deux largeurs, deux intentions** — aujourd'hui 920px ne sert bien ni l'une ni
l'autre :

| Largeur | Pour | Écrans |
|---|---|---|
| **680px** | lire | fiche de cours, réponse de l'assistant, quiz |
| **1200px** | travailler | dashboard, matières, statistiques, planning |

Titres de page **sans emoji** — les trois traitements actuels convergent.
Quatre sections maximum par page ; au-delà, ce sont deux pages.

---

# 15. Modales

- Voile : `--ink` à 40 %, **sans flou**.
- Panneau : `--surface`, rayon 16, `--shadow-md`, padding 28.
  Largeurs : 520 (formulaire) · 720 (contenu).
- En-tête : H3 + bouton de fermeture icône 32px (pas un caractère `×`).
  Filet bas uniquement si le contenu défile.
- Pied : aligné à droite, discret + primaire.
- Entrée 240ms (opacité + `translateY(8px)`), sortie 180ms.
- Échap ferme · focus piégé · focus rendu à l'élément d'origine à la fermeture.
- **Mobile** : feuille basse, rayon 20 en haut uniquement, pleine largeur,
  poignée de glissement.
- Les libellés de champ **ne sont pas en capitales** : `--t-caption` en
  `--ink-2`, au-dessus du champ.

---

# 16. Toasts

- Position : **en bas à gauche** sur desktop (le centre masque le contenu),
  au-dessus de la zone sûre sur mobile.
- Aspect : fond `--ink`, texte blanc, rayon 10, padding 12/16, `--shadow-md`,
  largeur maximale 360.
- Contenu : une ligne, plus éventuellement une action (« Annuler »).
- Durée 4 s. Un seul à la fois, les suivants font la queue.
- **Jamais pour une erreur qui demande une décision** — c'est un encadré.

---

# 17. Assistant IA

L'écran le plus chargé du produit aujourd'hui. Il devient le plus calme.

- **Plus de bouton flottant.** Entrée par la navigation et par un point d'appel
  contextuel dans un chapitre.
- Colonne de lecture 680px.
- Les six pastilles à emoji deviennent un **contrôle segmenté** à libellés mono,
  sur une seule ligne.
- **Indisponibilité** : une phrase, et un lien « Pourquoi ? » qui déplie
  l'explication. Les cinq puces de dépannage technique — pilotes graphiques,
  accélération matérielle — quittent le chemin principal.
- Réponses : typographiques, interligne 1.7, marquées par un filet vertical
  `--rule-strong` à gauche.
- Les actions indisponibles affichent leur raison, au lieu d'être grisées en
  silence.

---

# 18. Planning

- Grille en filets, **aucune cellule pleine**.
- Aujourd'hui : point rouge + date en mono. Seul rouge de l'écran.
- Événement : filet vertical 3px (rampe graphite, ou `--attention` si échéance
  proche) + titre 14px. Pas de pastille colorée.
- Trois événements maximum par cellule, puis « +2 » en mono.
- Vue semaine par défaut ; bascule semaine/mois en contrôle segmenté.
- Mobile : liste chronologique, jamais une grille compressée.

---

# 19. Quiz

Mode attention : la navigation s'efface (le mécanisme existe déjà), seule la
progression demeure.

- Question : **Newsreader 24px**, colonne 680px.
- Réponses : lignes pleine largeur séparées par des filets — **pas des boîtes**.
  Survol `--wash` · sélection : filet gauche 2px `--red` + graisse 500.
- Progression : filet 2px + compteur mono « 7 / 20 ».

### L'exception rouge, assumée

Dans **l'écran de quiz uniquement**, le rouge signale l'erreur :
correct = `--success`, incorrect = `--red`. C'est le seul endroit où le rouge
n'est pas l'action — et c'est cohérent, parce qu'un étudiant doit voir son
erreur instantanément. **Contrepartie obligatoire** : dans cet écran, le bouton
« Suivant » passe en **secondaire**. Jamais deux rouges concurrents.

- Correction : filet + icône + une phrase d'explication. Pas de confettis, pas
  d'emoji, pas d'animation de célébration.
- Résultat : chiffre mono 40px, une phrase de verdict, deux actions.

---

# 20. Fiches de cours

C'est le seul endroit où REV-EM est un **document**. Il se comporte comme tel.

- Colonne 680px, corps **17px / 1.7** (plus grand que l'interface).
- Titres internes en Newsreader.
- **Aucune carte autour du document.** Le document est la page.
- Notions clés : liste de définitions séparées par des filets — pas des chips.
- Sommaire ancré à gauche sur desktop, repliable ; en haut et replié sur mobile.
- Une seule action flottante en bas de colonne : « Lancer le quiz ».

---

# 21. Flashcards

- Une carte centrée : largeur max 560, hauteur min 320, rayon 16, `--shadow-sm`.
- Question en Newsreader 24px · réponse en Public Sans 17px.
- Retournement : `rotateY` 420ms — la seule animation longue du produit,
  parce qu'elle **est** l'interaction. En `prefers-reduced-motion`, fondu 160ms.
- Commandes : trois boutons discrets à libellés mono —
  `DIFFICILE` · `CORRECT` · `FACILE`. Pas de vert/rouge, pas d'emoji.
- Progression : « 12 / 40 » en mono + filet.

---

# 22. Statistiques

Pas de grille de cartes : **une suite de sections**.

- Chiffres clés : mono 40px, micro-libellé mono au-dessus, séparés par des
  filets verticaux.
- Graphiques : axes en filets, **rampe graphite uniquement**, rouge réservé à
  la période courante ou à une cible. Pas de barres arrondies, pas de dégradé,
  pas de grille plus lourde que `--rule`.
- **Chaque graphique porte sa clé de lecture** en une phrase :
  « Tu révises surtout le soir, 4 jours sur 7. » Un graphique qui ne se
  commente pas en une phrase ne mérite pas d'être affiché.

---

# Règles transversales

## Espaces blancs

Grille de **8px**. Échelle : `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96`.

| Entre | Desktop | Mobile |
|---|---|---|
| Haut de page → titre | 48 | 32 |
| Titre → première section | 40 | 28 |
| Section → section | 56 | 40 |
| Titre de section → contenu | 16 | 16 |
| Éléments d'une même liste | 12 | 12 |
| Intérieur de carte | 20 | 16 |

**Le principe qui décide** : l'espace **au-dessus** d'un élément est toujours
plus grand que l'espace **à l'intérieur** du groupe auquel il appartient.
C'est ce qui regroupe, sans aucune bordure.

> Aujourd'hui, 97 `margin-top` sont injectés en style inline depuis le
> JavaScript : l'espacement n'est pas gouverné. Il doit l'être par le CSS,
> exclusivement.

## Densité d'information

- **Sept unités d'information maximum** par région d'écran.
- Un écran = une question.
- Plus de quatre sections ⇒ deux pages.
- Deux niveaux d'imbrication maximum, jamais trois.

## Composition

- Un point focal par écran, dans le quadrant supérieur gauche.
- Tout est aligné à gauche. Le centrage est réservé aux états vides et aux toasts.
- Trois colonnes d'alignement au maximum.
- Les actions de page sont en haut à droite ; les actions d'objet dans l'objet.

## Animations

| Durée | Pour |
|---|---|
| 120ms | micro-interaction : survol, focus, pression |
| 180ms | changement d'état, sortie |
| 240ms | entrée : modale, panneau, toast |
| 420ms | retournement de flashcard — **seule exception** |

Courbes : entrée `cubic-bezier(.2,.8,.2,1)` · sortie `cubic-bezier(.4,0,.6,1)`.

- On n'anime que `opacity` et `transform` (plus `background`/`border-color` au
  survol). **Jamais** la mise en page — sauf les barres de progression.
- Aucune boucle infinie, aucun rebond, aucune pulsation décorative.
  *(Le rebond du bouton flottant disparaît avec lui.)*
- `prefers-reduced-motion` : toute animation devient un fondu de 120ms ou rien.
  Le mécanisme existe déjà et doit être conservé.

### Micro-interactions retenues — parce qu'elles informent

1. Carte au survol : `translateY(-1px)` + filet accentué. Dit « cliquable ».
2. Bouton pressé : `translateY(1px)`. Dit « reçu ».
3. Barre de progression : transition sur la largeur, 400ms. Dit « ça avance ».
4. Chiffre qui change : fondu 180ms, jamais de compteur défilant.
5. Ligne de liste au survol : fond `--wash`. Dit « c'est cette ligne ».
6. Chevron de menu : rotation 180°. Dit « ouvert / fermé ».

Rien d'autre. Tout effet qui n'informe pas est retiré.

---

# Gouvernance

Cette direction n'a de valeur que si elle est **la seule source de valeurs**.

1. **Aucune valeur en dur** de taille, couleur, rayon, ombre ou espacement dans
   le CSS ou le JavaScript. Tout passe par un token.
   *(Point de départ : 405/414 `font-size` et 115/200 `border-radius` hors
   tokens.)*
2. **Aucun style inline généré en JavaScript**, sauf une valeur calculée
   (largeur d'une barre de progression).
3. Un nouveau composant n'existe que si aucun composant existant ne convient —
   et il rejoint alors ce document.
4. Les tests existants (147 vérifications d'interface) doivent rester au vert à
   chaque étape : cette refonte est visuelle, elle ne retire aucune
   fonctionnalité.

### Cibles mesurables

| Indicateur | Aujourd'hui | Cible |
|---|---|---|
| Noms de produit | 4 | **1** |
| Emojis d'interface | 474 | **0** |
| Tailles de texte | 45 | **10** |
| Graisses | 5 (88 % en 700-800) | **3** |
| Rayons | 23 | **2** (8 contrôles · 12-16 surfaces) |
| Variantes de bouton | 13 | **4** |
| Conteneurs | 245 | **≈ 60** (objets uniquement) |
| États vides | 10 | **1** |
| Classes d'erreur | 11 | **1** |
| Seuils responsive | 13 | **3** (≤ 640 · ≤ 1024 · > 1024) |
| Transitions distinctes | 56 | **4 durées, 2 courbes** |
| Familles de police | 1 (Inter) | **3 à rôle exclusif** |

---

# Ordre d'application recommandé

Chaque étape conditionne la suivante, et chacune produit un effet visible seule.

1. **Identité** — un nom, une marque, le header dérougi.
2. **Typographie** — les trois familles, l'échelle, la fin du gras généralisé.
3. **Icônes** — sprite Lucide, suppression des 474 emojis.
4. **Couleur** — ivoire/encre, le rouge remis à sa place.
5. **Structure** — sur-titres et filets à la place des cartes ; dashboard refait.
6. **Composants** — bouton, carte, encadré, état vide, modale, toast.
7. **Écrans** — quiz, fiches, flashcards, statistiques, planning, assistant.
8. **Responsive** — trois seuils, correction du débordement à 768px.

Les trois premières suffisent à faire basculer la première impression. Les
suivantes la rendent durable.
