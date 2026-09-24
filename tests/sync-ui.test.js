/* ============================================================================
   REV-EM — test de branchement : index.html ↔ moteur de synchronisation
   ----------------------------------------------------------------------------
   Prérequis :
     1. servir le dépôt :        python3 -m http.server 9109
     2. Playwright + Chromium :  NODE_PATH=/opt/node22/lib/node_modules \
                                 node tests/sync-ui.test.js

   Ce test ne simule PAS le moteur : il charge la vraie page, remplace
   uniquement le client Supabase et l'Edge Function par des doubles de la MÊME
   FORME (from/select/upsert/update, functions.invoke), puis appelle le vrai
   bsSync(). Il vérifie donc le branchement réel — y compris que les créations
   passent bien par un upsert `on conflict (user_id, source, external_id)`.

   Ce qu'il ne prouve pas : que Brightspace répond comme le double le simule.
   Seul un vrai tenant peut l'établir (voir BRIGHTSPACE_SETUP.md).
   ============================================================================ */
const { chromium } = require("playwright");
const results = [];
function assert(c, l, d){ results.push({ l, pass: !!c, d: d||"" }); }

const FAKE = `
window.__ops = [];
window.__tenant = {
  courses: [{OrgUnit:{Id:101,Name:"Économie internationale",Code:"ECO"}},
            {OrgUnit:{Id:202,Name:"Stratégie",Code:"STR"}}],
  content: { "101":[{Type:"module",Id:1001,Title:"Introduction",Structure:[{Id:9001,Title:"Plan",Url:"/a.pdf",TopicType:1}]},
                    {Type:"module",Id:1002,Title:"Marchés",Structure:[]}],
             "202":[{Type:"module",Id:2001,Title:"Cadre",Structure:[]}] }
};
window.__db = { subjects: [], chapters: [], sync_runs: [], brightspace_connections: [
  { user_id:"user-a", tenant_url:"https://t.example", status:"connected", scopes:["content:toc:read"], last_synced_at:null, last_verified_at:new Date().toISOString(), external_user_name:"Anton S", last_error:null, token_expires_at:null }
]};
window.__delay = 0;
window.__invokeCount = 0;

function match(row, filters){
  return filters.every(function(f){
    if(f[0].indexOf("!") === 0) return row[f[0].slice(1)] !== f[1];
    return String(row[f[0]]) === String(f[1]);
  });
}
function exec(st){
  const t = window.__db[st.table];
  window.__ops.push({ table: st.table, op: st.op, onConflict: st.onConflict || null });
  if(st.op === "select"){
    const rows = t.filter(function(r){ return match(r, st.filters); });
    return { data: st.single ? (rows[0] || null) : rows, error: null };
  }
  if(st.op === "insert"){
    const row = Object.assign({ id: "id" + (++window.__seq) }, st.row);
    t.push(row);
    return { data: st.single ? { id: row.id } : [{ id: row.id }], error: null };
  }
  if(st.op === "upsert"){
    const r = st.row;
    const found = t.find(function(x){
      return x.user_id === r.user_id && x.source === r.source && String(x.external_id) === String(r.external_id);
    });
    if(found){ Object.assign(found, r); return { data: { id: found.id }, error: null }; }
    const row = Object.assign({ id: "id" + (++window.__seq) }, r);
    t.push(row);
    return { data: { id: row.id }, error: null };
  }
  if(st.op === "update"){
    t.filter(function(r){ return match(r, st.filters); }).forEach(function(r){ Object.assign(r, st.row); });
    return { data: null, error: null };
  }
  return { data: null, error: null };
}
window.__seq = 0;
function builder(table){
  const st = { table: table, op: null, row: null, filters: [], single: false, onConflict: null };
  const b = {
    select: function(){ if(!st.op) st.op = "select"; return b; },
    insert: function(r){ st.op = "insert"; st.row = r; return b; },
    upsert: function(r, o){ st.op = "upsert"; st.row = r; st.onConflict = o && o.onConflict; return b; },
    update: function(r){ st.op = "update"; st.row = r; return b; },
    eq: function(c, v){ st.filters.push([c, v]); return b; },
    neq: function(c, v){ st.filters.push(["!" + c, v]); return b; },
    in: function(){ return b; }, not: function(){ return b; },
    order: function(){ return b; }, limit: function(){ return b; },
    maybeSingle: function(){ st.single = true; return b; },
    then: function(res, rej){ return Promise.resolve(exec(st)).then(res, rej); },
  };
  return b;
}
window.LyonAuth.available = true;
window.LyonAuth.state.status = "signed-in";
window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
window.__client = {
  from: builder,
  functions: { invoke: async function(fn, o){
    window.__invokeCount++;
    if(window.__delay) await new Promise(function(r){ setTimeout(r, window.__delay); });
    const body = o.body;
    if(body.op === "courses") return { data: { items: window.__tenant.courses }, error: null };
    if(body.op === "content") return { data: { items: window.__tenant.content[String(body.orgUnitId)] || [] }, error: null };
    return { data: null, error: null };
  }},
};
Object.defineProperty(window.LyonAuth, "client", { get: function(){ return window.__client; }, configurable: true });
state.brightspace = { connection: { tenant_url:"https://t.example", status:"connected", scopes:[], last_synced_at:null, last_verified_at:new Date().toISOString(), external_user_name:"Anton S" }, busy:null, progress:null, lastResult:null, error:null, check:null };
`;

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await b.newPage();
  const errs = [];
  page.on("console", m => { if(m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", e => errs.push("pageerror: " + e.message));

  await page.goto("http://localhost:9109/index.html");
  await page.waitForTimeout(1400);
  const baseline = errs.length;

  /* les nouveaux modules sont chargés */
  const mods = await page.evaluate(() => ({
    sync: !!(window.LyonSync && typeof LyonSync.createEngine === "function"),
    adapters: !!(window.LyonSourceAdapters && typeof LyonSourceAdapters.defineAdapter === "function"),
    locals: window.LyonSourceAdapters ? LyonSourceAdapters.list().map(a => a.id).sort().join(",") : "",
    bsRegistered: window.LyonSourceAdapters ? LyonSourceAdapters.has("brightspace") : null,
  }));
  assert(mods.sync, "sync-engine.js est chargé dans la page");
  assert(mods.adapters, "source-adapters.js est chargé dans la page");
  assert(mods.locals === "manual,pdf", "sources locales enregistrées au chargement, got: " + mods.locals);
  assert(mods.bsRegistered === false, "Brightspace n'est PAS enregistré tant qu'il n'y a pas de session");

  await page.evaluate(FAKE);
  await page.evaluate(() => switchTab("fiches"));
  await page.waitForTimeout(200);

  /* ---- première synchronisation, via le vrai bsSync() ---- */
  await page.evaluate(() => bsSync());
  await page.waitForTimeout(800);

  let st = await page.evaluate(() => ({
    subjects: window.__db.subjects.length,
    chapters: window.__db.chapters.length,
    runs: window.__db.sync_runs.map(r => ({ status: r.status, hasCounts: !!r.counts })),
    result: state.brightspace.lastResult,
    busy: state.brightspace.busy,
    error: state.brightspace.error,
    upserts: window.__ops.filter(o => o.op === "upsert").map(o => o.onConflict),
    registered: LyonSourceAdapters.has("brightspace"),
  }));
  assert(st.registered, "l'adaptateur Brightspace est enregistré à la première synchronisation");
  assert(st.error === null, "aucune erreur, got: " + st.error);
  assert(st.subjects === 2, "2 matières écrites en base, got: " + st.subjects);
  assert(st.chapters === 3, "3 chapitres écrits en base, got: " + st.chapters);
  assert(st.upserts.length === 5 && st.upserts.every(c => c === "user_id,source,external_id"),
    "les créations passent par un upsert idempotent, got: " + JSON.stringify(st.upserts));
  assert(st.result && st.result.subjectsCreated === 2 && st.result.chaptersCreated === 3,
    "le rapport affiché correspond au travail réel, got: " + JSON.stringify(st.result));
  assert(st.runs.length === 1 && st.runs[0].status === "completed",
    "le journal est clos en 'completed', got: " + JSON.stringify(st.runs));
  assert(st.busy === null, "l'état revient au repos");

  /* la section affiche les chiffres */
  let txt = await page.evaluate(() => document.querySelector(".src-card").textContent);
  assert(/5 nouveau/.test(txt), "l'interface annonce 5 nouveaux contenus, got: " + txt.replace(/\s+/g, " ").slice(0, 140));

  /* ---- deuxième synchronisation : aucun doublon ---- */
  await page.evaluate(() => bsSync());
  await page.waitForTimeout(800);
  st = await page.evaluate(() => ({
    subjects: window.__db.subjects.length, chapters: window.__db.chapters.length,
    result: state.brightspace.lastResult, runs: window.__db.sync_runs.length,
  }));
  assert(st.subjects === 2 && st.chapters === 3,
    "deuxième synchronisation : toujours 2 matières / 3 chapitres, got: " + st.subjects + "/" + st.chapters);
  assert(st.result.subjectsCreated === 0 && st.result.chaptersCreated === 0, "rien de neuf n'est créé");
  assert(st.runs === 2, "deux exécutions journalisées, got: " + st.runs);
  txt = await page.evaluate(() => document.querySelector(".src-card").textContent);
  assert(/déjà synchronisé/i.test(txt), "l'interface dit que tout est à jour");

  /* ---- dix synchronisations de plus : toujours une seule copie ---- */
  for(let i = 0; i < 8; i++){
    await page.evaluate(() => bsSync());
    await page.waitForTimeout(220);
  }
  st = await page.evaluate(() => ({ s: window.__db.subjects.length, c: window.__db.chapters.length }));
  assert(st.s === 2 && st.c === 3, "après 10 synchronisations : 2 matières / 3 chapitres, got: " + st.s + "/" + st.c);

  /* ---- annulation par le bouton ---- */
  await page.evaluate(() => { window.__delay = 250; window.__db.sync_runs.length = 0; });
  await page.evaluate(() => { bsSync(); });   // sans await : on veut annuler pendant
  await page.waitForTimeout(400);
  const hasCancel = await page.$("#bs-cancel-btn");
  assert(!!hasCancel, "un bouton d'annulation est proposé pendant la synchronisation");
  const hasSync = await page.$("#bs-sync-btn");
  assert(!hasSync, "le bouton Synchroniser est masqué pendant l'opération");
  /* clic atomique : le rendu se rafraîchit à chaque cours traité, un handle
     capturé plus tôt peut avoir été remplacé entre-temps. */
  const clicked = await page.evaluate(() => {
    const el = document.getElementById("bs-cancel-btn");
    if(!el) return false;
    el.click();
    return true;
  });
  assert(clicked, "le bouton d'annulation a pu être cliqué");
  await page.waitForTimeout(1500);

  st = await page.evaluate(() => ({
    busy: state.brightspace.busy,
    runs: window.__db.sync_runs.map(r => ({ status: r.status, cursor: r.cursor })),
    subjects: window.__db.subjects.length,
  }));
  assert(st.busy === null, "l'interface revient au repos après annulation");
  assert(st.runs.length === 1 && st.runs[0].status === "cancelled",
    "le journal enregistre 'cancelled', got: " + JSON.stringify(st.runs.map(r => r.status)));
  assert(st.subjects === 2, "l'annulation ne supprime rien, got: " + st.subjects);

  /* ---- erreur réseau : message utilisateur, pas de trace technique ---- */
  await page.evaluate(() => {
    window.__delay = 0;
    window.__db.sync_runs.length = 0;
    window.__client.functions.invoke = async function(){
      const e = new Error("Failed to fetch"); e.name = "TypeError";
      throw e;
    };
  });
  await page.evaluate(() => bsSync());
  await page.waitForTimeout(900);
  st = await page.evaluate(() => ({
    error: state.brightspace.error, busy: state.brightspace.busy,
    runs: window.__db.sync_runs.map(r => r.status),
    subjects: window.__db.subjects.length,
  }));
  assert(!!st.error, "une erreur réseau est signalée à l'utilisateur");
  assert(st.busy === null, "l'interface ne reste pas bloquée sur une erreur");
  assert(st.runs.length === 1 && st.runs[0] === "failed", "le journal enregistre 'failed', got: " + JSON.stringify(st.runs));
  assert(st.subjects === 2, "une erreur ne détruit aucune donnée déjà importée");

  const newErrs = errs.slice(baseline).filter(e => !/Failed to fetch/.test(e));
  assert(newErrs.length === 0, "aucune nouvelle erreur console, got: " + JSON.stringify(newErrs.slice(0, 3)));

  console.log("\n=== Branchement du moteur de synchronisation dans index.html ===");
  let p = 0;
  results.forEach(r => { console.log((r.pass ? "PASS" : "FAIL") + " - " + r.l); if(r.pass) p++; });
  console.log("\n" + p + "/" + results.length + " assertions passées");
  await b.close();
  process.exit(results.every(r => r.pass) ? 0 : 1);
})();
