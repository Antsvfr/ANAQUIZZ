# ÉTAPE 5 — Validation du parcours Brightspace

**Aucun code de production n'a été modifié.** Les seuls fichiers touchés sont
des tests et un fichier d'émulation local (détail en fin de document).

---

## Avant tout : ce qui n'a PAS pu être validé, et pourquoi

Deux murs, que je ne peux pas franchir depuis cet environnement.

### 1. Ton projet Supabase est injoignable

```
$ curl https://otlkvlmzakklhugvaxeg.supabase.co/rest/v1/
curl: (56) CONNECT tunnel failed, response 403
```

Le proxy réseau de l'environnement d'exécution refuse la connexion. Je ne peux
donc **rien** affirmer sur :

- si les migrations 001 → 004 ont été appliquées sur ton projet ;
- si les six Edge Functions y sont déployées ;
- si les secrets Supabase y sont renseignés ;
- si `brightspace-callback` y est bien déployée avec `--no-verify-jwt`.

**Ces quatre points sont NOT TESTED et ne peuvent être vérifiés que par toi**
(procédure : `BRIGHTSPACE_SETUP.md`, étape 5).

### 2. Aucun tenant Brightspace n'existe encore

Sans application OAuth enregistrée côté EM Lyon (étape 1 du guide), il n'y a ni
`client_id`, ni `client_secret`, ni consentement possible. Le parcours réel
—  *REV-EM → Brightspace → authentification → autorisation → retour* — **n'a
donc jamais été exécuté contre D2L**, et ne peut pas l'être ici.

Tout ce qui suit teste **notre code**, avec un Brightspace factice au bout du
fil. C'est la limite honnête de cette étape, et elle est rappelée dans l'en-tête
de chaque fichier de test.

---

## Ce qui a été testé pour de vrai

J'ai remplacé le faux client de base de données de l'étape 4 par une **vraie
base PostgreSQL 16.13**, et j'exécute les **vrais fichiers `index.ts`** des six
Edge Functions — leur handler HTTP est appelé avec de vrais objets `Request`,
et leurs vraies `Response` sont inspectées.

| Composant | Réel ? |
|---|---|
| Les six Edge Functions (`index.ts` importés tels quels) | **réel** |
| PostgreSQL : schéma, contraintes, FK, RLS, privilèges de colonnes | **réel** |
| Atomicité des `UPDATE`, concurrence entre deux connexions | **réel** |
| Chiffrement AES-GCM, signature HMAC du `state` | **réel** |
| Navigateur Chromium, `localStorage`, console | **réel** |
| Historique Git complet | **réel** |
| **Brightspace (D2L)** | **factice** ← la limite |
| **Supabase Auth** (vérification de signature JWT) | **factice** |
| **PostgREST**, déploiement, secrets Supabase | **non exercés** |

> Le runtime Deno n'étant pas installable ici (téléchargement bloqué), les
> fonctions tournent sous Node avec retrait de types. Le code exécuté est
> identique ; ce qui n'est pas exercé, c'est Deno lui-même.

---

## Les dix scénarios demandés

`tests/oauth-integration.test.mjs` — **130 vérifications, 0 FAIL**.

