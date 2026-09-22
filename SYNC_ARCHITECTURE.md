# ÉTAPE 3 — Couche de synchronisation

Brightspace n'est plus codé dans le frontend. Il est devenu **un adaptateur
parmi d'autres**, branché sur un moteur qui ne sait pas ce qu'est un LMS.

```
ExternalSource        Brightspace (ou Moodle, ou autre — hors de notre portée)
      │
      ▼
SourceAdapter         source-adapters.js    listContainers() / listItems()
      │
      ▼
NormalizedData        content-sources.js    { source, externalId, fingerprint… }
      │
      ▼
SyncEngine            sync-engine.js        diff · retry · curseur · journal
      │
      ▼
Store                 createSupabaseStore() upsert idempotent, jamais de delete
      │
      ▼
Supabase              subjects · chapters · sync_runs
      │
      ▼
REV-EM                l'état local est réhydraté depuis Supabase
```

## Fichiers

| Fichier | Lignes | Rôle |
|---|---|---|
| `sync-engine.js` | 865 | moteur générique : diff, réessais, annulation, curseur, journal, stores |
| `source-adapters.js` | 195 | registre `ContentSource` + contrat d'adaptateur + adaptateur Brightspace |
| `content-sources.js` | +25 | inchangé sauf `sourceUpdatedAt` (nouveau champ exigé) |
| `supabase/migrations/003_sync_layer.sql` | 143 | `source_updated_at`, index uniques non partiels, statuts du journal |
| `tests/sync-engine.test.js` | 587 | 122 vérifications, sans réseau ni base |
| `tests/sync-ui.test.js` | 244 | 29 vérifications du branchement réel dans la page |
| `supabase/tests/sync_idempotency_tests.sql` | 367 | 18 vérifications sur PostgreSQL réel |
| `index.html` | −144 / +101 | **le frontend a rétréci** : la logique est partie dans le moteur |

## Ce qui a été retiré du frontend

