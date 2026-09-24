# Brightspace — configuration OAuth 2.0

Tout ce qui pouvait être codé l'a été. Ce qui reste ci-dessous exige des accès
que seul toi — ou l'administrateur Brightspace de ton établissement — possède.

> **À lire d'abord.** Sans l'étape 1, rien d'autre ne sert : elle dépend d'un
> administrateur Brightspace d'EM Lyon. Si cet accès est refusé, l'intégration
> ne peut pas exister. Il n'y a pas de contournement légitime — le scraping est
> exclu, et à raison.

---

## Vue d'ensemble

```
REV-EM (GitHub Pages)   →   Supabase Edge Functions   →   Brightspace OAuth
                                                      →   Brightspace API
```

Le navigateur ne parle jamais à Brightspace. Il ne voit jamais le
`client_secret`, ni un token, ni un refresh token. Six fonctions serveur :

| Fonction | Rôle | JWT |
|---|---|---|
| `brightspace-connect` | démarrer OAuth (construit l'URL d'autorisation) | vérifié |
| `brightspace-callback` | recevoir le code, l'échanger, enregistrer la connexion | **désactivé** |
| `brightspace-refresh` | rafraîchir le token à la demande | vérifié |
| `brightspace-status` | vérifier réellement la connexion (appel authentifié) | vérifié |
| `brightspace-api` | proxy de lecture (cours, contenu, texte) | vérifié |
| `brightspace-disconnect` | déconnecter, purger les tokens | vérifié |

---

# ÉTAPE 1 — Enregistrer l'application OAuth dans Brightspace

**⛔ Cette étape ne peut pas être automatisée. Elle demande un compte
administrateur Brightspace.**

### Où aller

