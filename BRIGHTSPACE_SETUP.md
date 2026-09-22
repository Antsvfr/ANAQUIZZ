# Intégration Brightspace — guide de configuration

Ce document décrit **exactement** ce qui doit être fait pour rendre
l'intégration Brightspace fonctionnelle. Tout ce qui pouvait être codé l'a
été ; ce qui reste ci-dessous nécessite des accès que seul toi (ou un
administrateur de l'établissement) possède.

> **À lire d'abord :** sans l'étape 1, rien d'autre ne sert. Elle dépend d'un
> administrateur Brightspace d'EM Lyon. Si cet accès est refusé, l'intégration
> ne peut pas exister — il n'y a pas de contournement légitime (le scraping
> est exclu, et à raison).

---

## Étape 1 — Enregistrer l'application OAuth dans Brightspace

**Qui :** un administrateur Brightspace d'EM Lyon disposant de l'outil
*Manage Extensibility*.

1. Brightspace → **Admin Tools** → **Manage Extensibility** → onglet **OAuth 2.0**
2. **Register an app**
3. Renseigner :

   | Champ | Valeur |
   |---|---|
   | Application Name | `REV-EM` |
   | Redirect URI | `https://<TON-PROJET>.supabase.co/functions/v1/brightspace-callback` |
   | Scopes | voir ci-dessous |
   | Prompt for user consent | activé |
   | Enable refresh tokens | activé |

4. **Scopes — lecture seule uniquement.** Ne demande aucun scope d'écriture.
   Le format Brightspace est `group:resource:action`. Point de départ à
   confirmer avec l'administrateur selon ce que le tenant expose :

   ```
   core:*:read
   ```

   Si l'accès au contenu nécessite des scopes plus précis, l'administrateur
   pourra les restreindre davantage (principe du moindre privilège).

5. Récupérer et conserver **`client_id`** et **`client_secret`**.
   Le `client_secret` ne doit **jamais** être committé ni transmis par
   message non chiffré.

6. Demander aussi à l'administrateur :
   - l'**URL du tenant** (ex. `https://emlyon.brightspace.com`) ;
   - les **versions d'API** LP et LE supportées (visibles sur
     `https://<tenant>/d2l/api/versions/`).

---

## Étape 2 — Appliquer la migration SQL

Dashboard Supabase → **SQL Editor** → coller et exécuter, **dans cet ordre** :

```
supabase/migrations/001_brightspace.sql   provenance + connexion + journal
supabase/migrations/002_centralisation.sql statistiques, activités, planning
supabase/migrations/003_sync_layer.sql     source_updated_at, upsert idempotent
```

Puis les tests, qui doivent tous afficher `0 FAIL` sur leur ligne `RÉSUMÉ` :

```
supabase/tests/sync_idempotency_tests.sql
supabase/tests/rls_tests.sql
```

Les migrations sont **idempotentes** : tu peux les relancer sans risque.
Elle n'altère aucune donnée existante (toutes les lignes actuelles restent
`source = 'manual'`).

**Vérification obligatoire** — exécute ensuite ces deux requêtes :

```sql
-- (a) aucune donnée existante n'a changé de nature → doit renvoyer 0
select count(*) from public.subjects where source <> 'manual';
select count(*) from public.chapters where source <> 'manual';

-- (b) les colonnes de token sont inaccessibles au client → doit renvoyer 0 ligne
select grantee, column_name, privilege_type
  from information_schema.column_privileges
 where table_name = 'brightspace_connections'
   and grantee in ('anon','authenticated')
   and column_name in ('access_token_enc','refresh_token_enc');
```

Si (b) renvoie des lignes, **arrête-toi** : les tokens seraient lisibles
depuis le navigateur.

---

## Étape 3 — Configurer les secrets Supabase

Génère d'abord une clé de chiffrement AES-256 (32 octets, base64) :

```bash
openssl rand -base64 32
```

Puis :

```bash
supabase login
supabase link --project-ref <TON_PROJECT_REF>

supabase secrets set \
  BRIGHTSPACE_CLIENT_ID="..." \
  BRIGHTSPACE_CLIENT_SECRET="..." \
  BRIGHTSPACE_TENANT_URL="https://emlyon.brightspace.com" \
  BRIGHTSPACE_TOKEN_ENC_KEY="<sortie de openssl rand -base64 32>" \
  BRIGHTSPACE_APP_URL="https://<ton-user>.github.io/<ton-repo>/" \
  BRIGHTSPACE_SCOPES="core:*:read"
```

