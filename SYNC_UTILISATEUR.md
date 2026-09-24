# Persistance multi-appareils — l'espace de l'élève suit son compte

> À ne pas confondre avec [`SYNC_ARCHITECTURE.md`](SYNC_ARCHITECTURE.md), qui
> décrit l'import de contenu **venu d'un LMS** vers REV-EM. Ce document-ci
> décrit le voyage de ce que l'élève **produit dans REV-EM** entre ses
> appareils. Deux problèmes différents, deux moteurs séparés, aucun couplage.

```
Appareil A                                     Appareil B
    │                                              │
  lsSet(clé, valeur)                          connexion
    │                                              │
  cloudNoteLocalWrite()                       cloudStart()
    │                                              │
  LyonUserData.push(domaines)  ──►  Supabase  ──►  pullAll()
   (différé, regroupé)              auth.uid()     │
                                     + RLS         cloudApplySnapshot()
                                                   │
                                              state → interface
```

## Ce qui a changé

**Avant :** le compte servait à afficher un prénom. Les données de révision
vivaient dans le `localStorage` du navigateur, cloisonnées par identifiant de
compte depuis un correctif précédent — donc jamais mélangées entre comptes,
mais jamais partagées entre appareils non plus. Se connecter sur son téléphone
donnait un espace vide.

**Maintenant :** Supabase est la source de vérité. Le `localStorage` reste,
mais comme **cache** : il donne le premier affichage sans attendre le réseau,
et permet de continuer à travailler hors ligne.

Pour un **invité** (pas de compte, ou Supabase non configuré), rien ne change :
le moteur n'est jamais appelé, `localStorage` reste la seule persistance. C'est
un état normal du produit, pas un cas dégradé.

## Les fichiers

| Fichier | Lignes | Rôle |
|---|---|---|
| `user-data.js` | ~780 | le moteur : domaines, lecture, écriture, fusion, suppressions |
| `index.html` | +≈330 | le branchement : hook sur `lsSet`, hydratation, migration, indicateur |
| `auth.js` | +≈150 | renvoi d'e-mail, changement d'adresse, nouveau mot de passe, lecture du lien |
| `supabase/migrations/005_user_sync.sql` | 150 | les clés naturelles qui rendent l'écriture idempotente |
| `tests/user-data.test.mjs` | ~560 | le moteur contre un **PostgreSQL réel**, RLS comprise |
| `tests/account-sync.test.mjs` | ~640 | le branchement dans un **vrai navigateur**, deux appareils |
| `supabase/tests/user_sync_tests.sql` | ~280 | les garanties de la base elle-même |

## Le point de branchement : `lsSet()`

Toute écriture locale passait déjà par `lsSet()`. La synchronisation est
branchée **là**, et pas sur les quinze fonctions `save*()` :

```js
function lsSet(key, value){
  …écriture locale…
  cloudNoteLocalWrite(key);   // ← un seul point de passage
}
```

Conséquence : aucun appel ne peut être oublié, ni aujourd'hui, ni quand une
fonctionnalité sera ajoutée. Une nouvelle donnée n'a qu'à déclarer sa clé dans
`DOMAINS_BY_STORAGE_KEY` pour voyager.

Les écritures sont **différées et regroupées** (900 ms) : terminer un quiz
écrit quatre clés d'affilée, ça ne fait pas quatre allers-retours réseau.

## Les 16 clés locales et leurs 18 tables

| Donnée locale | `state` | Table(s) |
|---|---|---|
| `user-subjects` | `userSubjects` | `subjects` |
| `user-chapters` | `userChapters` | `chapters` |
| `quiz-progress` | `progress` | `progress` (`kind='quiz'`) |
| `flashcard-progress` | `flashProgress` | `progress` (`kind='flashcard'`) |
| `question-stats` | `qstats` | `question_stats` |
| `exam-history` | `exam.history` | `exam_history` |
| `badges` | `badges` | `badges` |
| `ai-flashcards` | `aiCards` | `ai_cards` |
| `course-data` | `courseData` | `course_notes` |
| `planning` | `planning` | `planning_events` + `preferences` |
| `ai-history` | `aiHistory` | `ai_history` |
| `documents` | `documents` | `documents` (**métadonnées seules**) |
| `study-plan` | `studyPlan` | `study_plans` |
| `dashboard-stats` | `dash` | `user_stats` + `daily_stats` + `activities` + `chapter_visits` |
| `ai-bubble-pos` | `aiBubble` | `preferences` |
| `ai-model-choice` | `aiModelChoice` | `preferences` |

### Deux choses qui ne partent volontairement pas

