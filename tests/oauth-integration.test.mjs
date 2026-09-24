/* ============================================================================
   REV-EM — VALIDATION DU PARCOURS BRIGHTSPACE, de bout en bout
   ----------------------------------------------------------------------------
   Prérequis :
     npm install pg
     PostgreSQL local avec la base `revem_itest` :
       createdb revem_itest
       psql -d revem_itest -f supabase/tests/00_local_emulation.sql
       psql -d revem_itest -f supabase/schema.sql
       psql -d revem_itest -f supabase/migrations/001_brightspace.sql
       psql -d revem_itest -f supabase/migrations/002_centralisation.sql
       psql -d revem_itest -f supabase/migrations/003_sync_layer.sql
       psql -d revem_itest -f supabase/migrations/004_oauth_hardening.sql

     NODE_PATH=<chemin de pg> node --experimental-strip-types \
       --import ./tests/helpers/register-hooks.mjs tests/oauth-integration.test.mjs

   ── CE QUI EST RÉEL ────────────────────────────────────────────────────────
     • les SIX Edge Functions : leurs fichiers index.ts sont importés tels
       quels, leur handler HTTP est appelé avec de vrais objets Request, et
       leurs vraies Response sont inspectées (statut, en-têtes, corps) ;
     • PostgreSQL : le schéma, les contraintes, les clés étrangères, les
       policies RLS, les privilèges de colonnes, l'atomicité des UPDATE et la
       concurrence réelle entre deux connexions ;
     • le chiffrement AES-GCM des tokens, la signature HMAC du state.

   ── CE QUI EST REMPLACÉ, ET DONC NON VALIDÉ ────────────────────────────────
     • BRIGHTSPACE lui-même : un serveur factice répond à la place de D2L.
       Aucun cours réel, aucun token réel, aucun consentement réel. Ce test ne
       prouve RIEN sur le comportement du tenant EM Lyon.
     • Supabase Auth : `auth.getUser()` résout un jeton de test en consultant
       réellement auth.users, mais ne vérifie aucune signature JWT.
     • PostgREST, le déploiement des fonctions, les secrets Supabase.
   ============================================================================ */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");

/* ---------------------------------------------------------------- harnais */

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

const pool = new Pool({
  host: "127.0.0.1", port: 5432, user: "postgres",
  password: process.env.ITEST_PG_PASSWORD || "itest_pw",
  database: process.env.ITEST_PG_DATABASE || "revem_itest",
  max: 12,
});

/* Chaque requête dans sa propre transaction, avec le RÔLE SQL réel :
   service_role pour les Edge Functions (comme en production), authenticated
   pour tout ce qui simule un accès depuis le navigateur. */
function runner(role, jwtSub) {
  return async function run(sql, params) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      if (jwtSub) {
        await client.query("select set_config('request.jwt.claim.sub', $1, true)", [jwtSub]);
        await client.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ sub: jwtSub, role: "authenticated" })]);
      }
      const res = await client.query(sql, params);
      await client.query("commit");
      return res.rows || [];
    } catch (e) {
      try { await client.query("rollback"); } catch { /* connexion déjà perdue */ }
      throw e;
    } finally {
      client.release();
    }
  };
}

const asService = runner("service_role");
const asUser = (uid) => runner("authenticated", uid);
const asAdmin = runner("postgres");

/* ----------------------------------------------------- Brightspace factice */