| # | Scénario | Ce qui a été réellement constaté | Statut |
|---|---|---|---|
| 1 | Utilisateur connecté | `brightspace-connect` répond 200, produit une URL `auth.brightspace.com/oauth2/auth` avec `redirect_uri` pointant sur l'Edge Function, scopes tous en `:read`, aucun secret dans l'URL. Le nonce est **réellement en base**, rattaché au bon compte, non consommé, avec expiration | **PASS** |
| 2 | Utilisateur non connecté | Les 5 fonctions protégées répondent **401** sans jeton, sans détail technique. Un jeton d'un utilisateur inexistant est refusé. **Aucun** `state` n'est créé | **PASS** (la vérification de signature JWT est celle de Supabase, non exercée) |
| 3 | Autorisation acceptée | Code échangé en **Basic Auth**, `grant_type=authorization_code`, appel `whoami` effectué, ligne écrite avec `status=connected`, compte Brightspace identifié, **les deux tokens chiffrés en base**, nonce consommé, redirection `?brightspace=connected` | **PASS** |
| 4 | Autorisation refusée | Redirection `?brightspace=denied`, **0 connexion enregistrée**, **0 appel réseau**, le nonce reste utilisable pour une nouvelle tentative | **PASS** |
| 5 | Callback invalide | 7 variantes testées : sans code, `state` forgé, `state` d'un autre compte, rejeu, `state` périmé **en base**, échange refusé, application sans refresh token. Dans **tous** les cas : jamais `connected`, jamais de ligne écrite | **PASS** |
| 6 | Token expiré | Échéance réellement périmée en base → `brightspace-status` rafraîchit, la connexion redevient vérifiée, l'échéance est repoussée, le verrou relâché | **PASS** |
| 7 | Refresh token | L'ancien refresh token est présenté, **le nouveau est stocké** (rotation), `refresh_count` avance, `brightspace-refresh` ne renvoie **aucun token** au navigateur. `invalid_grant` → 409 + `reconnectRequired` + statut `expired` en base | **PASS** |
| 7b | Deux rafraîchissements simultanés | Deux appels réellement concurrents, chacun sur sa connexion PostgreSQL : **un seul** échange de refresh token, les deux aboutissent, connexion jamais marquée expirée à tort | **PASS** |
| 8 | Déconnexion | Connexion et secrets supprimés ; **matière et chapitre importés conservés**, passés en `unavailable`, fiche de l'élève intacte ; l'API refuse ensuite proprement (409 `not_connected`) ; `revokedAtProvider: false` annoncé honnêtement | **PASS** |
| 9-10 | Utilisateurs A et B | Deux connexions distinctes, tokens différents. Sous RLS réelle : A ne voit que sa ligne, B que la sienne. A ne peut **pas** lire son propre token (privilège de colonne), ni écrire chez B, ni lire les nonces. La déconnexion de A ne touche pas B | **PASS** |

---

## Les vérifications de sécurité exigées

`tests/security-audit.test.mjs` — **125 vérifications, 0 FAIL**.

### Aucun secret dans le frontend — **PASS**

Les 12 fichiers servis au navigateur sont scannés pour : JWT Supabase,
`sb_secret_`, clés privées, jetons porteurs en dur, affectations de
`BRIGHTSPACE_CLIENT_SECRET` et de `BRIGHTSPACE_TOKEN_ENC_KEY`. Aucun résultat.

### Aucun token sensible dans localStorage — **PASS, avec une réserve**

Méthode : j'installe un faux client Supabase dont l'Edge Function **renvoie
volontairement des valeurs-appâts** ressemblant à des tokens, puis je fais
tourner dans Chromium les parcours réels (vérification, retour d'OAuth,
synchronisation). Ensuite je vide `localStorage`, `sessionStorage` et je liste
IndexedDB.

Résultat : aucun appât nulle part, aucune clé nommée `token`/`secret`,
`sessionStorage` vide, toutes les clés locales cloisonnées par compte.

> **Réserve, à dire clairement :** le SDK Supabase ne peut pas se charger ici
> (son CDN est bloqué par le proxy), donc `LyonAuth.available === false` et
> `localStorage` était vide au départ. Ce test prouve que **le code de REV-EM**
> n'écrit aucun token ; il ne prouve pas ce que fait `supabase-js`, qui stocke
> **sa propre session** (JWT Supabase, pas Brightspace) dans `localStorage` —
> comportement documenté et par défaut du SDK. Ce n'est pas un token
> Brightspace, et aucun token Brightspace n'atteint jamais le navigateur : ils
> ne sortent pas des colonnes chiffrées, inaccessibles aux rôles du navigateur.

### Aucun secret dans Git — **PASS**

Scan de **l'historique complet** (`git log --all -p -G`), pas seulement de
l'état courant : aucune clé JWT, aucune `sb_secret_`, aucune clé privée, aucun
jeton porteur, aucune valeur réelle de `client_secret` ou de clé de chiffrement.
Aucun `.env`, `.pem`, `.p12` ni `secrets.json` suivi.