L'ancien bloc de synchronisation faisait 164 lignes : appels API,
normalisation, diff, écritures, journal, gestion d'erreurs, le tout entrelacé.
Le bloc qui le remplace en fait 105, dont la moitié de commentaires et de
traduction du rapport pour l'affichage. Au total `index.html` perd 144 lignes
et en gagne 101 (dont 10 de balises `<script>` et 4 pour le bouton
d'annulation). Ce qui subsiste est du branchement :

```js
LyonSync.createEngine({
  adapter: bsAdapter(),                                     // quelle source
  store:   LyonSync.createSupabaseStore(client, userId, …), // où écrire
  journal: LyonSync.createSupabaseJournal(client, userId),  // où tracer
}).run({ signal, onProgress });
```

Aucune ligne d'`index.html` ne connaît encore l'API Brightspace.

## Ajouter une source, plus tard

```js
LyonSourceAdapters.register(LyonSourceAdapters.defineAdapter({
  id: "moodle", label: "Moodle", syncable: true,
  listContainers: async (ctx)            => [ /* NormalizedData */ ],
  listItems:      async (ctx, container) => [ /* NormalizedData */ ],
}));
```

Ni le moteur ni `index.html` ne changent. **Moodle et Google Classroom ne sont
pas développés** : ils ne sont pas enregistrés, `get("moodle")` renvoie `null`,
et rien dans l'interface ne les propose. Le test n°11 vérifie explicitement
cette absence — et vérifie aussi qu'une source entièrement étrangère à
Brightspace se synchronise avec le même moteur, ce qui est la seule preuve
réelle que l'abstraction tient.

## Les dix comportements demandés

| Demandé | Où | Comment |
|---|---|---|
| Création | `diff.created` → `store.createContainer/Item` | upsert idempotent |
| Mise à jour | `diff.updated` | seuls les champs de la source sont réécrits |
| Modification | empreinte de contenu (`fingerprint`) | un contenu inchangé n'est pas réécrit |
| Suppression | `diff.removed` → `markRemoved` | **marquée, jamais effacée** |
| Déduplication | `external_id` + index unique | deux barrières indépendantes |
| Synchronisation partielle | conteneur inaccessible → `unavailable` | le reste continue |
| Erreurs | rapport typé, jamais d'exception depuis `run()` | message utilisateur, pas de trace technique |
| Retry | `withRetry`, backoff 500 ms → 1 s → 2 s | seulement sur les erreurs qui le méritent |
| Annulation | `signal.aborted` + points de contrôle | journal `cancelled`, curseur conservé |
| Reprise | curseur `{ doneKeys }` écrit après chaque conteneur | les cours déjà traités ne sont pas re-téléchargés |

### Champs portés par chaque élément externe

`source`, `external_id`, `user_id`, `last_synced_at`, `source_updated_at`,
`sync_status` — plus `external_type` et `source_meta.fingerprint`.

`source_updated_at` vaut **`null`** quand la source ne fournit pas de date : on
ne la remplace jamais par la date d'import, ce qui ferait passer une absence
d'information pour un fait. Elle est volontairement **exclue de l'empreinte** :
certains LMS la touchent sans que le contenu change, et cela déclencherait des
mises à jour fantômes.

## L'idempotence, concrètement

Deux garanties **indépendantes**, parce qu'une seule ne suffit pas :

1. **Le diff** compare par `external_id` : un cours déjà présent n'est jamais
   recréé. Suffisant tant qu'un seul client écrit.
2. **La base** porte `unique (user_id, source, external_id)` et l'écriture
   passe par `on conflict … do update`. Même deux onglets synchronisant en même
   temps ne peuvent pas produire deux copies.

La migration 003 a dû rendre ces index **non partiels** : PostgreSQL ne peut pas
déduire un index partiel depuis `on conflict (a, b, c)` sans que la requête
répète le prédicat, ce que le client Supabase ne sait pas exprimer. L'upsert
était donc impossible, et il fallait lire-puis-insérer — avec une fenêtre de
course entre les deux. Un index non partiel donne ici exactement la même
garantie : deux `NULL` ne sont pas égaux dans un index unique PostgreSQL, donc
les contenus manuels et PDF (sans `external_id`) restent libres de se répéter.
Le test n°4 du fichier SQL le vérifie.

## Deux défauts trouvés par les tests

Ils n'ont pas été trouvés en relisant le code, mais en l'exécutant.

1. **Une exécution annulée restait « reprenable » pour toujours.** Après une
   annulation puis une synchronisation complète, la suivante repartait du
   curseur de l'annulation et **sautait des cours** — qui n'auraient donc
   jamais été rafraîchis. Corrigé : seule la **dernière** exécution est
   examinée, et elle n'est reprise que si elle est restée ouverte ou annulée.

2. **Deux journaux successifs pouvaient produire des lignes de même
   identifiant**, et `finish()` clôturait alors la mauvaise. Corrigé par un
   compteur partagé. Ce défaut ne touchait que le journal en mémoire (les
   tests et les futures sources locales) — la base, elle, génère des UUID.

## Tests

| Suite | Vérifications | Résultat |
|---|---|---|
| `tests/sync-engine.test.js` — logique du moteur | 122 | **0 FAIL** |
| `tests/sync-ui.test.js` — branchement dans la page | 29 | **0 FAIL** |
| `supabase/tests/sync_idempotency_tests.sql` — PostgreSQL réel | 18 | **0 FAIL** |
| `supabase/tests/rls_tests.sql` — non-régression après 003 | 335 | **0 FAIL** |
| test navigateur de l'étape précédente — non-régression UI | 42 | **0 FAIL** |

Les neuf scénarios exigés, et ce qu'ils vérifient réellement :

| Scénario | Vérifié |
|---|---|
| Première synchronisation | 2 matières + 3 chapitres, tous les champs obligatoires présents, journal `completed` |
| Deuxième synchronisation | 0 création, 0 mise à jour, tout reconnu « inchangé » |
| Doublons | 10 exécutions → 1 copie, identifiants locaux inchangés |
| Modification | le titre suit la source, **le quiz et la progression de l'élève survivent** |
| Suppression | ligne conservée et marquée `removed`, chapitres conservés, disparition non re-signalée, réapparition = réactivation sans doublon |
| Utilisateurs A/B | lignes séparées, A ne peut ni lire, ni modifier, ni supprimer celles de B |
| Interruption | annulation au milieu du 2ᵉ cours : journal `cancelled`, curseur = `["101"]`, rien de perdu |
| Reprise | le cours déjà traité est **ignoré et non re-téléchargé**, le reste est importé, aucun doublon |
| Erreur réseau | panne passagère rattrapée par le réessai ; panne persistante → `partial` ; panne initiale → `failed` ; erreur d'autorisation → **aucun réessai inutile** |

Deux scénarios non demandés mais nécessaires ont été ajoutés : exécutions
concurrentes (une seconde synchronisation est refusée ; une exécution
abandonnée depuis plus de 15 minutes est reprise, pas bloquée) et respect du
contrat d'adaptateur.

## À exécuter dans Supabase

Dans l'ordre, SQL Editor :

1. `supabase/migrations/003_sync_layer.sql`
2. `supabase/tests/sync_idempotency_tests.sql` → la ligne `RÉSUMÉ` doit dire `0 FAIL`
3. `supabase/tests/rls_tests.sql` (non-régression) → `0 FAIL`

La migration 003 est idempotente et non destructive. Elle renomme le statut
`running` en `started` : si tu as déjà lancé des synchronisations, leurs lignes
sont converties, pas supprimées.

## Statut

| | |
|---|---|
| Architecture `ExternalSource → SourceAdapter → NormalizedData → SyncEngine → Supabase → REV-EM` | **PASS** |
| Abstraction `ContentSource` (manual / pdf / brightspace), extensible | **PASS** |
| Moodle et Google Classroom non développés | **PASS** (absence vérifiée par test) |
| Création / mise à jour / modification / suppression / déduplication | **PASS** |
| Synchronisation partielle, erreurs, retry, annulation, reprise | **PASS** |
| Champs obligatoires sur chaque élément externe | **PASS** |
| Upsert idempotent (10 synchronisations → 1 copie) | **PASS** — prouvé en JS **et** sur PostgreSQL réel |
| Journal started / completed / partial / failed / cancelled | **PASS** |
| Pas de réécriture massive du frontend | **PASS** — `index.html` : −144 / +101 lignes, aucune autre fonctionnalité touchée |
| Les 9 scénarios de test exigés | **PASS** — 122 + 29 + 18 vérifications, 0 FAIL |
| Comportement contre le **vrai** Brightspace | **NOT TESTED** — aucun tenant accessible ; les noms de champs D2L restent à confronter (`BRIGHTSPACE_SETUP.md`) |
| Migration 003 appliquée sur **ton** projet Supabase | **NOT TESTED** — nécessite ton accès |
| Reprise après fermeture réelle du navigateur | **PARTIAL** — le mécanisme (curseur en base, délai de péremption de 15 min) est testé de bout en bout avec un journal réel en mémoire et vérifié en SQL, mais jamais avec un onglet réellement tué en cours d'import |
| Volumétrie réelle (centaines de ressources, pagination) | **NOT TESTED** — la pagination par signet existe dans l'Edge Function, elle n'a jamais reçu de vraie réponse paginée |
