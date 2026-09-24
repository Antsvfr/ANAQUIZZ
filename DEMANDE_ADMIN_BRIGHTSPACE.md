# Demande à l'administrateur Brightspace d'EM Lyon

Ce document est fait pour être **transmis tel quel** à la personne qui gère
Brightspace (DSI / service numérique / support Brightspace). Il contient tout
ce dont elle a besoin et rien d'autre.

Le texte à envoyer est dans le cadre ci-dessous. Remplace uniquement les deux
valeurs entre crochets si nécessaire.

---

## ✉️ Message à envoyer

> **Objet : demande d'enregistrement d'une application OAuth 2.0 (lecture seule) sur Brightspace**
>
> Bonjour,
>
> Je développe un outil personnel de révision qui importe automatiquement mes
> propres cours Brightspace (matières, chapitres, ressources) afin de générer
> des fiches et des quiz de révision.
>
> Pour cela j'ai besoin qu'une application OAuth 2.0 soit enregistrée sur le
> tenant Brightspace de l'école. L'outil **lit uniquement** — il n'écrit,
> ne modifie et ne supprime rien dans Brightspace — et il n'accède qu'aux
> données de l'utilisateur qui s'y connecte, après son consentement explicite
> sur votre écran d'authentification. **Aucun identifiant Brightspace ne
> transite par l'application** : l'authentification a lieu intégralement chez
> vous.
>
> La procédure est celle-ci : **Admin Tools → Manage Extensibility → onglet
> OAuth 2.0 → Register an app**, avec les valeurs suivantes.
>
> | Champ | Valeur |
> |---|---|
> | **Application Name** | `REV-EM` |
> | **Redirect URI** | `https://otlkvlmzakklhugvaxeg.supabase.co/functions/v1/brightspace-callback` |
> | **Prompt for user consent** | à activer |
> | **Enable refresh tokens** | **à activer** (indispensable : sans cela la session expire au bout d'une heure et l'outil devient inutilisable) |
>
> **Scopes demandés — lecture seule uniquement :**
>
> ```
> enrollment:orgunit:read
> content:toc:read
> content:modules:read
> content:topics:read
> users:userdata:read
> ```
>
> | Scope | Usage |
> |---|---|
> | `enrollment:orgunit:read` | lister les cours auxquels je suis inscrit |
> | `content:toc:read` | lire la table des matières d'un cours |
> | `content:modules:read` | lire les modules du cours |
> | `content:topics:read` | lire les ressources d'un module |
> | `users:userdata:read` | vérifier à quel compte l'application est reliée |
>
> Si l'un de ces libellés n'existe pas tel quel sur votre tenant, merci de me
> transmettre l'équivalent le plus proche **en lecture seule** — je n'ai besoin
> d'aucune permission d'écriture, et je préfère des scopes plus restrictifs que
> plus larges.
>
> **Ce que j'aurais besoin de recevoir en retour :**
>
> 1. le **Client ID** de l'application ;
> 2. le **Client Secret** — idéalement par un canal sécurisé (coffre-fort de
>    mots de passe, remise en main propre). Il ne sera jamais stocké dans le
>    code, uniquement dans le gestionnaire de secrets de mon hébergeur ;
> 3. l'**URL exacte du tenant** (par exemple `https://emlyon.brightspace.com`) ;
> 4. les **versions d'API LP et LE** supportées, visibles sur
>    `https://<tenant>/d2l/api/versions/` ;
> 5. la **liste des scopes réellement accordés**, s'ils diffèrent de ma demande.
>
> Sur la protection des données : les tokens sont chiffrés (AES-256-GCM) avant
> stockage, avec une clé conservée hors de la base ; ils ne sont jamais
> accessibles depuis le navigateur ; et la déconnexion les supprime. Je peux
> vous transmettre le détail technique de l'architecture si vous le souhaitez.
>
> Merci d'avance,
> [Ton nom] — [ton adresse e-mail]

---

## Points sur lesquels l'administrateur posera probablement des questions

Prépare ces réponses, elles reviennent presque toujours :

**« Où sont hébergées les données ? »**
Supabase (PostgreSQL managé). Les contenus importés restent rattachés au compte
de l'utilisateur et protégés par des policies d'isolation vérifiées : un
utilisateur ne peut accéder à aucune donnée d'un autre.

**« Qui peut voir les tokens ? »**
Personne depuis le navigateur. Ils sont chiffrés en base, dans des colonnes
qu'aucun rôle exposé au client n'a le droit de lire, et la clé de chiffrement
n'est pas dans la base. Seules les fonctions serveur les déchiffrent, le temps
d'un appel.

**« L'outil peut-il modifier du contenu de cours ? »**
Non. Aucun scope d'écriture n'est demandé, et le code refuse de démarrer si la
configuration en contient un — c'est une vérification automatique, pas une
promesse.

**« Est-ce que ça concerne d'autres étudiants ? »**
Non. Chaque utilisateur doit se connecter et consentir lui-même ; l'application
ne voit que les cours de la personne connectée.

**« Est-ce que c'est du scraping ? »**
Non. Uniquement l'API officielle Brightspace (Valence) avec OAuth 2.0. Aucune
page HTML n'est récupérée ni analysée.

---

## Dès que tu as les réponses

Reviens me voir avec ces cinq valeurs — **sauf le Client Secret, que tu ne dois
pas me transmettre** : tu le saisiras toi-même dans les secrets Supabase (le
script `scripts/setup-supabase.sh` te le demandera sans jamais l'afficher ni
l'écrire sur le disque).

| Valeur | Je l'utilise pour |
|---|---|
| Client ID | secret `BRIGHTSPACE_CLIENT_ID` |
| URL du tenant | secret `BRIGHTSPACE_TENANT_URL` |
| Versions LP / LE | secrets `BRIGHTSPACE_LP_VERSION` / `BRIGHTSPACE_LE_VERSION` |
| Scopes accordés | secret `BRIGHTSPACE_SCOPES` |
| *(Client Secret)* | **toi seul**, directement dans Supabase |

Ensuite, les étapes 2 à 4 sont automatisées : une commande.