### Aucun token affiché dans console.log — **PASS**

Deux angles :
1. **Code** : les 14 fichiers des Edge Functions sont analysés après retrait des
   commentaires **et des chaînes de caractères** — un message contenant les mots
   « refresh token » n'est pas une fuite, `console.log(refreshToken)` en est
   une. Aucun appel de journalisation ne prend une variable de secret en
   argument. La réponse du endpoint de token n'est jamais journalisée.
2. **Navigateur** : toute la sortie console est capturée pendant les parcours ;
   aucun appât, rien qui ressemble à un JWT ou à un jeton porteur.

### RLS — **PASS**

`supabase/tests/rls_tests.sql` : **338 vérifications, 0 FAIL** sur PostgreSQL
réel. Toutes les tables de `public` ont RLS active (21/21), `oauth_states` n'a
aucune policy ni privilège client.

### Isolation A/B — **PASS**

Couverte deux fois : 160 vérifications croisées dans la suite RLS, et le
scénario 9-10 ci-dessus avec les vraies Edge Functions.

---

## Constats

Aucune anomalie de sécurité. Deux points relevés, ni l'un ni l'autre n'étant une
fuite, et **je n'ai rien modifié** : ce sont des décisions qui t'appartiennent.

### 1. `supabase-config.js` est suivi par Git alors que `.gitignore` le liste

Le fichier a été committé délibérément (`c752ac1` — « Ajoute supabase-config.js
(URL + clé anon/publishable du projet réel) ») **et il doit l'être** : GitHub
Pages sert des fichiers statiques, sans lui l'application déployée n'a aucune
configuration.

Ce n'est **pas une fuite** : `sb_publishable_…` est une clé publique par
conception, envoyée à chaque navigateur qui ouvre le site. La sécurité réelle
repose sur les policies RLS, vérifiées ci-dessus. J'ai vérifié chaque version
committée du fichier : aucune ne contient de clé de service.

La ligne `supabase-config.js` dans `.gitignore` est donc **trompeuse** : elle
décrit une intention qui n'est pas celle du déploiement. Deux options
cohérentes, à toi de choisir — la retirer et assumer que la configuration
publique est versionnée (le plus simple avec GitHub Pages), ou la garder et
générer le fichier au déploiement (plus lourd, sans bénéfice de sécurité ici).

### 2. La révocation côté D2L reste désactivée

`brightspace-disconnect` renvoie honnêtement `revokedAtProvider: false` : les
tokens sont supprimés chez nous, mais l'autorisation reste active côté
Brightspace jusqu'à expiration. L'endpoint de révocation n'a pas pu être
confirmé dans la documentation D2L (inaccessible). Si ton administrateur te le
donne, renseigne `BRIGHTSPACE_REVOCATION_PATH` : le code l'appellera alors, sans
autre changement.

---

## Rapport final

| Élément | Statut | Fondement |
|---|---|---|
| 1. Utilisateur connecté | **PASS** | 130 vérifications sur PostgreSQL réel + vraies Edge Functions |
| 2. Utilisateur non connecté | **PASS** | 401 sur les 5 fonctions, aucun state créé |
| 3. Autorisation acceptée | **PASS** | échange Basic Auth, whoami, ligne chiffrée en base |
| 4. Autorisation refusée | **PASS** | 0 connexion, 0 appel réseau |
| 5. Callback invalide | **PASS** | 7 variantes, jamais « connected » |
| 6. Token expiré | **PASS** | échéance périmée en base, rafraîchissement constaté |
| 7. Refresh token | **PASS** | rotation stockée, concurrence réelle, `invalid_grant` traité |
| 8. Déconnexion | **PASS** | secrets purgés, contenu pédagogique conservé |
| 9-10. Utilisateurs A / B | **PASS** | isolation sous RLS réelle, dans les deux sens |
| Aucun secret dans le frontend | **PASS** | 12 fichiers, 6 motifs |
| Aucun token sensible dans localStorage | **PASS** pour Brightspace · **NOT TESTED** pour la session supabase-js | SDK non chargeable ici |
| Aucun secret dans Git | **PASS** | historique complet, toutes branches |
| Aucun token dans console.log | **PASS** | code + console navigateur |
| RLS | **PASS** | 338 vérifications, PostgreSQL réel |
| Isolation A/B | **PASS** | 160 vérifications croisées + scénario bout-en-bout |
| **Parcours OAuth réel contre D2L** | **NOT TESTED** | aucun tenant, aucune application enregistrée |
| **Migrations appliquées sur ton Supabase** | **NOT TESTED** | projet injoignable (403 du proxy) |
| **Edge Functions déployées** | **NOT TESTED** | idem |
| **Secrets Supabase renseignés** | **NOT TESTED** | idem |
| **`--no-verify-jwt` sur le callback** | **NOT TESTED** | idem |
| **Comportement sous Deno** | **NOT TESTED** | runtime non installable ici |
| Libellés de scopes conformes à la table D2L | **NOT TESTED** | documentation D2L bloquée |

