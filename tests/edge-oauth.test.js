/* ============================================================================
   REV-EM — tests de la couche OAuth 2.0 Brightspace (Edge Functions)
   ----------------------------------------------------------------------------
   Exécution :  node --experimental-strip-types tests/edge-oauth.test.js

   Ces tests importent les VRAIS fichiers TypeScript des Edge Functions
   (supabase/functions/_shared/*.ts), exécutés par Node grâce au retrait de
   types. Rien n'est réécrit pour les besoins du test : c'est le code qui
   partira en production qui est exercé.

   Ce qui est remplacé, et seulement cela :
     • `fetch`  → un faux serveur OAuth/D2L qui enregistre les requêtes REÇUES,
                  ce qui permet de vérifier l'URL, les en-têtes et le corps
                  RÉELLEMENT émis (Basic Auth, grant_type, redirect_uri…) ;
     • la base  → un faux client PostgREST qui reproduit les filtres utilisés
                  (eq / or / is / lt), y compris l'atomicité de l'UPDATE
                  conditionnel dont dépend le verrou de rafraîchissement.

   ── CE QUE CES TESTS NE PROUVENT PAS ───────────────────────────────────────
   Que Brightspace répond comme le faux serveur le simule. Les endpoints et le
   comportement de rotation viennent de sources secondaires concordantes
   (la documentation D2L est inaccessible depuis l'environnement de
   développement). Seule une connexion à un vrai tenant peut l'établir —
   voir BRIGHTSPACE_SETUP.md.
   ============================================================================ */
"use strict";

const path = require("node:path");
const F = (p) => "file://" + path.join(__dirname, "..", "supabase", "functions", "_shared", p);

/* Le runtime Deno n'existe pas ici : seules ces deux clés sont utilisées. */
globalThis.Deno = { env: { get: (k) => process.env[k] } };