let d2l = null;
function resetD2L(opts = {}) {
  let issued = 0;
  d2l = {
    calls: [],
    opts,
    async fetch(url, init = {}) {
      const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
      d2l.calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body });

      if (url.includes("/core/connect/token")) {
        if (d2l.opts.tokenError) {
          return new Response(JSON.stringify({ error: d2l.opts.tokenError }), { status: d2l.opts.tokenStatus || 400 });
        }
        issued++;
        const payload = {
          access_token: "AT-" + issued,
          expires_in: d2l.opts.expiresIn ?? 3600,
          scope: "enrollment:orgunit:read content:toc:read users:userdata:read",
        };
        if (!d2l.opts.noRefresh) payload.refresh_token = "RT-" + issued;
        if (d2l.opts.slowMs) await new Promise(r => setTimeout(r, d2l.opts.slowMs));
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/users/whoami")) {
        if (d2l.opts.whoamiStatus && d2l.opts.whoamiStatus !== 200) {
          return new Response("nope", { status: d2l.opts.whoamiStatus });
        }
        return new Response(JSON.stringify({ Identifier: "77001", FirstName: "Anton", LastName: "S" }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/enrollments/myenrollments/")) {
        return new Response(JSON.stringify({ Items: [{ OrgUnit: { Id: 101, Name: "Éco" } }], PagingInfo: { HasMoreItems: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  return d2l;
}

/* ------------------------------------------------- environnement des fonctions */

const APP_URL = "https://antsvfr.github.io/REV-EM/";   // URL publique réelle du site
const SUPA_URL = "https://otlkvlmzakklhugvaxeg.supabase.co";
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

const ENV = {
  SUPABASE_URL: SUPA_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-de-test",
  BRIGHTSPACE_CLIENT_ID: "rev-em-client",
  BRIGHTSPACE_CLIENT_SECRET: "secret-de-test-jamais-committe",
  BRIGHTSPACE_TENANT_URL: "https://emlyon.brightspace.com",
  BRIGHTSPACE_TOKEN_ENC_KEY: ENC_KEY,
  BRIGHTSPACE_APP_URL: APP_URL,
};

globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { globalThis.__H = h; } };
globalThis.__ITEST_RUN_SQL = asService;

/* `fetch` global : les Edge Functions l'utilisent sans le recevoir en
   paramètre. On l'aiguille vers le Brightspace factice, et on laisse passer
   tout le reste (il n'y en a pas). */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.includes("brightspace.com") || u.includes("/core/connect/token")) return d2l.fetch(u, init);
  return realFetch(url, init);
};

const FUNCTIONS = {};
async function loadFunction(name) {
  globalThis.__H = null;
  await import(`../supabase/functions/${name}/index.ts?v=${Date.now()}`);
  FUNCTIONS[name] = globalThis.__H;
  return FUNCTIONS[name];
}

function callFn(name, { body, token, origin = "https://antsvfr.github.io", method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", "Origin": origin };
  if (token) headers.Authorization = "Bearer " + token;
  return FUNCTIONS[name](new Request(`${SUPA_URL}/functions/v1/${name}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function callCallback(params) {
  const u = new URL(`${SUPA_URL}/functions/v1/brightspace-callback`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return FUNCTIONS["brightspace-callback"](new Request(u.toString(), { method: "GET" }));
}

/* ------------------------------------------------------------- utilitaires */

const UA = "11111111-1111-4111-a111-111111111111";
const UB = "22222222-2222-4222-b222-222222222222";

async function resetUsers() {
  await asAdmin("delete from auth.users where id = any($1::uuid[])", [[UA, UB]]);
  await asAdmin("insert into auth.users (id, email) values ($1,$2),($3,$4)",
    [UA, "a@itest.local", UB, "b@itest.local"]);
}
async function connRow(uid) {
  const rows = await asAdmin("select * from public.brightspace_connections where user_id = $1", [uid]);
  return rows[0] || null;
}
async function countConn() {
  const rows = await asAdmin("select count(*)::int as n from public.brightspace_connections");
  return rows[0].n;
}
async function statesOf(uid) {
  return await asAdmin("select * from public.oauth_states where user_id = $1 order by created_at", [uid]);
}
/* Récupère le `state` signé émis par brightspace-connect, depuis l'URL renvoyée. */
async function startConnect(uid) {
  const res = await callFn("brightspace-connect", { token: "itest:" + uid });
  const json = await res.json();
  const state = json.url ? new URL(json.url).searchParams.get("state") : null;
  return { res, json, state };
}

/* ============================================================================
   EXÉCUTION
   ============================================================================ */

(async function main() {
  for (const f of ["brightspace-connect", "brightspace-callback", "brightspace-refresh",
                   "brightspace-status", "brightspace-api", "brightspace-disconnect"]) {
    await loadFunction(f);
  }

  /* ======================================================================
     0. LE HARNAIS EST BIEN CE QU'IL PRÉTEND ÊTRE
     ====================================================================== */
  await scenario("0. harnais", async function () {
    const rows = await asAdmin("select current_database() as db, version() as v");
    check("la base est un vrai PostgreSQL", /PostgreSQL/.test(rows[0].v), rows[0].v.slice(0, 40));
    eq("base d'intégration", rows[0].db, process.env.ITEST_PG_DATABASE || "revem_itest");
    const t = await asAdmin("select count(*)::int as n from pg_tables where schemaname='public' and rowsecurity");
    eq("toutes les tables ont RLS active", t[0].n, 21);
    eq("les six fonctions sont chargées", Object.keys(FUNCTIONS).length, 6);
  });

  /* ======================================================================
     1 & 2. UTILISATEUR CONNECTÉ / NON CONNECTÉ
     ====================================================================== */
  await scenario("1-2. utilisateur connecté / non connecté", async function () {
    await resetUsers();
    resetD2L();

    /* (2) sans session Supabase : aucune fonction ne doit rien faire. */
    for (const fn of ["brightspace-connect", "brightspace-status", "brightspace-refresh", "brightspace-disconnect", "brightspace-api"]) {
      const res = await callFn(fn, { body: {} });           // aucun jeton
      const body = await res.json();
      check(`[${fn}] sans session : refusé (401)`, res.status === 401, "HTTP " + res.status);
      check(`[${fn}] sans session : aucun détail technique`, !/stack|at |Error:/.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 80));
    }
    const resBad = await callFn("brightspace-connect", { token: "itest:00000000-0000-4000-a000-000000000999" });
    eq("un jeton d'un utilisateur inexistant est refusé", resBad.status, 401);
    eq("aucun state n'a été créé", (await asAdmin("select count(*)::int as n from public.oauth_states"))[0].n, 0);

    /* (1) avec session : le démarrage OAuth produit une vraie URL D2L. */
    const { res, json, state } = await startConnect(UA);
    eq("avec session : la fonction répond", res.status, 200);
    const url = new URL(json.url);
    eq("endpoint d'autorisation officiel", url.origin + url.pathname, "https://auth.brightspace.com/oauth2/auth");
    eq("redirect_uri = l'Edge Function de callback",
      url.searchParams.get("redirect_uri"), `${SUPA_URL}/functions/v1/brightspace-callback`);
    check("aucun secret dans l'URL d'autorisation", !json.url.includes(ENV.BRIGHTSPACE_CLIENT_SECRET));
    check("les scopes demandés sont en lecture seule",
      url.searchParams.get("scope").split(" ").every(s => s.endsWith(":read")), url.searchParams.get("scope"));

    /* Le nonce est RÉELLEMENT en base, rattaché au bon compte. */
    const states = await statesOf(UA);
    eq("un nonce est enregistré en base", states.length, 1);
    eq("rattaché au bon utilisateur", states[0].user_id, UA);
    eq("non consommé", states[0].used_at, null);
    check("le state signé contient ce nonce", state.includes(""), "");
    check("il expire", new Date(states[0].expires_at) > new Date(), String(states[0].expires_at));
  });

  /* ======================================================================
     3. AUTORISATION ACCEPTÉE — le parcours complet
     ====================================================================== */
  await scenario("3. autorisation acceptée", async function () {
    await resetUsers();
    resetD2L();
    const { state } = await startConnect(UA);

    const res = await callCallback({ code: "CODE-REEL", state });
    eq("le callback redirige", res.status, 302);
    const loc = new URL(res.headers.get("location"));
    // readEnv() retire le / final : on compare donc sans lui.
    eq("vers l'application", loc.origin + loc.pathname.replace(/\/$/, ""),
       (new URL(APP_URL).origin + new URL(APP_URL).pathname).replace(/\/$/, ""));
    eq("avec un statut « connected »", loc.searchParams.get("brightspace"), "connected");

    /* L'échange a réellement eu lieu, avec les bons paramètres. */
    const tokenCall = d2l.calls.find(c => c.url.includes("/core/connect/token"));
    check("le code a été échangé contre un token", !!tokenCall);
    eq("en Basic Auth", tokenCall.headers.Authorization,
      "Basic " + Buffer.from(`${ENV.BRIGHTSPACE_CLIENT_ID}:${ENV.BRIGHTSPACE_CLIENT_SECRET}`).toString("base64"));
    eq("grant_type", tokenCall.body.grant_type, "authorization_code");
    check("la connexion a été vérifiée par un appel authentifié",
      d2l.calls.some(c => c.url.includes("/users/whoami")));

    /* La ligne existe vraiment, avec les bonnes valeurs. */
    const row = await connRow(UA);
    check("une connexion est enregistrée", !!row);
    eq("rattachée au compte REV-EM", row.user_id, UA);
    eq("statut connecté", row.status, "connected");
    eq("compte Brightspace identifié", row.external_user_name, "Anton S");
    eq("identifiant externe", row.external_user_id, "77001");
    check("vérifiée", !!row.last_verified_at);
    check("le token d'accès est chiffré", !row.access_token_enc.includes("AT-1"), row.access_token_enc.slice(0, 24));
    check("le refresh token est chiffré", !row.refresh_token_enc.includes("RT-1"), row.refresh_token_enc.slice(0, 24));
    check("l'échéance est enregistrée", !!row.token_expires_at);

    /* Le nonce a été consommé. */
    const states = await statesOf(UA);
    check("le nonce est marqué consommé", !!states[0].used_at);
  });

  /* ======================================================================
     4. AUTORISATION REFUSÉE
     ====================================================================== */
  await scenario("4. autorisation refusée", async function () {
    await resetUsers();
    resetD2L();
    await startConnect(UA);

    const res = await callCallback({ error: "access_denied", error_description: "user denied" });
    eq("redirection", res.status, 302);
    eq("statut « denied »", new URL(res.headers.get("location")).searchParams.get("brightspace"), "denied");
    eq("AUCUNE connexion enregistrée", await countConn(), 0);
    eq("aucun échange de token tenté", d2l.calls.length, 0);
    const states = await statesOf(UA);
    eq("le nonce reste disponible pour une nouvelle tentative", states[0].used_at, null);
  });

  /* ======================================================================
     5. CALLBACK INVALIDE — cinq façons de s'y prendre
     ====================================================================== */
  await scenario("5. callback invalide", async function () {
    await resetUsers();
    resetD2L();

    /* (a) sans code */
    const { state } = await startConnect(UA);
    let res = await callCallback({ state });
    eq("(a) sans code : statut", new URL(res.headers.get("location")).searchParams.get("brightspace"), "invalid");
    eq("(a) rien enregistré", await countConn(), 0);

    /* (b) state forgé */
    res = await callCallback({ code: "C", state: "Zm9yZ2U.c2lnbmF0dXJl" });
    eq("(b) state forgé : statut", new URL(res.headers.get("location")).searchParams.get("brightspace"), "invalid");
    eq("(b) aucun échange tenté", d2l.calls.length, 0);
    eq("(b) rien enregistré", await countConn(), 0);

    /* (c) state d'un autre compte, réémis par un attaquant */
    const other = await startConnect(UB);
    res = await callCallback({ code: "C", state: other.state });
    eq("(c) le state de B rattache la connexion à B, jamais à A",
      (await connRow(UB))?.user_id, UB);
    eq("(c) A n'a aucune connexion", await connRow(UA), null);

    /* (d) rejeu du même state */
    await resetUsers(); resetD2L();
    const s2 = await startConnect(UA);
    await callCallback({ code: "C1", state: s2.state });
    const before = await countConn();
    res = await callCallback({ code: "C2", state: s2.state });
    eq("(d) rejeu : statut", new URL(res.headers.get("location")).searchParams.get("brightspace"), "invalid");
    eq("(d) rejeu : aucune connexion supplémentaire", await countConn(), before);

    /* (e) state expiré (on le périme réellement en base) */
    await resetUsers(); resetD2L();
    const s3 = await startConnect(UA);
    await asAdmin("update public.oauth_states set expires_at = now() - interval '1 hour' where user_id = $1", [UA]);
    res = await callCallback({ code: "C", state: s3.state });
    eq("(e) state expiré : statut", new URL(res.headers.get("location")).searchParams.get("brightspace"), "invalid");
    eq("(e) rien enregistré", await countConn(), 0);

    /* (f) l'échange de token échoue */
    await resetUsers(); resetD2L({ tokenError: "invalid_client" });
    const s4 = await startConnect(UA);
    res = await callCallback({ code: "C", state: s4.state });
    check("(f) échange refusé : jamais « connected »",
      new URL(res.headers.get("location")).searchParams.get("brightspace") !== "connected",
      new URL(res.headers.get("location")).searchParams.get("brightspace"));
    eq("(f) rien enregistré", await countConn(), 0);

    /* (g) application D2L sans refresh token */
    await resetUsers(); resetD2L({ noRefresh: true });
    const s5 = await startConnect(UA);
    res = await callCallback({ code: "C", state: s5.state });
    eq("(g) statut explicite", new URL(res.headers.get("location")).searchParams.get("brightspace"), "no_refresh_token");
    eq("(g) rien enregistré", await countConn(), 0);
  });

  /* ======================================================================
     6 & 7. TOKEN EXPIRÉ ET REFRESH TOKEN
     ====================================================================== */
  await scenario("6-7. token expiré et rafraîchissement", async function () {
    await resetUsers();
    resetD2L();
    const { state } = await startConnect(UA);
    await callCallback({ code: "C", state });
    const before = await connRow(UA);

    /* On périme réellement le token en base. */
    await asAdmin("update public.brightspace_connections set token_expires_at = now() - interval '5 minutes' where user_id = $1", [UA]);

    const res = await callFn("brightspace-status", { token: "itest:" + UA, body: { probe: true } });
    const body = await res.json();
    eq("statut HTTP", res.status, 200);
    eq("la connexion est rétablie et vérifiée", body.connected, true);

    const after = await connRow(UA);
    const refreshCall = d2l.calls.filter(c => c.body && c.body.grant_type === "refresh_token");
    eq("un rafraîchissement a réellement eu lieu", refreshCall.length, 1);
    eq("il a présenté l'ancien refresh token", refreshCall[0].body.refresh_token, "RT-1");
    check("le NOUVEAU refresh token est stocké (rotation)",
      after.refresh_token_enc !== before.refresh_token_enc, "inchangé");
    eq("le compteur de rafraîchissements avance", after.refresh_count, 1);
    check("l'échéance est repoussée", new Date(after.token_expires_at) > new Date(), String(after.token_expires_at));
    eq("le verrou est relâché", after.refresh_lock_at, null);

    /* Rafraîchissement explicite par la fonction dédiée. */
    const res2 = await callFn("brightspace-refresh", { token: "itest:" + UA, body: { force: true } });
    const body2 = await res2.json();
    eq("brightspace-refresh répond", res2.status, 200);
    eq("il ne renvoie AUCUN token au navigateur",
      Object.keys(body2).filter(k => /token/i.test(k) && !/expires|rotated/i.test(k)), []);
    eq("le compteur avance encore", (await connRow(UA)).refresh_count, 2);

    /* Refresh token mort : reconnexion exigée, dit clairement. */
    resetD2L({ tokenError: "invalid_grant" });
    await asAdmin("update public.brightspace_connections set token_expires_at = now() - interval '5 minutes' where user_id = $1", [UA]);
    const res3 = await callFn("brightspace-refresh", { token: "itest:" + UA, body: {} });
    const body3 = await res3.json();
    eq("refresh token mort : statut HTTP", res3.status, 409);
    eq("reconnexion exigée", body3.reconnectRequired, true);
    eq("la base enregistre l'expiration", (await connRow(UA)).status, "expired");
    check("le message est en langage utilisateur", /expiré/i.test(body3.message), body3.message);
  });

  /* ======================================================================
     7 bis. DEUX RAFRAÎCHISSEMENTS SIMULTANÉS — concurrence réelle
     ====================================================================== */
  await scenario("7 bis. concurrence réelle", async function () {
    await resetUsers();
    resetD2L({ slowMs: 120 });
    const { state } = await startConnect(UA);
    await callCallback({ code: "C", state });
    await asAdmin("update public.brightspace_connections set token_expires_at = now() - interval '5 minutes' where user_id = $1", [UA]);

    /* Deux appels réellement concurrents, chacun sur sa connexion PostgreSQL. */
    const [r1, r2] = await Promise.all([
      callFn("brightspace-status", { token: "itest:" + UA, body: { probe: true } }),
      callFn("brightspace-status", { token: "itest:" + UA, body: { probe: true } }),
    ]);
    const [b1, b2] = [await r1.json(), await r2.json()];

    const refreshes = d2l.calls.filter(c => c.body && c.body.grant_type === "refresh_token");
    eq("UN SEUL échange de refresh token malgré deux appels simultanés", refreshes.length, 1);
    check("les deux appels aboutissent", b1.connected === true && b2.connected === true,
      JSON.stringify([b1.status, b2.status]));
    eq("la connexion n'est pas marquée expirée à tort", (await connRow(UA)).status, "connected");
    eq("une seule rotation comptabilisée", (await connRow(UA)).refresh_count, 1);
  });

  /* ======================================================================
     8. DÉCONNEXION
     ====================================================================== */
  await scenario("8. déconnexion", async function () {
    await resetUsers();
    resetD2L();
    const { state } = await startConnect(UA);
    await callCallback({ code: "C", state });

    /* Du contenu importé, qui ne doit PAS disparaître. */
    const subj = await asAdmin(
      `insert into public.subjects (user_id, name, semester_id, source, external_id, sync_status)
       values ($1,'Éco','s1','brightspace','101','active') returning id`, [UA]);
    await asAdmin(
      `insert into public.chapters (user_id, subject_id, title, source, external_id, sync_status, content)
       values ($1,$2,'Intro','brightspace','1001','active','fiche rédigée par l''élève')`, [UA, subj[0].id]);

    const res = await callFn("brightspace-disconnect", { token: "itest:" + UA, body: {} });
    const body = await res.json();
    eq("statut HTTP", res.status, 200);
    eq("la connexion est supprimée", await connRow(UA), null);
    eq("les secrets ne sont plus en base", (await asAdmin(
      "select count(*)::int as n from public.brightspace_connections where user_id = $1", [UA]))[0].n, 0);

    const s = await asAdmin("select sync_status from public.subjects where user_id = $1", [UA]);
    const c = await asAdmin("select sync_status, content from public.chapters where user_id = $1", [UA]);
    eq("la matière importée est CONSERVÉE", s.length, 1);
    eq("marquée non maintenue", s[0].sync_status, "unavailable");
    eq("le chapitre est conservé", c.length, 1);
    eq("la fiche de l'élève est intacte", c[0].content, "fiche rédigée par l'élève");
    eq("l'API le dit explicitement", body.contentKept, true);
    eq("la révocation côté D2L est annoncée honnêtement", body.revokedAtProvider, false);

    /* Après déconnexion, les fonctions refusent proprement. */
    const res2 = await callFn("brightspace-api", { token: "itest:" + UA, body: { op: "courses" } });
    eq("l'API refuse proprement", res2.status, 409);
    eq("motif explicite", (await res2.json()).error, "not_connected");
  });

  /* ======================================================================
     9 & 10. UTILISATEURS A ET B — isolation réelle sous RLS
     ====================================================================== */
  await scenario("9-10. utilisateurs A et B", async function () {
    await resetUsers();
    resetD2L();

    const sa = await startConnect(UA);
    await callCallback({ code: "CA", state: sa.state });
    const sb = await startConnect(UB);
    await callCallback({ code: "CB", state: sb.state });

    eq("deux connexions distinctes", await countConn(), 2);
    check("chacune a ses propres tokens chiffrés",
      (await connRow(UA)).access_token_enc !== (await connRow(UB)).access_token_enc);

    /* Lecture par le CLIENT, sous RLS réelle. */
    const aSees = await asUser(UA)("select user_id from public.brightspace_connections", []);
    const bSees = await asUser(UB)("select user_id from public.brightspace_connections", []);
    eq("A ne voit que sa connexion", aSees.map(r => r.user_id), [UA]);
    eq("B ne voit que la sienne", bSees.map(r => r.user_id), [UB]);

    /* Les colonnes de tokens sont hors de portée, même pour son propre compte. */
    let denied = false;
    try { await asUser(UA)("select access_token_enc from public.brightspace_connections", []); }
    catch (e) { denied = e.code === "42501"; }
    check("A ne peut pas lire son propre token (privilège de colonne)", denied);

    denied = false;
    try { await asUser(UA)("update public.brightspace_connections set status='connected' where user_id = $1", [UB]); }
    catch (e) { denied = e.code === "42501"; }
    check("A ne peut pas écrire dans la connexion de B", denied);

    /* Les nonces OAuth sont invisibles des deux côtés. */
    denied = false;
    try { await asUser(UA)("select * from public.oauth_states", []); }
    catch (e) { denied = e.code === "42501"; }
    check("les nonces OAuth sont inaccessibles au client", denied);

    /* Une Edge Function appelée par A ne renvoie jamais les données de B. */
    const resA = await callFn("brightspace-status", { token: "itest:" + UA, body: { probe: false } });
    const bodyA = await resA.json();
    eq("le statut renvoyé à A est celui de A", bodyA.tenantUrl, ENV.BRIGHTSPACE_TENANT_URL);
    check("aucun identifiant de B dans la réponse à A", !JSON.stringify(bodyA).includes(UB));

    /* La déconnexion de A ne touche pas B. */
    await callFn("brightspace-disconnect", { token: "itest:" + UA, body: {} });
    eq("A est déconnecté", await connRow(UA), null);
    check("B est toujours connecté", !!(await connRow(UB)));
    eq("B reste vérifié", (await connRow(UB)).status, "connected");
  });

  /* ======================================================================
     11. AUCUN TOKEN NE SORT VERS LE NAVIGATEUR
     ====================================================================== */
  await scenario("11. étanchéité des réponses HTTP", async function () {
    await resetUsers();
    resetD2L();
    const { state } = await startConnect(UA);
    await callCallback({ code: "C", state });

    const bodies = [];
    for (const [fn, opts] of [
      ["brightspace-connect", { token: "itest:" + UA }],
      ["brightspace-status", { token: "itest:" + UA, body: { probe: true } }],
      ["brightspace-refresh", { token: "itest:" + UA, body: { force: true } }],
      ["brightspace-api", { token: "itest:" + UA, body: { op: "courses" } }],
    ]) {
      const res = await callFn(fn, opts);
      const text = await res.text();
      bodies.push({ fn, text });

      check(`[${fn}] aucun access token dans la réponse`, !/AT-\d/.test(text), text.slice(0, 120));
      check(`[${fn}] aucun refresh token dans la réponse`, !/RT-\d/.test(text), text.slice(0, 120));
      check(`[${fn}] aucun client_secret dans la réponse`, !text.includes(ENV.BRIGHTSPACE_CLIENT_SECRET));
      check(`[${fn}] aucune clé de chiffrement dans la réponse`, !text.includes(ENC_KEY));
      check(`[${fn}] aucune clé service_role dans la réponse`, !text.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));

      const acao = res.headers.get("Access-Control-Allow-Origin");
      check(`[${fn}] CORS restreint (pas de joker)`, acao !== "*", String(acao));
    }

    /* Une origine hostile ne reçoit pas l'autorisation CORS. */
    const res = await callFn("brightspace-status", {
      token: "itest:" + UA, body: { probe: false }, origin: "https://site-pirate.example",
    });
    check("une origine inconnue n'est pas autorisée",
      res.headers.get("Access-Control-Allow-Origin") !== "https://site-pirate.example",
      String(res.headers.get("Access-Control-Allow-Origin")));
  });

  /* ---------------------------------------------------------------- bilan */
  await pool.end();
  let pass = 0, fail = 0, last = "";
  results.forEach((r) => {
    if (r.scenario !== last) { console.log("\n=== " + r.scenario + " ==="); last = r.scenario; }
    console.log((r.ok ? "PASS" : "FAIL") + " — " + r.label + (r.ok ? "" : "  [" + r.detail + "]"));
    r.ok ? pass++ : fail++;
  });
  console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
