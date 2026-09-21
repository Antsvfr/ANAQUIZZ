---
name: performance-security
description: Performance (DOM, mémoire, réseau, appels Supabase/IA) et sécurité (XSS, secrets, données utilisateur) réellement en place dans le projet. À consulter avant d'ajouter une dépendance, un appel réseau, ou de traiter une entrée utilisateur.
---

# Performance & Security

## Dépendances externes réelles (aucun npm, aucun build)

Le projet n'a pas de `package.json` ni de gestionnaire de paquets. Toute
dépendance externe est soit un `<script src>` CDN chargé au démarrage,
soit un `import()` dynamique chargé **seulement quand nécessaire** :

| Dépendance | Chargement | Usage |
|---|---|---|
| Google Fonts (Inter) | `<link>` eager | Typographie |
| `@supabase/supabase-js` (jsdelivr) | `<script src>` eager | Auth (voir `supabase-auth-data`) |
| `pdfjs-dist` (esm.run) | `import()` différé | Extraction de texte depuis un PDF importé |
| `mammoth` (esm.run) | `import()` différé | Extraction de texte depuis un `.docx` importé |
| `@mlc-ai/web-llm` (esm.run) | `import()` différé, + Web Worker (`ai-worker.js`) | Assistant IA local (voir `ai-system`) |

**Avant d'ajouter une dépendance** : déterminer si une solution existante
ou native suffit. Si une vraie dépendance est nécessaire, suivre le
pattern déjà en place — chargement différé (`import()` seulement au
moment de l'usage réel), jamais un `<script src>` eager pour quelque
chose qui n'est utilisé que sur un chemin rare (ex. l'IA/le parsing de
documents ne se chargent que si l'utilisateur les utilise réellement).

## Performance

- Les moteurs de calcul (`smart-revision.js`, `statistics.js`) sont
  recalculés à la demande, sans cache — voir `smart-revision` pour la
  justification mesurée (quelques ms même sur un historique synthétique
  de centaines de jours). Ne pas ajouter de cache sans avoir mesuré un
  vrai problème.
- `state.dash.recentActivity` est volontairement plafonné à 20 entrées,
  `state.dash.recentChapters` à 8 — pattern déjà utilisé pour éviter de
  parcourir un historique illimité à chaque rendu. Une nouvelle fonction
  qui a besoin d'un historique plus complet doit utiliser une source non
  plafonnée déjà existante quand elle existe (ex.
  `state.dash.dailyStats`/`state.dash.dailyTimeSeconds`, à granularité
  journalière et non bornés, utilisés par `statistics.js` précisément
  pour cette raison) plutôt que d'augmenter arbitrairement la limite d'un
  tableau plafonné.
- Pas de listener dupliqué : `attachXEvents()` est appelé après chaque
  `content.innerHTML = renderX()`, sur du DOM neuf — ne jamais attacher un
  listener global (sur `document`/`window`) plusieurs fois sans protection
  (voir `initStarted` dans `auth.js` pour le pattern de garde).
- Timeout systématique sur tout appel IA (`withGenTimeout`, voir
  `ai-system`) — toute nouvelle opération potentiellement longue doit en
  avoir un équivalent.
- Ne jamais déclencher WebLLM ni un appel réseau juste pour afficher une
  donnée déjà disponible localement.

## Sécurité

- **XSS** : `escapeHtml(s)` est utilisé de façon systématique (>200
  appels dans `index.html`) partout où du texte utilisateur/importé/généré
  par l'IA est inséré dans du HTML — **toute nouvelle interpolation de
  texte dynamique dans un template `innerHTML` doit passer par
  `escapeHtml()`**, sans exception. Aucun `eval()`/`new Function()` dans le
  projet — ne pas en introduire.
- **Secrets** : ne jamais exposer de `service_role key`, de credential ou
  de token privé côté frontend. La clé Supabase `anon` (dans
  `supabase-config.js`) est publique par conception — voir
  `supabase-auth-data` pour le détail. Aucune clé API n'est nécessaire
  pour l'IA (WebLLM tourne en local).
- **Entrées utilisateur** : tout fichier importé (cours, documents) passe
  par une extraction dédiée (voir `course-library-import`) avant d'être
  utilisé — ne jamais faire confiance à un fichier importé pour être bien
  formé.
- **Données utilisateur** : voir `supabase-auth-data` pour le
  cloisonnement par compte (`lsGet`/`lsSet` uniquement, jamais
  `localStorage` directement) et RLS côté Supabase.