**Le contenu binaire des documents** (jusqu'à ~3 Mo par fichier) reste sur
l'appareil qui l'a importé ; seules les métadonnées voyagent. Sur un autre
appareil, le document est **listé avec son nom** et l'interface dit que son
contenu n'est pas là, au lieu d'ouvrir un fichier vide. Un nom listé vaut mieux
qu'un document invisible, et les deux valent mieux qu'un mensonge.

**`dash.wrongQuestions`** duplique `question_stats`, et sa clé est un **index
positionnel** dans le tableau des questions : insérer une question au milieu du
programme décalerait silencieusement toutes ses entrées. Il est donc
reconstruit à la lecture depuis `question_stats`, dont la clé (`uid`) est un
hash stable du contenu. Le nombre d'échecs consécutifs est exact : c'est le
nombre de zéros en fin d'historique.

## La stratégie de conflit

Trois régimes, choisis selon la **nature** de la donnée.

**1. Ligne par ligne, dernier écrivain gagnant, arbitré par `updated_at`.**
Pour les collections d'objets indépendants : matières, chapitres, notes,
événements, documents, statistiques par question. Modifier le chapitre 3 sur le
téléphone n'écrase pas le chapitre 7 modifié sur l'ordinateur — la granularité
est la ligne, pas le domaine.

**2. Fusion par maximum, pour les compteurs monotones.** Questions répondues,
bonnes réponses, temps passé, meilleure série, quiz terminés, activité
quotidienne, meilleur score par chapitre. Un compteur qui ne fait que monter ne
doit jamais redescendre parce qu'un appareil en retard a écrit sa valeur.
`max(local, distant)` est ici la bonne réponse ; « dernier écrivain gagnant »
serait une perte silencieuse de données.

`correct_streak` — la série **en cours** — n'est pas monotone : elle suit la
dernière écriture, comme il se doit.

**3. Union, pour les journaux.** Activités, historique d'examens, réussites :
ce sont des faits datés. Deux appareils qui en ajoutent chacun produisent
l'union des deux.

### Les suppressions, et le garde-fou

Pousser une collection supprime les lignes absentes de l'instantané — sinon une
matière supprimée sur l'ordinateur ressusciterait sur le téléphone.

Mais **uniquement parmi les clés que cet appareil a réellement vues**
(`knownKeys`, renseigné au pull et à chaque push). Une matière créée sur
l'appareil B après notre dernier pull n'est jamais supprimée par un push de
l'appareil A, qui en ignore l'existence. Sans ce garde-fou, deux appareils
actifs se détruiraient mutuellement leurs créations.

## La migration des données existantes

Jamais silencieuse. À la **première connexion d'un compte sur un appareil**,
si cet appareil contient des données :

1. on **lit** d'abord le compte (pour savoir ce qu'il contient) ;
2. on **demande** ensuite, chiffres à l'appui : « cet appareil contient N
   éléments, ton compte en contient déjà M » ;
3. on **écrit** enfin, selon la réponse.

Trois issues :

| Réponse | Effet |
|---|---|
| **Envoyer vers mon compte** | fusion réelle (maximum / union / ajout), puis relecture |
| **Utiliser mon compte** | le compte fait foi, le cache local est remplacé |
| **Plus tard** | **rien ne part, rien n'arrive** — et le moteur reste désactivé pour la session, pour qu'une écriture ultérieure ne pousse pas « par accident » |

Le choix est mémorisé par compte et par appareil : il n'est pas redemandé à
chaque connexion. Quand l'appareil n'a rien à envoyer, aucune question n'est
posée — il n'y a rien à arbitrer.

## La déconnexion

On **écrit d'abord** ce qui attend, **ensuite seulement** on efface le cache de
ce compte. Purger avant d'avoir poussé perdrait la donnée pour de bon.

Si l'écriture échoue (hors ligne), **le cache est conservé** : perdre le
travail de l'élève serait pire que le laisser sur cet appareil. Vider le cache
n'est une bonne idée que parce que Supabase le détient déjà.

## La sécurité

`user_id` est écrit dans chaque ligne parce que la colonne l'exige, mais il
n'est **jamais** la barrière : les policies RLS comparent `auth.uid()` au
`user_id` de la ligne, côté PostgreSQL. Un `user_id` falsifié depuis le
navigateur fait **échouer** l'écriture, il ne la détourne pas — c'est vérifié
par le test 5 de `tests/user-data.test.mjs`, contre un vrai PostgreSQL.

Aucune clé secrète côté frontend : le module reçoit le client déjà construit
par `auth.js`, à partir de la clé publique (`anon` / `publishable`). Les mots
de passe ne sont jamais manipulés par REV-EM — Supabase Auth les détient, et
aucune colonne de notre schéma n'en contient.

## Ce que les tests prouvent, et ce qu'ils ne prouvent pas

| Suite | Ce qui est RÉEL | Ce qui est remplacé |
|---|---|---|
| `tests/user-data.test.mjs` (113) | PostgreSQL, le schéma, les contraintes, **les policies RLS**, deux identités distinctes, le moteur tel quel | le transport HTTP de PostgREST, la vérification de signature du JWT |
| `tests/account-sync.test.mjs` (101) | Chromium, index.html, auth.js, user-data.js, **deux contextes = deux appareils**, chacun son `localStorage` | le SDK Supabase (données en mémoire, partagées) |
| `supabase/tests/user_sync_tests.sql` (18) | PostgreSQL : unicité, clés étrangères, RLS, cascade | — |

**Ce qu'aucune des trois ne prouve**, et qui exige un vrai projet Supabase et
une vraie boîte mail : qu'un e-mail de confirmation part et arrive, et qu'un
vrai téléphone retrouve les données via le vrai réseau. Voir le rapport de
l'étape.

## Ce qui reste local, et pourquoi

| Donnée | Où | Raison |
|---|---|---|
| PDF importés | IndexedDB | volume (plusieurs Mo par fichier) |
| Contenu des documents | `localStorage` | idem |
| Modèle WebLLM téléchargé | cache du navigateur | plusieurs centaines de Mo |
| Le cache de tout le reste | `localStorage` | premier affichage instantané, travail hors ligne |