Optionnels (si l'administrateur indique d'autres versions) :

```bash
supabase secrets set BRIGHTSPACE_LP_VERSION="1.31" BRIGHTSPACE_LE_VERSION="1.67"
```

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement
par Supabase — ne les définis pas manuellement.

> ⚠️ **`BRIGHTSPACE_TOKEN_ENC_KEY` ne doit jamais changer** une fois des
> tokens chiffrés en base : ils deviendraient indéchiffrables et tous les
> utilisateurs devraient se reconnecter.

---

## Étape 4 — Déployer les Edge Functions

```bash
supabase functions deploy brightspace-connect
supabase functions deploy brightspace-callback
supabase functions deploy brightspace-api
supabase functions deploy brightspace-disconnect
```

**Important :** `brightspace-callback` est appelée par une redirection de
navigateur, sans en-tête `Authorization`. Elle doit donc être déployée
**sans vérification de JWT** :

```bash
supabase functions deploy brightspace-callback --no-verify-jwt
```

Sa sécurité ne repose pas sur le JWT mais sur la **signature HMAC du
paramètre `state`** (voir `_shared/lib.ts`), qui garantit qu'un tiers ne peut
pas rattacher un compte Brightspace au compte REV-EM de quelqu'un d'autre.

Les trois autres fonctions **doivent** garder la vérification JWT par défaut.

---

## Étape 5 — Tester

1. Ouvrir REV-EM, se connecter avec un compte Supabase
2. **Ressources → Sources connectées → Connecter Brightspace**
3. Tu dois être redirigé vers Brightspace, t'y authentifier, puis revenir sur
   REV-EM avec `?brightspace=connected`
4. Vérifier en base :

```sql
select user_id, tenant_url, status, scopes, token_expires_at
  from public.brightspace_connections;
-- access_token_enc doit être du texte chiffré, jamais un token lisible
```

5. Lancer une synchronisation, puis vérifier l'absence de doublons en
   relançant une seconde fois :

```sql
select source, count(*) from public.subjects group by source;
select external_id, count(*) from public.chapters
 where source = 'brightspace' group by external_id having count(*) > 1;
-- la seconde requête doit renvoyer 0 ligne
```

---

## Architecture de sécurité — pourquoi c'est construit ainsi

```
Navigateur (GitHub Pages)          Edge Functions (Deno)         Brightspace
─────────────────────────          ─────────────────────         ───────────
JWT Supabase          ──────────►  vérifie le JWT
                                   client_secret (secret)  ────►  OAuth
                                   token chiffré AES-GCM
                      ◄──────────  données normalisées
écrit dans subjects/chapters
via RLS (son compte only)
```

| Garantie | Mécanisme |
|---|---|
| Aucun secret dans le frontend | `client_secret` et clé de chiffrement uniquement dans les secrets Supabase |
| Token illisible depuis le navigateur | RLS **+** privilèges de colonnes (`access_token_enc` / `refresh_token_enc` hors de tout `GRANT`) |
| Token illisible en cas de fuite de la base | Chiffrement applicatif AES-GCM, clé hors base |
| Pas de détournement de compte au callback | `state` signé HMAC-SHA256, expirant en 10 min, comparaison à temps constant |
| Un utilisateur ne voit que ses données | RLS `auth.uid() = user_id` sur toutes les tables |
| Pas d'appel d'URL arbitraire | Liste blanche d'opérations + identifiants validés (entiers seulement) |
| Écriture des cours non privilégiée | Le client écrit via RLS, pas via `service_role` |

---

## Ce qui reste volontairement hors périmètre

| | Raison |
|---|---|
| Synchronisation de la progression / statistiques | Ta demande portait sur les **cours** disponibles sur tous les appareils. Les tables `progress` / `question_stats` existent déjà : c'est une phase courte à ajouter si tu le souhaites. |
| Synchronisation des fichiers binaires (PDF) | Coût de stockage. Le **texte extrait** est synchronisé (c'est lui qui alimente fiches et quiz) ; le binaire reste téléchargeable par appareil, en IndexedDB — conforme à l'arbitrage déjà documenté dans `schema.sql`. |
| Téléchargement automatique de liens externes | §8 : on ne télécharge pas un site tiers sans raison. Les liens restent des ressources consultables. |
| Moodle / Google Classroom | L'abstraction est en place (`content-sources.js`), les intégrations ne sont pas développées. |
