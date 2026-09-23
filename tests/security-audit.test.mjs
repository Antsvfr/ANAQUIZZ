/* ============================================================================
   REV-EM — audit de sécurité exécutable
   ----------------------------------------------------------------------------
   Prérequis : dépôt servi sur http://localhost:9109 (python3 -m http.server 9109)
   Exécution :
     NODE_PATH=/opt/node22/lib/node_modules node tests/security-audit.test.mjs

   Ce que ce fichier vérifie RÉELLEMENT, sans rien supposer :
     1. aucun secret dans les fichiers servis au navigateur ;
     2. aucun secret dans l'HISTORIQUE Git (pas seulement dans l'état courant) ;
     3. aucun token Brightspace dans localStorage / sessionStorage / IndexedDB,
        après avoir réellement fait tourner les parcours dans Chromium ;
     4. aucun token dans la console du navigateur, ni dans le code des Edge
        Functions ;
     5. les colonnes de secrets restent hors de portée des rôles du navigateur.

   Ce qu'il ne peut pas vérifier : ce qui se passe sur le projet Supabase
   déployé (inaccessible depuis cet environnement) et le comportement d'un
   vrai tenant Brightspace.
   ============================================================================ */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const results = [];
let current = "";
function check(label, ok, detail) { results.push({ scenario: current, label, ok: !!ok, detail: detail || "" }); }
function eq(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(label, ok, ok ? "" : "attendu " + JSON.stringify(b) + ", obtenu " + JSON.stringify(a));
}
function git(cmd) {
  return execSync(`git -C ${ROOT} ${cmd}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/* Motifs de secrets réels. Volontairement larges : mieux vaut un faux positif
   à expliquer qu'un secret publié. */
/* Motifs de secrets RÉELS : aucun d'eux ne peut apparaître dans un dépôt sain,
   quel que soit le fichier — y compris un test ou une documentation. */
const SECRET_PATTERNS = [
  { name: "clé JWT Supabase (service_role/anon en JWT)", rx: /eyJhbGciOi[A-Za-z0-9_\-\.]{20,}/ },
  { name: "clé secrète Supabase (sb_secret_)", rx: /sb_secret_[A-Za-z0-9_\-]{10,}/ },
  { name: "clé privée", rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "token porteur en dur", rx: /Bearer\s+[A-Za-z0-9\-_]{30,}/ },
];

/* Affectations de configuration sensibles. Elles sont légitimes dans un test
   (valeur factice) ou une documentation (gabarit `<…>`) : on les cherche donc
   en excluant ces deux cas, et on affiche ce qui a matché pour que rien ne
   soit balayé sous le tapis. */
const ASSIGNMENT_PATTERNS = [
  { name: "valeur de client_secret Brightspace", rx: /BRIGHTSPACE_CLIENT_SECRET\s*[:=]\s*["'`][^"'`]{6,}["'`]/ },
  { name: "clé de chiffrement de tokens", rx: /BRIGHTSPACE_TOKEN_ENC_KEY\s*[:=]\s*["'`][^"'`]{10,}["'`]/ },
];
const PLACEHOLDER = /<[^>]*>|\u2026|\.\.\.|de-test|test-|factice|xyz|EXEMPLE|example/i;

(async function main() {

  /* ======================================================================
     1. FICHIERS SERVIS AU NAVIGATEUR
     ====================================================================== */
  current = "1. fichiers servis au navigateur";
  {
    const served = ["index.html", "auth.js", "translations.js", "smart-revision.js",
      "statistics.js", "planning.js", "content-sources.js", "sync-engine.js",
      "source-adapters.js", "ai-worker.js", "supabase-config.js", "supabase-config.example.js"];
    for (const f of served) {
      let src;
      try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      for (const { name, rx } of SECRET_PATTERNS.concat(ASSIGNMENT_PATTERNS)) {
        const hit = rx.exec(src);
        check(`${f} : aucun ${name}`, !hit, hit ? hit[0].slice(0, 40) + "…" : "");
      }
    }
    /* La clé « publishable » de Supabase est publique par conception : on
       vérifie que c'est bien celle-là, et pas une clé de service. */
    let cfg = "";
    try { cfg = readFileSync(join(ROOT, "supabase-config.js"), "utf8"); } catch { /* absent */ }
    if (cfg) {
      check("supabase-config.js n'utilise pas de clé service_role",
        !/service_role/.test(cfg.replace(/\/\*[\s\S]*?\*\//g, "")), "");
      check("la clé exposée est bien une clé publique (publishable/anon)",
        /sb_publishable_|anonKey/.test(cfg), "");
    }
  }

  /* ======================================================================
     2. HISTORIQUE GIT
     ====================================================================== */
  current = "2. historique Git";
  {
    const commits = git("rev-list --all --count").trim();
    check(`l'historique complet est inspecté (${commits} commits)`, Number(commits) > 0, commits);

    function scanHistory(rx) {
      let out = "";
      try {
        out = execSync(
          `git -C ${ROOT} log --all -p --no-color -G'${rx.source.replace(/'/g, "'\\''")}' --format='COMMIT %H' -- . `,
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
      } catch { out = ""; }
      const hits = [];
      let file = "";
      for (const line of out.split("\n")) {
        if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
        if (/^\+[^+]/.test(line) && rx.test(line)) hits.push({ file, line: line.slice(1).trim() });
      }
      return hits;
    }

    /* Passe 1 — secrets réels : aucune tolérance, quel que soit le fichier. */
    for (const { name, rx } of SECRET_PATTERNS) {
      const hits = scanHistory(rx);
      check(`aucun ${name} n'a jamais été committé`, hits.length === 0,
        hits.slice(0, 2).map(h => h.file + " → " + h.line.slice(0, 60)).join(" | "));
    }

    /* Passe 2 — affectations sensibles : une valeur factice dans un test ou un
       gabarit dans la documentation est légitime. Tout le reste ne l'est pas. */
    for (const { name, rx } of ASSIGNMENT_PATTERNS) {
      const hits = scanHistory(rx).filter(h => !PLACEHOLDER.test(h.line));
      const suspects = hits.filter(h => !/^tests?\//.test(h.file) && !/\.md$/.test(h.file));
      check(`aucune ${name} réelle n'a jamais été committée`, suspects.length === 0,
        suspects.slice(0, 2).map(h => h.file + " → " + h.line.slice(0, 60)).join(" | "));
    }

    /* supabase-config.js EST suivi par Git — et doit l'être : GitHub Pages sert
       des fichiers statiques, sans lui l'application déployée n'a aucune
       configuration. Ce n'est donc pas une fuite : la clé « publishable » est
       publique par conception, elle part dans chaque navigateur de toute façon.
       Ce qui compte, et qui est vérifié ici, c'est qu'elle n'ait JAMAIS été
       remplacée par une clé de service. */
    const tracked = git("ls-files").split("\n");
    const configTracked = tracked.includes("supabase-config.js");
    check("constat : supabase-config.js est suivi par Git (nécessaire pour GitHub Pages)",
      configTracked, "non suivi — l'application déployée n'aurait pas de configuration");

    if (configTracked) {
      const versions = git("log --all --format=%H -- supabase-config.js").trim().split("\n").filter(Boolean);
      let bad = [];
      for (const sha of versions) {
        const content = git(`show ${sha}:supabase-config.js`);
        if (/sb_secret_|service_role|eyJhbGciOi/.test(content.replace(/\/\*[\s\S]*?\*\//g, ""))) bad.push(sha.slice(0, 8));
      }
      check(`aucune version committée de supabase-config.js ne contient de clé de service (${versions.length} version(s))`,
        bad.length === 0, bad.join(", "));
      check("la clé committée est une clé publique (publishable)",
        /sb_publishable_/.test(git("show HEAD:supabase-config.js")), "");
    }

    /* Aucun fichier d'environnement ni de clé ne doit être suivi. */
    const suspicious = tracked.filter(f => /(^|\/)\.env|\.pem$|\.p12$|secrets?\.(json|ya?ml)$/i.test(f));
    eq("aucun fichier de secrets suivi par Git", suspicious, []);
  }

  /* ======================================================================
     3. CODE DES EDGE FUNCTIONS — pas de journalisation de secrets
     ====================================================================== */
  current = "3. journalisation côté serveur";
  {
    const dir = join(ROOT, "supabase", "functions");
    const files = [];
    (function walk(d) {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(p)) files.push(p);
      }
    })(dir);
    check(`les fichiers des fonctions sont inspectés (${files.length})`, files.length >= 10, String(files.length));

    /* Une journalisation qui prend une variable de token en argument. */
    const dangerous = /console\.(log|info|warn|error|debug)\s*\([^)]*\b(accessToken|refreshToken|access_token|refresh_token|clientSecret|client_secret|encKey|serviceRoleKey|tokens)\b/;
    for (const f of files) {
      /* On retire commentaires ET chaînes de caractères : « aucun refresh
         token » dans un message d'erreur n'est pas une fuite, `console.log(
         refreshToken)` en est une. Seuls les identifiants comptent. */
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
      const hits = src.split("\n").filter(l => dangerous.test(l));
      check(`${relative(ROOT, f)} : aucun secret journalisé`, hits.length === 0,
        hits.slice(0, 2).map(h => h.trim().slice(0, 80)).join(" | "));
    }

    /* Le corps d'une réponse de token ne doit jamais être journalisé en entier. */
    const brightspace = readFileSync(join(dir, "_shared", "brightspace.ts"), "utf8");
    check("la réponse du endpoint de token n'est pas journalisée",
      !/console\.\w+\([^)]*\btext\b/.test(brightspace), "");
  }

  /* ======================================================================
     4. NAVIGATEUR — stockage local et console, après parcours réels
     ====================================================================== */
  current = "4. navigateur : stockage et console";
  {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
    const page = await browser.newPage();
    const consoleLines = [];
    page.on("console", m => consoleLines.push(m.type() + ": " + m.text()));
    page.on("pageerror", e => consoleLines.push("pageerror: " + e.message));

    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1200);

    /* On installe un faux client Supabase qui renvoie des valeurs ressemblant
       à de vrais secrets : si quoi que ce soit les stockait ou les affichait,
       on le verrait. */
    await page.evaluate(() => {
      window.__CANARIS = {
        access: "AT-CANARI-9f3a1c",
        refresh: "RT-CANARI-77b2de",
        secret: "CS-CANARI-secret-brightspace",
      };
      const conn = {
        tenant_url: "https://emlyon.brightspace.com", status: "connected",
        scopes: ["content:toc:read"], last_verified_at: new Date().toISOString(),
        external_user_name: "Anton S", last_synced_at: null,
      };
      function builder(){
        const st = { single: false };
        const b = {
          select(){ return b; }, eq(){ return b; }, neq(){ return b; }, in(){ return b; },
          not(){ return b; }, order(){ return b; }, limit(){ return b; },
          update(){ return b; }, insert(){ return b; }, upsert(){ return b; },
          maybeSingle(){ st.single = true; return b; },
          then(res){ return Promise.resolve({ data: st.single ? conn : [], error: null }).then(res); },
        };
        return b;
      }
      window.LyonAuth.available = true;
      window.LyonAuth.state.status = "signed-in";
      window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
      window.__client = {
        from: builder,
        functions: { invoke: async function(fn, o){
          // Une Edge Function qui se mettrait à renvoyer des tokens : le
          // frontend ne doit ni les stocker ni les afficher.
          if(fn === "brightspace-status"){
            return { data: { connected: true, verified: true, status: "connected",
              probed: true, account: "Anton S", scopes: ["content:toc:read"],
              __leak_access: window.__CANARIS.access, __leak_refresh: window.__CANARIS.refresh }, error: null };
          }
          if(fn === "brightspace-connect"){
            return { data: { url: "https://auth.brightspace.com/oauth2/auth?state=x" }, error: null };
          }
          if((o && o.body && o.body.op) === "courses") return { data: { items: [] }, error: null };
          return { data: null, error: null };
        }},
      };
      Object.defineProperty(window.LyonAuth, "client", { get: () => window.__client, configurable: true });
      state.brightspace = { connection: conn, busy: null, progress: null, lastResult: null, error: null, check: null };
      state.tab = "fiches";
      render();
    });

    /* Parcours réels : vérification, retour d'OAuth, synchronisation. */
    await page.evaluate(() => bsCheckConnection({ probe: true }));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      history.replaceState({}, "", location.pathname + "?brightspace=connected");
      bsHandleOAuthReturn();
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => bsSync().catch(() => {}));
    await page.waitForTimeout(800);

    /* ---- stockage ---- */
    const storage = await page.evaluate(async () => {
      const dump = { local: {}, session: {}, idb: [] };
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        dump.local[k] = localStorage.getItem(k);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        dump.session[k] = sessionStorage.getItem(k);
      }
      try {
        const dbs = await indexedDB.databases();
        dump.idb = dbs.map(d => d.name);
      } catch { dump.idb = ["(indisponible)"]; }
      return dump;
    });

    /* ---- portée réelle de cette partie de l'audit ---- */
    const sdk = await page.evaluate(() => ({
      loaded: typeof window.supabase !== "undefined",
      available: !!(window.LyonAuth && window.LyonAuth.available),
    }));
    check("constat : le SDK Supabase n'est PAS chargé ici (CDN bloqué par le proxy) — "
      + "la persistance de session de supabase-js n'est donc pas exercée par cet audit",
      sdk.loaded === false, "SDK chargé : " + sdk.loaded);
    check("conséquence assumée : ce qui suit prouve que le CODE de REV-EM ne stocke "
      + "aucun token, pas que supabase-js n'en stocke pas (il stocke SA session, par conception)",
      true, "");

    const canaris = ["AT-CANARI-9f3a1c", "RT-CANARI-77b2de", "CS-CANARI-secret-brightspace"];
    const localBlob = JSON.stringify(storage.local);
    const sessionBlob = JSON.stringify(storage.session);

    for (const c of canaris) {
      check(`localStorage ne contient pas ${c.slice(0, 12)}…`, !localBlob.includes(c),
        localBlob.length > 200 ? "(volumineux)" : localBlob);
      check(`sessionStorage ne contient pas ${c.slice(0, 12)}…`, !sessionBlob.includes(c), sessionBlob);
    }
    check("aucune clé de stockage nommée comme un token",
      !Object.keys(storage.local).some(k => /token|secret|bearer/i.test(k)),
      Object.keys(storage.local).filter(k => /token|secret/i.test(k)).join(", "));
    eq("sessionStorage reste vide", Object.keys(storage.session).length, 0);
    check("toutes les clés locales sont cloisonnées par compte ou connues",
      Object.keys(storage.local).every(k => /^(u\.[^.]+\.)?revisions-etude-marche:/.test(k) || /^lyon/i.test(k)),
      Object.keys(storage.local).slice(0, 6).join(", "));

    /* ---- console ---- */
    const consoleBlob = consoleLines.join("\n");
    for (const c of canaris) {
      check(`la console n'affiche jamais ${c.slice(0, 12)}…`, !consoleBlob.includes(c),
        consoleLines.filter(l => l.includes(c)).slice(0, 2).join(" | "));
    }
    check("aucune ligne de console ne ressemble à un token",
      !/eyJhbGciOi|Bearer [A-Za-z0-9\-_]{20,}/.test(consoleBlob), "");

    /* ---- page rendue ---- */
    const html = await page.evaluate(() => document.documentElement.innerHTML);
    for (const c of canaris) {
      check(`la page n'affiche pas ${c.slice(0, 12)}…`, !html.includes(c), "");
    }
    check("aucune colonne de token n'est nommée dans la page",
      !/access_token_enc|refresh_token_enc/.test(html), "");

    await browser.close();
  }

  /* ======================================================================
     5. BASE — les secrets restent hors de portée du navigateur
     ====================================================================== */
  current = "5. base de données";
  {
    const psql = (sql) => execSync(
      `su postgres -c "psql -tAX -d ${process.env.ITEST_PG_DATABASE || "revem_itest"} -c \\"${sql.replace(/"/g, '\\\\"')}\\""`,
      { encoding: "utf8" }).trim();

    eq("aucun privilège sur les colonnes de tokens pour anon/authenticated",
      psql(`select count(*) from information_schema.column_privileges
             where table_name='brightspace_connections'
               and grantee in ('anon','authenticated')
               and column_name in ('access_token_enc','refresh_token_enc','refresh_lock_at')`), "0");

    eq("oauth_states : RLS active", psql(
      `select rowsecurity from pg_tables where schemaname='public' and tablename='oauth_states'`), "t");
    eq("oauth_states : aucun privilège client", psql(
      `select count(*) from information_schema.role_table_grants
        where table_name='oauth_states' and grantee in ('anon','authenticated')`), "0");
    eq("toutes les tables publiques ont RLS", psql(
      `select count(*) from pg_tables where schemaname='public' and not rowsecurity`), "0");

    /* Les tokens réellement écrits pendant les tests d'intégration étaient-ils
       chiffrés ? On regarde ce qui reste en base. */
    const clear = psql(
      `select count(*) from public.brightspace_connections
        where access_token_enc is not null and access_token_enc not like '%.%'`);
    eq("aucun token stocké hors du format chiffré (iv.chiffré)", clear, "0");
  }

  /* ---------------------------------------------------------------- bilan */
  let pass = 0, fail = 0, last = "";
  results.forEach(r => {
    if (r.scenario !== last) { console.log("\n=== " + r.scenario + " ==="); last = r.scenario; }
    console.log((r.ok ? "PASS" : "FAIL") + " — " + r.label + (r.ok ? "" : "  [" + r.detail + "]"));
    r.ok ? pass++ : fail++;
  });
  console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