const results = [];
let current = "";
function check(label, ok, detail) { results.push({ scenario: current, label, ok: !!ok, detail: detail || "" }); }
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? "" : "attendu " + JSON.stringify(expected) + ", obtenu " + JSON.stringify(actual));
}
async function scenario(name, fn) {
  current = name;
  try { await fn(); }
  catch (e) { check("le scénario s'exécute sans exception", false, String(e && e.stack || e)); }
}
async function throws(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* ------------------------------------------------------------ fausse base */

/* Reproduit la sémantique PostgREST des requêtes réellement utilisées.
   `update().eq().or().select()` est évalué en UN temps, comme le fait
   PostgreSQL : c'est ce qui rend le test du verrou significatif. */
function makeDb(seed) {
  const tables = Object.assign({ brightspace_connections: [], oauth_states: [], subjects: [], chapters: [] }, seed || {});
  const log = [];

  function matches(row, filters) {
    return filters.every((f) => {
      if (f.kind === "eq") return String(row[f.col]) === String(f.val);
      if (f.kind === "neq") return String(row[f.col]) !== String(f.val);
      if (f.kind === "is") return row[f.col] === null || row[f.col] === undefined;
      if (f.kind === "lt") return row[f.col] !== null && row[f.col] !== undefined && String(row[f.col]) < String(f.val);
      if (f.kind === "or") {
        return f.clauses.some((c) => {
          const [col, op, ...rest] = c.split(".");
          const val = rest.join(".");
          if (op === "is") return row[col] === null || row[col] === undefined;
          if (op === "lt") return row[col] !== null && row[col] !== undefined && String(row[col]) < val;
          if (op === "eq") return String(row[col]) === val;
          return false;
        });
      }
      return true;
    });
  }

  function builder(table) {
    const st = { table, op: null, patch: null, row: null, filters: [], single: false, onConflict: null };
    const rows = () => tables[table] || (tables[table] = []);

    function run() {
      log.push({ table, op: st.op });
      const t = rows();
      if (st.op === "select") {
        const found = t.filter((r) => matches(r, st.filters));
        return { data: st.single ? (found[0] ? { ...found[0] } : null) : found.map((r) => ({ ...r })), error: null };
      }
      if (st.op === "update") {
        const hit = t.filter((r) => matches(r, st.filters));
        hit.forEach((r) => Object.assign(r, st.patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (st.op === "insert") {
        if (t.some((r) => r.id !== undefined && r.id === st.row.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        t.push({ ...st.row });
        return { data: [{ ...st.row }], error: null };
      }
      if (st.op === "upsert") {
        const key = st.onConflict || "id";
        const found = t.find((r) => String(r[key]) === String(st.row[key]));
        if (found) Object.assign(found, st.row); else t.push({ ...st.row });
        return { data: [{ ...st.row }], error: null };
      }
      if (st.op === "delete") {
        const keep = t.filter((r) => !matches(r, st.filters));
        const removed = t.length - keep.length;
        tables[table] = keep;
        return { data: null, error: null, count: removed };
      }
      return { data: null, error: null };
    }

    const b = {
      select(){ if (!st.op) st.op = "select"; return b; },
      insert(r){ st.op = "insert"; st.row = r; return b; },
      upsert(r, o){ st.op = "upsert"; st.row = r; st.onConflict = o && o.onConflict; return b; },
      update(p){ st.op = "update"; st.patch = p; return b; },
      delete(){ st.op = "delete"; return b; },
      eq(c, v){ st.filters.push({ kind: "eq", col: c, val: v }); return b; },
      neq(c, v){ st.filters.push({ kind: "neq", col: c, val: v }); return b; },
      is(c){ st.filters.push({ kind: "is", col: c }); return b; },
      lt(c, v){ st.filters.push({ kind: "lt", col: c, val: v }); return b; },
      or(expr){ st.filters.push({ kind: "or", clauses: String(expr).split(",") }); return b; },
      maybeSingle(){ st.single = true; return b; },
      then(res, rej){ return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }

  return { from: builder, tables, log };
}

/* --------------------------------------------------- faux Brightspace/D2L */

function makeFetch(opts) {
  opts = opts || {};
  const calls = [];
  let issued = 0;
  const f = async (url, init) => {
    init = init || {};
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body });

    if (url.includes("/core/connect/token")) {
      if (opts.tokenError) {
        return new Response(JSON.stringify({ error: opts.tokenError }), { status: opts.tokenStatus || 400 });
      }
      if (opts.onToken) opts.onToken(body);
      issued++;
      return new Response(JSON.stringify({
        access_token: (opts.accessPrefix || "access-") + issued,
        // Brightspace fait tourner le refresh token à chaque échange.
        refresh_token: opts.noRefresh ? undefined : (opts.refreshPrefix || "refresh-") + issued,
        expires_in: opts.expiresIn === undefined ? 3600 : opts.expiresIn,
        scope: opts.scope || "content:toc:read users:userdata:read",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/users/whoami")) {
      if (opts.whoamiStatus && opts.whoamiStatus !== 200) {
        return new Response("nope", { status: opts.whoamiStatus });
      }
      return new Response(JSON.stringify({
        Identifier: "9901", FirstName: "Anton", LastName: "S", UniqueName: "anton",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

/* Clé AES-256 de test (32 octets). Ce n'est pas un secret de production. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function baseEnvVars(over) {
  return Object.assign({
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    BRIGHTSPACE_CLIENT_ID: "client-id-123",
    BRIGHTSPACE_CLIENT_SECRET: "client-secret-xyz",
    BRIGHTSPACE_TENANT_URL: "https://emlyon.brightspace.com",
    BRIGHTSPACE_TOKEN_ENC_KEY: TEST_KEY,
    BRIGHTSPACE_APP_URL: "https://antsvfr.github.io/REV-EM/",
  }, over || {});
}

(async function main() {
  const crypto_ = await import(F("crypto.ts"));
  const envMod = await import(F("env.ts"));
  const http = await import(F("http.ts"));
  const bs = await import(F("brightspace.ts"));
  const oauthState = await import(F("oauth-state.ts"));
  const conn = await import(F("connection.ts"));
  const flow = await import(F("callback-flow.ts"));

  const mkEnv = (over) => envMod.readEnvFrom((k) => baseEnvVars(over)[k]);

  /* ======================================================================
     1. CONFIGURATION ET SCOPES
     ====================================================================== */
  await scenario("1. configuration et scopes", async function () {
    const e = await throws(async () => envMod.readEnvFrom(() => undefined));
    check("une configuration incomplète échoue immédiatement", !!e && /manquante/.test(e.message), e && e.message);

    const env = mkEnv();
    eq("les endpoints OAuth par défaut", env.authBase, "https://auth.brightspace.com");
    check("le client_secret est lu depuis les secrets, pas codé en dur",
      env.clientSecret === "client-secret-xyz");

    const scopes = envMod.DEFAULT_SCOPES.split(" ");
    check("les scopes par défaut sont tous en lecture seule",
      scopes.every(s => s.endsWith(":read")), envMod.DEFAULT_SCOPES);
    check("aucun joker de permission dans les scopes par défaut",
      !/:\*(\s|$)/.test(envMod.DEFAULT_SCOPES), envMod.DEFAULT_SCOPES);
    check("les scopes sont précis (groupe:ressource:action)",
      scopes.every(s => s.split(":").length === 3), envMod.DEFAULT_SCOPES);
    eq("le scope de lecture du contenu est demandé",
      scopes.includes("content:toc:read"), true);

    // Le garde-fou doit refuser toute permission d'écriture.
    for (const bad of ["core:*:*", "content:modules:write", "users:userdata:*", "content:toc:read,write"]) {
      const err = await throws(async () => envMod.assertReadOnlyScopes(bad));
      check("scope refusé : " + bad, !!err, err ? "" : "ACCEPTÉ À TORT");
    }
    const okErr = await throws(async () => envMod.assertReadOnlyScopes(envMod.DEFAULT_SCOPES));
    check("les scopes par défaut passent le garde-fou", !okErr, okErr && okErr.message);
  });

  /* ======================================================================
     2. CORS — liste blanche
     ====================================================================== */
  await scenario("2. CORS", async function () {
    const env = mkEnv({ BRIGHTSPACE_ALLOWED_ORIGINS: "http://localhost:9109" });
    eq("l'origine de l'application est autorisée",
      http.resolveOrigin("https://antsvfr.github.io", env.allowedOrigins, env.appUrl),
      "https://antsvfr.github.io");
    eq("une origine de développement déclarée est autorisée",
      http.resolveOrigin("http://localhost:9109", env.allowedOrigins, env.appUrl),
      "http://localhost:9109");
    const hostile = http.resolveOrigin("https://site-pirate.example", env.allowedOrigins, env.appUrl);
    check("une origine inconnue n'est jamais renvoyée telle quelle",
      hostile !== "https://site-pirate.example", hostile);
    const headers = http.corsHeaders(hostile);
    check("le navigateur bloquera donc la réponse",
      headers["Access-Control-Allow-Origin"] !== "*" &&
      headers["Access-Control-Allow-Origin"] !== "https://site-pirate.example",
      headers["Access-Control-Allow-Origin"]);
  });

  /* ======================================================================
     3. CHIFFREMENT DES TOKENS
     ====================================================================== */
  await scenario("3. chiffrement des tokens", async function () {
    const secret = "refresh-token-ultra-sensible";
    const a = await crypto_.encryptSecret(secret, TEST_KEY);
    const b = await crypto_.encryptSecret(secret, TEST_KEY);

    check("le token n'apparaît jamais en clair", !a.includes(secret), a.slice(0, 40));
    check("deux chiffrements du même token diffèrent (IV aléatoire)", a !== b);
    eq("le déchiffrement restitue le token", await crypto_.decryptSecret(a, TEST_KEY), secret);

    const wrong = Buffer.alloc(32, 9).toString("base64");
    const e1 = await throws(() => crypto_.decryptSecret(a, wrong));
    check("une autre clé ne peut pas déchiffrer", !!e1);

    const e2 = await throws(() => crypto_.encryptSecret("x", Buffer.alloc(16, 1).toString("base64")));
    check("une clé de mauvaise taille est refusée", !!e2 && /32 octets/.test(e2.message), e2 && e2.message);

    const e3 = await throws(() => crypto_.decryptSecret(a.replace(/.$/, "A"), TEST_KEY));
    check("un chiffré altéré est rejeté (authenticité GCM)", !!e3);
  });

  /* ======================================================================
     4. PARAMÈTRE state — signature
     ====================================================================== */
  await scenario("4. state signé", async function () {
    const secret = "client-secret-xyz";
    const s = await crypto_.signState("user-a", "nonce-1", secret);
    const p = await crypto_.verifyState(s, secret);
    eq("le state restitue l'utilisateur", p.userId, "user-a");
    eq("et son nonce", p.nonce, "nonce-1");

    const [body, sig] = s.split(".");
    const forged = await crypto_.signState("user-b", "nonce-1", "autre-secret");
    check("un state signé avec un autre secret est rejeté",
      !!(await throws(() => crypto_.verifyState(forged, secret))));
    check("une signature altérée est rejetée",
      !!(await throws(() => crypto_.verifyState(body + "." + sig.replace(/.$/, "A"), secret))));
    check("un corps altéré est rejeté",
      !!(await throws(() => crypto_.verifyState(
        Buffer.from(JSON.stringify({ u: "user-b", n: "nonce-1", e: Date.now() + 1000 })).toString("base64url") + "." + sig,
        secret))));

    const expired = await crypto_.signState("user-a", "n", secret, -1000);
    const e = await throws(() => crypto_.verifyState(expired, secret));
    check("un state expiré est rejeté", !!e && /expirée/.test(e.message), e && e.message);
  });

  /* ======================================================================
     5. state À USAGE UNIQUE — rejeu impossible
     ====================================================================== */
  await scenario("5. state à usage unique", async function () {
    const db = makeDb();
    const secret = "client-secret-xyz";

    const state = await oauthState.issueState(db, "user-a", secret);
    eq("un nonce est enregistré", db.tables.oauth_states.length, 1);
    check("il n'est pas encore consommé", !db.tables.oauth_states[0].used_at);

    const first = await oauthState.consumeState(db, state, secret);
    eq("la première présentation réussit", first.userId, "user-a");
    check("le nonce est marqué consommé", !!db.tables.oauth_states[0].used_at);

    const replay = await throws(() => oauthState.consumeState(db, state, secret));
    check("le REJEU du même state est refusé", !!replay, replay ? replay.message : "ACCEPTÉ À TORT");

    // Un state parfaitement signé mais dont le nonce n'existe pas en base.
    const orphan = await crypto_.signState("user-a", "nonce-inconnu", secret);
    check("un state signé sans nonce enregistré est refusé",
      !!(await throws(() => oauthState.consumeState(db, orphan, secret))));

    // Un state signé pour un autre utilisateur que celui du nonce.
    const db2 = makeDb();
    await oauthState.issueState(db2, "user-a", secret);
    const nonceA = db2.tables.oauth_states[0].id;
    const mismatched = await crypto_.signState("user-b", nonceA, secret);
    check("un state dont l'utilisateur ne correspond pas au nonce est refusé",
      !!(await throws(() => oauthState.consumeState(db2, mismatched, secret))));
  });

  /* ======================================================================
     6. URL D'AUTORISATION
     ====================================================================== */
  await scenario("6. URL d'autorisation", async function () {
    const env = mkEnv();
    const url = new URL(bs.authorizationUrl(env, "STATE123", bs.callbackUrl(env)));

    eq("endpoint officiel", url.origin + url.pathname, "https://auth.brightspace.com/oauth2/auth");
    eq("response_type", url.searchParams.get("response_type"), "code");
    eq("client_id", url.searchParams.get("client_id"), "client-id-123");
    eq("state transmis", url.searchParams.get("state"), "STATE123");
    eq("redirect_uri pointe vers l'Edge Function",
      url.searchParams.get("redirect_uri"), "https://proj.supabase.co/functions/v1/brightspace-callback");
    eq("scopes en lecture seule", url.searchParams.get("scope"), envMod.DEFAULT_SCOPES);
    check("le client_secret n'apparaît NULLE PART dans l'URL",
      !url.toString().includes("client-secret-xyz"));
    check("aucun mot de passe n'est demandé par REV-EM",
      !/password|mot_de_passe/i.test(url.toString()));
  });

  /* ======================================================================
     7. ÉCHANGE DU CODE
     ====================================================================== */
  await scenario("7. échange du code", async function () {
    const env = mkEnv();
    const f = makeFetch({});
    const tokens = await bs.exchangeCode(env, "auth-code-1", bs.callbackUrl(env), f);

    const call = f.calls[0];
    eq("appel du endpoint de token", call.url, "https://auth.brightspace.com/core/connect/token");
    eq("méthode POST", call.method, "POST");
    eq("client_id/secret en Basic Auth",
      call.headers.Authorization,
      "Basic " + Buffer.from("client-id-123:client-secret-xyz").toString("base64"));
    eq("grant_type", call.body.grant_type, "authorization_code");
    eq("code transmis", call.body.code, "auth-code-1");
    eq("redirect_uri identique à la demande",
      call.body.redirect_uri, "https://proj.supabase.co/functions/v1/brightspace-callback");
    check("le secret ne passe pas dans l'URL", !call.url.includes("client-secret-xyz"));

    eq("access token extrait", tokens.accessToken, "access-1");
    eq("refresh token extrait", tokens.refreshToken, "refresh-1");
    check("l'expiration garde une marge de sécurité",
      tokens.expiresAt <= Date.now() + 3600_000 && tokens.expiresAt > Date.now() + 3500_000,
      String(tokens.expiresAt - Date.now()));

    const bad = makeFetch({ tokenError: "invalid_grant" });
    const err = await throws(() => bs.exchangeCode(env, "x", "y", bad));
    check("une erreur invalid_grant est identifiée comme telle", !!err && err.invalidGrant === true,
      err && String(err.invalidGrant));
  });

  /* ======================================================================
     8. ROTATION DU REFRESH TOKEN
     ====================================================================== */
  await scenario("8. rotation du refresh token", async function () {
    const env = mkEnv();
    const db = makeDb();
    const f = makeFetch({});

    // Connexion existante, token d'accès expiré.
    db.tables.brightspace_connections.push({
      user_id: "user-a", status: "connected",
      access_token_enc: await crypto_.encryptSecret("vieux-access", TEST_KEY),
      refresh_token_enc: await crypto_.encryptSecret("refresh-0", TEST_KEY),
      token_expires_at: new Date(Date.now() - 1000).toISOString(),
      refresh_lock_at: null, refresh_count: 0,
    });

    const row = db.tables.brightspace_connections[0];
    const token = await conn.ensureAccessToken(env, db, { ...row }, { fetchImpl: f });

    eq("un nouvel access token est obtenu", token, "access-1");
    eq("le refresh token utilisé est bien l'ancien", f.calls[0].body.refresh_token, "refresh-0");
    eq("grant_type refresh_token", f.calls[0].body.grant_type, "refresh_token");

    const stored = db.tables.brightspace_connections[0];
    eq("le NOUVEAU refresh token est enregistré (rotation)",
      await crypto_.decryptSecret(stored.refresh_token_enc, TEST_KEY), "refresh-1");
    eq("le compteur de rafraîchissements avance", stored.refresh_count, 1);
    check("la date de rotation est enregistrée", !!stored.token_rotated_at);
    eq("le verrou est relâché", stored.refresh_lock_at, null);
    eq("le statut reste connecté", stored.status, "connected");

    // Un token encore valide ne doit déclencher AUCUN appel réseau.
    const before = f.calls.length;
    const again = await conn.ensureAccessToken(env, db, { ...db.tables.brightspace_connections[0] }, { fetchImpl: f });
    eq("un token valide est réutilisé sans appel réseau", f.calls.length, before);
    eq("et c'est bien le token courant", again, "access-1");
  });

  /* ======================================================================
     9. CONCURRENCE — deux rafraîchissements simultanés
     ====================================================================== */
  await scenario("9. rafraîchissements simultanés", async function () {
    const env = mkEnv();
    const db = makeDb();
    let release;
    const gate = new Promise((r) => { release = r; });

    // Le premier échange est retenu jusqu'à ce qu'on le libère : les deux
    // appels sont donc réellement en vol en même temps.
    const f = makeFetch({ onToken: () => {} });
    const slow = async (url, init) => {
      if (url.includes("/core/connect/token")) await gate;
      return f(url, init);
    };

    db.tables.brightspace_connections.push({
      user_id: "user-a", status: "connected",
      access_token_enc: await crypto_.encryptSecret("vieux", TEST_KEY),
      refresh_token_enc: await crypto_.encryptSecret("refresh-0", TEST_KEY),
      token_expires_at: new Date(Date.now() - 1000).toISOString(),
      refresh_lock_at: null, refresh_count: 0,
    });
    const snapshot = { ...db.tables.brightspace_connections[0] };

    const p1 = conn.ensureAccessToken(env, db, { ...snapshot }, { fetchImpl: slow, waitDelayMs: 5, waitAttempts: 50 });
    const p2 = conn.ensureAccessToken(env, db, { ...snapshot }, { fetchImpl: slow, waitDelayMs: 5, waitAttempts: 50 });
    setTimeout(() => release(), 30);
    const [t1, t2] = await Promise.all([p1, p2]);

    const tokenCalls = f.calls.filter((c) => c.url.includes("/core/connect/token"));
    eq("UN SEUL échange de refresh token a eu lieu", tokenCalls.length, 1);
    eq("les deux appelants obtiennent le même access token valide", t1, t2);
    eq("aucune connexion marquée expirée à tort",
      db.tables.brightspace_connections[0].status, "connected");
    eq("une seule rotation comptabilisée", db.tables.brightspace_connections[0].refresh_count, 1);
  });

  /* ======================================================================
     10. VERROU PÉRIMÉ ET ERREURS DE RAFRAÎCHISSEMENT
     ====================================================================== */
  await scenario("10. verrou périmé et erreurs", async function () {
    const env = mkEnv();

    /* (a) verrou abandonné par une fonction tuée : il doit pouvoir être repris. */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected",
        access_token_enc: await crypto_.encryptSecret("vieux", TEST_KEY),
        refresh_token_enc: await crypto_.encryptSecret("refresh-0", TEST_KEY),
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
        refresh_lock_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        refresh_count: 0,
      });
      const f = makeFetch({});
      const t = await conn.ensureAccessToken(env, db, { ...db.tables.brightspace_connections[0] }, { fetchImpl: f });
      eq("(a) un verrou périmé est repris", t, "access-1");
    }

    /* (b) refresh token mort : reconnexion exigée, et c'est dit en base. */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected",
        refresh_token_enc: await crypto_.encryptSecret("refresh-mort", TEST_KEY),
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
        refresh_lock_at: null, refresh_count: 0,
      });
      const f = makeFetch({ tokenError: "invalid_grant" });
      const e = await throws(() => conn.ensureAccessToken(env, db, { ...db.tables.brightspace_connections[0] }, { fetchImpl: f }));
      check("(b) une reconnexion est exigée", e instanceof conn.ReconnectRequired, e && e.constructor.name);
      eq("(b) le statut est enregistré comme expiré", db.tables.brightspace_connections[0].status, "expired");
      eq("(b) le verrou est relâché", db.tables.brightspace_connections[0].refresh_lock_at, null);
    }

    /* (c) panne réseau passagère : PAS de reconnexion exigée, verrou relâché. */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected",
        refresh_token_enc: await crypto_.encryptSecret("refresh-0", TEST_KEY),
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
        refresh_lock_at: null, refresh_count: 0,
      });
      const f = makeFetch({ tokenError: "server_error", tokenStatus: 503 });
      const e = await throws(() => conn.ensureAccessToken(env, db, { ...db.tables.brightspace_connections[0] }, { fetchImpl: f }));
      check("(c) l'erreur est signalée comme réessayable", !!e && e.retryable === true, e && String(e.retryable));
      check("(c) la connexion n'est PAS marquée expirée",
        db.tables.brightspace_connections[0].status === "connected",
        db.tables.brightspace_connections[0].status);
      eq("(c) le verrou est relâché pour permettre un nouvel essai",
        db.tables.brightspace_connections[0].refresh_lock_at, null);
    }

    /* (d) aucune connexion enregistrée : message clair, pas d'appel réseau. */
    {
      const db = makeDb();
      const f = makeFetch({});
      const e = await throws(() => conn.ensureAccessToken(env, db, { user_id: "user-a" }, { fetchImpl: f }));
      check("(d) reconnexion demandée sans aucun appel réseau",
        e instanceof conn.ReconnectRequired && f.calls.length === 0, f.calls.length + " appel(s)");
    }
  });

  /* ======================================================================
     11. VÉRIFICATION RÉELLE DE LA CONNEXION
     ====================================================================== */
  await scenario("11. vérification de la connexion", async function () {
    const env = mkEnv();

    /* (a) connexion valide : whoami aboutit, l'identité est enregistrée. */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected", tenant_url: env.tenantUrl,
        scopes: ["content:toc:read"],
        access_token_enc: await crypto_.encryptSecret("access-ok", TEST_KEY),
        refresh_token_enc: await crypto_.encryptSecret("refresh-0", TEST_KEY),
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const f = makeFetch({});
      const r = await conn.verifyConnection(env, db, "user-a", { fetchImpl: f });
      eq("(a) la connexion est vérifiée", r.ok, true);
      check("(a) un appel authentifié a réellement eu lieu",
        f.calls.some(c => c.url.includes("/users/whoami")), JSON.stringify(f.calls.map(c => c.url)));
      check("(a) l'appel porte le token en Bearer",
        String(f.calls[0].headers.Authorization).startsWith("Bearer "), f.calls[0].headers.Authorization);
      eq("(a) le compte Brightspace est nommé", r.identity.displayName, "Anton S");
      check("(a) la date de vérification est enregistrée",
        !!db.tables.brightspace_connections[0].last_verified_at);
      eq("(a) l'identifiant externe est enregistré",
        db.tables.brightspace_connections[0].external_user_id, "9901");
    }

    /* (b) aucune connexion : pas « connecté », et aucun appel réseau. */
    {
      const db = makeDb();
      const f = makeFetch({});
      const r = await conn.verifyConnection(env, db, "user-a", { fetchImpl: f });
      eq("(b) non connecté", r.ok, false);
      eq("(b) statut explicite", r.status, "not_connected");
      eq("(b) aucun appel réseau inutile", f.calls.length, 0);
    }

    /* (c) session morte : reconnexion demandée, jamais « connecté ». */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected",
        refresh_token_enc: await crypto_.encryptSecret("refresh-mort", TEST_KEY),
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      const f = makeFetch({ tokenError: "invalid_grant" });
      const r = await conn.verifyConnection(env, db, "user-a", { fetchImpl: f });
      eq("(c) la connexion n'est pas annoncée comme valide", r.ok, false);
      eq("(c) le motif est explicite", r.status, "expired");
    }

    /* (d) permissions insuffisantes : ce n'est pas une expiration. */
    {
      const db = makeDb();
      db.tables.brightspace_connections.push({
        user_id: "user-a", status: "connected",
        access_token_enc: await crypto_.encryptSecret("access-ok", TEST_KEY),
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const f = makeFetch({ whoamiStatus: 403 });
      const r = await conn.verifyConnection(env, db, "user-a", { fetchImpl: f });
      eq("(d) non vérifiée", r.ok, false);
      eq("(d) distinguée d'une expiration", r.reason, "forbidden");
      check("(d) aucune reconnexion inutile n'est proposée", r.status !== "expired", r.status);
    }
  });

  /* ======================================================================
     12. CALLBACK — « connecté » seulement si OAuth a RÉELLEMENT réussi
     ====================================================================== */
  await scenario("12. callback OAuth", async function () {
    const env = mkEnv();
    const secret = env.clientSecret;

    async function freshState(db, user = "user-a") {
      return await oauthState.issueState(db, user, secret);
    }

    /* (a) chemin nominal. */
    {
      const db = makeDb();
      const state = await freshState(db);
      const f = makeFetch({});
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });

      eq("(a) issue", r.outcome, "connected");
      eq("(a) une connexion est enregistrée", db.tables.brightspace_connections.length, 1);
      const row = db.tables.brightspace_connections[0];
      eq("(a) rattachée au bon compte REV-EM", row.user_id, "user-a");
      eq("(a) statut connecté", row.status, "connected");
      check("(a) le token d'accès est chiffré en base",
        !!row.access_token_enc && !row.access_token_enc.includes("access-1"), String(row.access_token_enc).slice(0, 30));
      check("(a) le refresh token est chiffré en base",
        !!row.refresh_token_enc && !row.refresh_token_enc.includes("refresh-1"), String(row.refresh_token_enc).slice(0, 30));
      eq("(a) les deux tokens se déchiffrent correctement",
        [await crypto_.decryptSecret(row.access_token_enc, TEST_KEY),
         await crypto_.decryptSecret(row.refresh_token_enc, TEST_KEY)],
        ["access-1", "refresh-1"]);
      check("(a) la connexion a été vérifiée avant d'être annoncée", !!row.last_verified_at);
      eq("(a) le compte Brightspace relié est nommé", row.external_user_name, "Anton S");
      check("(a) whoami a bien été appelé",
        f.calls.some(c => c.url.includes("/users/whoami")));
    }

    /* (b) refus de consentement : rien n'est écrit. */
    {
      const db = makeDb();
      const f = makeFetch({});
      const r = await flow.handleCallback(env, db, new URLSearchParams({ error: "access_denied" }), { fetchImpl: f });
      eq("(b) issue", r.outcome, "denied");
      eq("(b) AUCUNE connexion enregistrée", db.tables.brightspace_connections.length, 0);
      eq("(b) aucun appel réseau", f.calls.length, 0);
    }

    /* (c) state invalide : rien n'est écrit, aucun échange tenté. */
    {
      const db = makeDb();
      const f = makeFetch({});
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state: "forge.xx" }), { fetchImpl: f });
      eq("(c) issue", r.outcome, "invalid");
      eq("(c) AUCUNE connexion enregistrée", db.tables.brightspace_connections.length, 0);
      eq("(c) le code n'est même pas échangé", f.calls.length, 0);
    }

    /* (d) rejeu d'un callback légitime : refusé. */
    {
      const db = makeDb();
      const state = await freshState(db);
      const f = makeFetch({});
      await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });
      const r2 = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });
      eq("(d) le rejeu est refusé", r2.outcome, "invalid");
      eq("(d) toujours une seule connexion", db.tables.brightspace_connections.length, 1);
    }

    /* (e) échange de token refusé : aucune connexion « réussie ». */
    {
      const db = makeDb();
      const state = await freshState(db);
      const f = makeFetch({ tokenError: "invalid_client" });
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });
      check("(e) l'issue n'est pas 'connected'", r.outcome !== "connected", r.outcome);
      eq("(e) AUCUNE connexion enregistrée", db.tables.brightspace_connections.length, 0);
    }

    /* (f) whoami échoue : on n'annonce pas une connexion non vérifiée. */
    {
      const db = makeDb();
      const state = await freshState(db);
      const f = makeFetch({ whoamiStatus: 403 });
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });
      check("(f) l'issue n'est pas 'connected'", r.outcome !== "connected", r.outcome);
      eq("(f) AUCUNE connexion enregistrée", db.tables.brightspace_connections.length, 0);
    }

    /* (g) application D2L sans refresh token : signalé, rien d'enregistré. */
    {
      const db = makeDb();
      const state = await freshState(db);
      const f = makeFetch({ noRefresh: true });
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "c1", state }), { fetchImpl: f });
      eq("(g) issue explicite", r.outcome, "no_refresh_token");
      eq("(g) AUCUNE connexion enregistrée", db.tables.brightspace_connections.length, 0);
    }

    /* (h) un utilisateur ne peut pas détourner la connexion d'un autre. */
    {
      const db = makeDb();
      const stateA = await freshState(db, "user-a");
      // « user-b » tente de rejouer le state de A avec son propre code.
      const f = makeFetch({});
      const r = await flow.handleCallback(env, db, new URLSearchParams({ code: "code-de-b", state: stateA }), { fetchImpl: f });
      eq("(h) la connexion est rattachée au propriétaire du state", db.tables.brightspace_connections[0].user_id, "user-a");
      eq("(h) et à personne d'autre", db.tables.brightspace_connections.length, 1);
      eq("(h) issue", r.outcome, "connected");
    }
  });

  /* ======================================================================
     13. AUCUN SECRET NE PEUT ATTEINDRE LE NAVIGATEUR
     ====================================================================== */
  await scenario("13. étanchéité des secrets", async function () {
    const fs = require("node:fs");
    const files = [
      "index.html", "auth.js", "sync-engine.js", "source-adapters.js",
      "content-sources.js", "supabase-config.js",
    ];
    const secretish = [
      /BRIGHTSPACE_CLIENT_SECRET/, /client_secret/i, /BRIGHTSPACE_TOKEN_ENC_KEY/,
      /service_role/i, /refresh_token_enc/, /access_token_enc/,
    ];
    for (const file of files) {
      const p = path.join(__dirname, "..", file);
      if (!fs.existsSync(p)) continue;
      // Les commentaires expliquant l'architecture sont tolérés ; ce qui est
      // interdit, c'est une lecture ou une écriture réelle. On retire donc les
      // commentaires avant d'inspecter, plutôt que de les reconnaître ligne
      // à ligne — un commentaire de bloc s'étend sur plusieurs lignes.
      const src = fs.readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      for (const rx of secretish) {
        const hits = src.split("\n").filter(l => rx.test(l));
        check(`${file} : aucune manipulation de ${rx.source}`, hits.length === 0,
          hits.slice(0, 2).map(h => h.trim().slice(0, 90)).join(" | "));
      }
    }
  });

  /* ---------------------------------------------------------------- bilan */
  let pass = 0, fail = 0, last = "";
  results.forEach((r) => {
    if (r.scenario !== last) { console.log("\n=== " + r.scenario + " ==="); last = r.scenario; }
    console.log((r.ok ? "PASS" : "FAIL") + " — " + r.label + (r.ok ? "" : "  [" + r.detail + "]"));
    r.ok ? pass++ : fail++;
  });
  console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