### Totaux exécutés

| Suite | Vérifications | Résultat |
|---|---|---|
| `tests/oauth-integration.test.mjs` (PostgreSQL réel + vraies fonctions) | 130 | **0 FAIL** |
| `tests/security-audit.test.mjs` (Git, navigateur, base) | 125 | **0 FAIL** |
| `tests/edge-oauth.test.js` | 153 | **0 FAIL** |
| `tests/oauth-ui.test.js` | 32 | **0 FAIL** |
| `tests/sync-engine.test.js` | 122 | **0 FAIL** |
| `tests/sync-ui.test.js` | 29 | **0 FAIL** |
| `supabase/tests/rls_tests.sql` | 338 | **0 FAIL** |
| `supabase/tests/sync_idempotency_tests.sql` | 18 | **0 FAIL** |
| **Total** | **947** | **0 FAIL** |

### Ce que je ne déclare pas

**L'intégration Brightspace n'est pas « fonctionnelle ».** Elle est *complète et
vérifiée côté code*. Tant qu'une application OAuth n'est pas enregistrée chez EM
Lyon et que les fonctions ne sont pas déployées sur ton projet, aucun cours réel
n'a jamais été importé, et personne ne s'est jamais connecté. Les 947
vérifications disent que le code fait ce qu'il doit faire quand Brightspace
répond comme prévu — elles ne disent rien de ce que répondra Brightspace.

---

## Reproduire ces tests

```bash
# base d'intégration
createdb revem_itest
psql -d revem_itest -f supabase/tests/00_local_emulation.sql
psql -d revem_itest -f supabase/migrations/000_schema.sql
for m in 001_brightspace 002_centralisation 003_sync_layer 004_oauth_hardening; do
  psql -d revem_itest -f supabase/migrations/$m.sql
done

npm install pg playwright
python3 -m http.server 9109 &

NODE_PATH=$(pwd)/node_modules node --experimental-strip-types \
  --import ./tests/helpers/register-hooks.mjs tests/oauth-integration.test.mjs
node tests/security-audit.test.mjs
```

## Fichiers touchés à cette étape

| Fichier | Nature |
|---|---|
| `tests/oauth-integration.test.mjs` | nouveau — les 10 scénarios |
| `tests/security-audit.test.mjs` | nouveau — audit exécutable |
| `tests/helpers/pgrest.js` | nouveau — traduction PostgREST → SQL réel |
| `tests/helpers/supabase-shim.mjs` | nouveau — remplaçant du SDK pour les tests |
| `tests/helpers/loader-hooks.mjs`, `register-hooks.mjs` | nouveaux — permettent d'importer les vrais `index.ts` |
| `supabase/tests/00_local_emulation.sql` | **modifié** : `grant usage on schema auth to service_role` — Supabase l'accorde, mon émulation l'oubliait, et les fonctions échouaient pour une raison qui n'existe pas en production |
| `.gitignore` | **modifié** : ajout de `node_modules/` |

**Aucun fichier de production n'a été modifié à cette étape.**