Brightspace → **Admin Tools** (l'icône engrenage) → **Manage Extensibility** →
onglet **OAuth 2.0** → bouton **Register an app**.

Si l'entrée *Manage Extensibility* n'apparaît pas, c'est que le compte utilisé
n'a pas le droit `Can Manage Extensibility` : il faut passer par
l'administrateur de l'établissement.

### Quoi créer

| Champ | Valeur à saisir |
|---|---|
| **Application Name** | `REV-EM` |
| **Redirect URI** | `https://otlkvlmzakklhugvaxeg.supabase.co/functions/v1/brightspace-callback` |
| **Scopes** | voir ci-dessous |
| **Prompt for user consent** | ✅ activé |
| **Enable refresh tokens** | ✅ **activé — obligatoire** |

#### La Redirect URI, exactement

```
https://otlkvlmzakklhugvaxeg.supabase.co/functions/v1/brightspace-callback
```

Cette valeur est celle de **ton** projet Supabase : elle est déduite de
`supabase-config.js`, et `scripts/verify-setup.sh` la réaffiche à chaque
exécution pour que tu puisses la comparer à ce qui est déclaré côté D2L.

Trois règles, sans exception :
- **en HTTPS**, jamais en HTTP ;
- **caractère pour caractère** : pas de `/` final ajouté, pas de majuscule
  changée. D2L compare la chaîne exacte ; la moindre différence donne
  `invalid_request` au moment de la redirection ;
- c'est bien l'URL **de l'Edge Function**, pas celle de ton site GitHub Pages.
  Le site n'est jamais appelé directement par Brightspace.

#### `Enable refresh tokens` — pourquoi c'est obligatoire

Sans cette case, Brightspace n'émet pas de refresh token. La connexion mourrait
à la première expiration (≈ 1 heure) et l'utilisateur devrait se reconnecter
sans arrêt, sans comprendre pourquoi. REV-EM détecte ce cas et le dit
explicitement au lieu de laisser la connexion se dégrader : si tu vois le
message *« Brightspace n'a pas fourni d'autorisation durable »*, c'est cette
case qui manque.

### Quels scopes demander

REV-EM **lit** des cours. Il n'écrit rien dans Brightspace, jamais. Aucun scope
d'écriture ne doit être demandé — la fonction `brightspace-connect` refuse
d'ailleurs de démarrer si la configuration en contient un.

Le format D2L est `groupe:ressource:permission`. Liste demandée par défaut :

```
enrollment:orgunit:read
content:toc:read
content:modules:read
content:topics:read
users:userdata:read
```

| Scope | Pourquoi il est nécessaire |
|---|---|
| `enrollment:orgunit:read` | lister les cours auxquels tu es inscrit |
| `content:toc:read` | lire la table des matières d'un cours |
| `content:modules:read` | lire les modules (ils deviennent tes chapitres) |
| `content:topics:read` | lire les ressources d'un module |
| `users:userdata:read` | vérifier **à quel compte Brightspace** on est relié |

> **⚠️ Point à confirmer avec ton administrateur.** La table officielle des
> scopes D2L (`docs.valence.desire2learn.com/http-scopestable.html`) est
> inaccessible depuis l'environnement où ce code a été écrit : le proxy réseau
> bloque `community.d2l.com` et `docs.valence.desire2learn.com`. Ces cinq
> libellés viennent de sources secondaires concordantes et d'intégrations
> tierces existantes ; **ils n'ont pas pu être vérifiés contre la liste
> officielle**. L'écran *Register an app* affiche les scopes réellement
> exposés par ton tenant : c'est lui qui fait foi.
>
> **Si l'un des libellés est refusé**, remplace-le par son équivalent proposé
> par le tenant, en restant le plus précis possible, puis mets à jour le secret
> `BRIGHTSPACE_SCOPES` (étape 3). Repli acceptable en dernier recours :
> `core:*:read`. **Jamais `core:*:*`** — ce joker inclut l'écriture.

### Ce que tu dois récupérer

À la validation, Brightspace affiche :

| Valeur | Où elle va | Remarque |
|---|---|---|
| **Client ID** | secret Supabase `BRIGHTSPACE_CLIENT_ID` | pas secret en soi, mais ne le publie pas |
| **Client Secret** | secret Supabase `BRIGHTSPACE_CLIENT_SECRET` | **affiché une seule fois** — copie-le immédiatement |

Le `client_secret` ne doit **jamais** être committé, ni collé dans un ticket,
ni envoyé par message non chiffré. S'il fuite, révoque l'application dans
*Manage Extensibility* et enregistres-en une nouvelle.

### Demande aussi à l'administrateur

- l'**URL du tenant** (ex. `https://emlyon.brightspace.com`) ;
- les **versions d'API** LP et LE supportées, visibles sur
  `https://<tenant>/d2l/api/versions/`. Les valeurs par défaut de REV-EM sont
  LP `1.31` et LE `1.67` ; **elles n'ont pas pu être vérifiées** et se règlent
  par secret sans redéploiement.

---

# ÉTAPE 2 — Appliquer les migrations SQL

Dashboard Supabase → **SQL Editor** → coller et exécuter, **dans cet ordre** :

```
supabase/migrations/001_brightspace.sql     provenance, connexion, journal
supabase/migrations/002_centralisation.sql  statistiques, activités, planning
supabase/migrations/003_sync_layer.sql      source_updated_at, upsert idempotent
supabase/migrations/004_oauth_hardening.sql states à usage unique, verrou, vérification
```

Toutes sont idempotentes et non destructives : tu peux les relancer.

Puis les tests, qui doivent afficher `0 FAIL` sur leur ligne `RÉSUMÉ` :

```
supabase/tests/rls_tests.sql                338 vérifications d'isolation
supabase/tests/sync_idempotency_tests.sql    18 vérifications d'idempotence
```

---

# ÉTAPE 3 — Placer les secrets dans Supabase

**⛔ Aucune de ces valeurs ne doit jamais être committée.** Elles vivent
uniquement dans les secrets Supabase, lisibles seulement par les Edge
Functions.

Génère d'abord la clé de chiffrement des tokens (AES-256, 32 octets) :

```bash
openssl rand -base64 32
```

Puis :

```bash
supabase login
supabase link --project-ref otlkvlmzakklhugvaxeg

supabase secrets set \
  BRIGHTSPACE_CLIENT_ID="…"                        `# ← étape 1` \
  BRIGHTSPACE_CLIENT_SECRET="…"                    `# ← étape 1, jamais ailleurs` \
  BRIGHTSPACE_TENANT_URL="https://emlyon.brightspace.com" \
  BRIGHTSPACE_TOKEN_ENC_KEY="<sortie de openssl rand -base64 32>" \
  BRIGHTSPACE_APP_URL="https://antsvfr.github.io/REV-EM/" \
  BRIGHTSPACE_SCOPES="enrollment:orgunit:read content:toc:read content:modules:read content:topics:read users:userdata:read"
```

Où va quoi, en un tableau :

| Valeur obtenue | Secret Supabase | Utilisée par |
|---|---|---|
| Client ID (étape 1) | `BRIGHTSPACE_CLIENT_ID` | connect, callback, refresh |
| Client Secret (étape 1) | `BRIGHTSPACE_CLIENT_SECRET` | callback, refresh (Basic Auth) + signature du `state` |
| URL du tenant (étape 1) | `BRIGHTSPACE_TENANT_URL` | api, status |
| `openssl rand -base64 32` | `BRIGHTSPACE_TOKEN_ENC_KEY` | chiffrement des tokens en base |
| URL de ton site | `BRIGHTSPACE_APP_URL` | redirection de retour **et liste blanche CORS** |
| Scopes validés (étape 1) | `BRIGHTSPACE_SCOPES` | connect |

Optionnels :

```bash
supabase secrets set \
  BRIGHTSPACE_LP_VERSION="1.31" \
  BRIGHTSPACE_LE_VERSION="1.67" \
  BRIGHTSPACE_ALLOWED_ORIGINS="http://localhost:9109"   # développement local
```

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement par
Supabase — **ne les définis pas à la main**.

> ⚠️ **`BRIGHTSPACE_TOKEN_ENC_KEY` ne doit jamais changer** une fois des tokens
> chiffrés en base : ils deviendraient indéchiffrables et tous les utilisateurs
> devraient se reconnecter.

---

# ÉTAPE 4 — Déployer les six Edge Functions

```bash
supabase functions deploy brightspace-connect
supabase functions deploy brightspace-callback --no-verify-jwt
supabase functions deploy brightspace-refresh
supabase functions deploy brightspace-status
supabase functions deploy brightspace-api
supabase functions deploy brightspace-disconnect
```

**`--no-verify-jwt` uniquement pour `brightspace-callback`.** Cette fonction
est appelée par une redirection de navigateur, qui ne porte pas d'en-tête
`Authorization` : avec la vérification JWT, le retour d'OAuth échouerait
systématiquement. Sa sécurité ne repose pas sur le JWT mais sur :

- la **signature HMAC-SHA256** du paramètre `state` (clé = `client_secret`),
- son **expiration** (10 minutes),
- et son **nonce à usage unique** consommé en base (`oauth_states`).

Les cinq autres fonctions **doivent** garder la vérification JWT par défaut.

---

# ÉTAPE 5 — Vérifier que tout est correct

### 5.1 La configuration est complète

```bash
supabase secrets list     # les 6 secrets obligatoires doivent apparaître
supabase functions list   # les 6 fonctions doivent être déployées
```

### 5.2 Les tokens sont hors de portée du navigateur

SQL Editor — **doit renvoyer 0 ligne** :

```sql
select grantee, column_name
  from information_schema.column_privileges
 where table_name = 'brightspace_connections'
   and grantee in ('anon','authenticated')
   and column_name in ('access_token_enc','refresh_token_enc','refresh_lock_at');
```

Si cette requête renvoie quoi que ce soit, **arrête-toi** : les tokens seraient
lisibles depuis un navigateur.

### 5.3 La table des `state` est hermétique

```sql
select rowsecurity from pg_tables
 where schemaname='public' and tablename='oauth_states';            -- true

select count(*) from information_schema.role_table_grants
 where table_name='oauth_states' and grantee in ('anon','authenticated');  -- 0
```

### 5.4 Le parcours réel, de bout en bout

1. Ouvre REV-EM, connecte-toi avec un compte Supabase.
2. **Ressources → Sources connectées → Connecter Brightspace**.
3. Tu dois être redirigé vers **le domaine de ton établissement**, t'y
   authentifier normalement, voir un écran de consentement listant les
   permissions de lecture demandées, puis revenir sur REV-EM.
4. REV-EM revérifie la connexion auprès de Brightspace avant d'afficher quoi
   que ce soit. Tu dois voir **« Connecté »** et, en dessous, **le nom du
   compte Brightspace relié**. Si ce nom n'apparaît pas, la connexion n'a pas
   été vérifiée.

À aucun moment REV-EM ne doit te demander ton mot de passe Brightspace. S'il le
faisait, ce serait un bug de sécurité grave — signale-le.

### 5.5 Ce que la base doit contenir

```sql
select user_id, tenant_url, status, external_user_name,
       last_verified_at, token_expires_at, refresh_count,
       left(access_token_enc, 24)  as access_chiffre,
       left(refresh_token_enc, 24) as refresh_chiffre
  from public.brightspace_connections;
```

- `status` = `connected` ;
- `last_verified_at` est renseigné (preuve d'un appel authentifié réussi) ;
- `external_user_name` est ton nom Brightspace ;
- les deux colonnes chiffrées ressemblent à `q3nR8…` **et pas** à un token
  lisible. Un token D2L commence typiquement par une longue chaîne base64 ;
  si tu reconnais un token, le chiffrement ne fonctionne pas.

### 5.6 Le rafraîchissement fonctionne

Attends l'expiration du token (≈ 1 h), ou force-le :

```js
// Console du navigateur, connecté à REV-EM
await LyonAuth.client.functions.invoke("brightspace-refresh", { body: { force: true } });
```

Puis vérifie que `refresh_count` a augmenté et que `token_rotated_at` a changé.
Le refresh token étant **à usage unique** chez Brightspace, chaque
rafraîchissement doit faire tourner la valeur stockée.

### 5.7 La synchronisation ne crée pas de doublons

Lance une synchronisation, puis une seconde :

```sql
select source, count(*) from public.subjects group by source;
select external_id, count(*) from public.chapters
 where source = 'brightspace' group by external_id having count(*) > 1;
-- la seconde requête doit renvoyer 0 ligne
```

---

## Si quelque chose échoue

| Symptôme | Cause la plus probable | Quoi faire |
|---|---|---|
| `invalid_request` au moment de la redirection | Redirect URI différente d'un caractère | recopier l'URL exacte de l'étape 4 dans *Manage Extensibility* |
| `invalid_client` au retour | `BRIGHTSPACE_CLIENT_ID`/`SECRET` erronés | revérifier les secrets, re-déployer |
| Retour avec `?brightspace=no_refresh_token` | case *Enable refresh tokens* décochée | la cocher dans *Manage Extensibility* |
| Retour avec `?brightspace=forbidden` | scopes insuffisants | ajuster les scopes côté D2L **et** `BRIGHTSPACE_SCOPES` |
| Retour avec `?brightspace=invalid` | `state` expiré (> 10 min) ou rejoué | relancer la connexion |
| « Session expirée » qui revient sans cesse | refresh token invalidé côté D2L | se reconnecter ; si ça persiste, vérifier que la clé de chiffrement n'a pas changé |
| L'appel de fonction échoue en CORS | `BRIGHTSPACE_APP_URL` ne correspond pas à l'origine réelle du site | corriger le secret |

Les logs détaillés sont dans Dashboard → **Edge Functions** → nom de la
fonction → **Logs**. Ils contiennent la cause technique ; le navigateur, lui,
ne reçoit jamais que des messages rédigés pour l'utilisateur.

---

## Architecture de sécurité — pourquoi c'est construit ainsi

| Garantie | Mécanisme |
|---|---|
| Aucun secret dans le frontend | `client_secret` et clé de chiffrement uniquement dans les secrets Supabase |
| Aucun mot de passe Brightspace demandé | l'authentification a lieu entièrement chez D2L |
| Token illisible depuis le navigateur | RLS **+** privilèges de colonnes (colonnes chiffrées hors de tout `GRANT`, pour `anon` comme pour `authenticated`) |
| Token illisible en cas de fuite de la base | chiffrement applicatif AES-256-GCM, clé hors base |
| Pas de détournement de compte au callback | `state` signé HMAC-SHA256, expirant en 10 min, comparé à temps constant |
| Pas de rejeu du callback | nonce consommé en base (`oauth_states`), table inaccessible au client |
| Pas de redirection ouverte | l'URL de retour est contrainte à l'origine de l'application |
| Pas d'appel depuis un site tiers | CORS par liste blanche, jamais l'origine appelante renvoyée telle quelle |
| Pas de connexion « simulée » | statut `connected` écrit seulement après échange de token **et** appel authentifié réussi |
| Deux onglets ne cassent pas la session | verrou atomique sur le rafraîchissement (refresh token à usage unique) |
| Un utilisateur ne voit que ses données | RLS `auth.uid() = user_id` sur toutes les tables |
| Pas d'appel d'URL arbitraire | liste blanche d'opérations + identifiants validés (entiers seulement) |
| Aucune permission d'écriture demandée | scopes en `:read` uniquement, refus au démarrage sinon |

---

## Ce qui reste hors périmètre

| | Raison |
|---|---|
| Synchronisation de la progression / statistiques | les tables existent (migration 002), la bascule du frontend n'est pas faite — voir `SUPABASE_DATA_ARCHITECTURE.md` §7 |
| Synchronisation des fichiers binaires (PDF) | coût de stockage. Le **texte extrait** est synchronisé ; le binaire reste en IndexedDB, par appareil |
| Révocation du token côté D2L à la déconnexion | l'endpoint de révocation n'a pas pu être confirmé dans la documentation D2L. Renseigne `BRIGHTSPACE_REVOCATION_PATH` si ton administrateur te le donne : la déconnexion l'appellera alors. Sans lui, les tokens sont supprimés chez nous et expirent chez D2L |
| Moodle / Google Classroom | l'abstraction est en place (`source-adapters.js`), les intégrations ne sont pas développées |
