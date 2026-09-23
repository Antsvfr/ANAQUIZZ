/* ============================================================================
   REV-EM — « Connecté » ne s'affiche que si OAuth a réellement réussi
   ----------------------------------------------------------------------------
   Prérequis :
     1. servir le dépôt :        python3 -m http.server 9109
     2. NODE_PATH=/opt/node22/lib/node_modules node tests/oauth-ui.test.js

   Ce test charge la vraie page et remplace uniquement le client Supabase et
   l'appel aux Edge Functions par des doubles de même forme. Il vérifie la
   règle la plus importante de l'étape OAuth : l'interface n'annonce JAMAIS une
   connexion Brightspace qu'elle n'a pas constatée côté serveur.
   ============================================================================ */
const { chromium } = require("playwright");
const results = [];
function assert(c, l, d){ results.push({ l, pass: !!c, d: d || "" }); }

/* Client Supabase factice : uniquement ce que la page utilise. */
const FAKE = `
window.__conn = null;              // ligne brightspace_connections
window.__statusReply = null;       // réponse de l'Edge Function brightspace-status
window.__invoked = [];

function builder(){
  const st = { single: false };
  const b = {
    select(){ return b; }, eq(){ return b; }, neq(){ return b; },
    order(){ return b; }, limit(){ return b; }, in(){ return b; }, not(){ return b; },
    update(){ return b; }, insert(){ return b; }, upsert(){ return b; },
    maybeSingle(){ st.single = true; return b; },
    then(res){ return Promise.resolve({ data: st.single ? window.__conn : [], error: null }).then(res); },
  };
  return b;
}
window.LyonAuth.available = true;
window.LyonAuth.state.status = "signed-in";
window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
window.__client = {
  from: builder,
  functions: { invoke: async function(fn, o){
    window.__invoked.push({ fn: fn, body: o && o.body });
    if(fn === "brightspace-status") return { data: window.__statusReply, error: null };
    if(fn === "brightspace-connect") return { data: { url: "https://auth.brightspace.com/oauth2/auth?x=1" }, error: null };
    return { data: null, error: null };
  }},
};
Object.defineProperty(window.LyonAuth, "client", { get: function(){ return window.__client; }, configurable: true });
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
  await page.evaluate(FAKE);

  async function show(conn, check){
    await page.evaluate(({ conn, check }) => {
      window.__conn = conn;
      state.brightspace = { connection: conn, busy: null, progress: null, lastResult: null, error: null, check: check || null };
      state.tab = "fiches";
      render();
    }, { conn, check });
    await page.waitForTimeout(150);
    return await page.evaluate(() => document.querySelector(".src-card").textContent.replace(/\s+/g, " ").trim());
  }

  /* ---- 1. aucune connexion : on propose de se connecter, rien d'autre ---- */
  let txt = await show(null);
  assert(!/Connecté/.test(txt), "sans connexion : n'affiche pas « Connecté », got: " + txt.slice(0, 80));
  assert(!!(await page.$("#bs-connect-btn")), "sans connexion : bouton « Connecter » proposé");

  /* ---- 2. LE CAS CRITIQUE : une ligne « connected » jamais vérifiée ----
     C'est exactement ce qu'un attaquant ou un bug produirait : un statut posé
     sans qu'aucun échange OAuth n'ait abouti. L'interface ne doit pas y croire. */
  txt = await show({ tenant_url: "https://emlyon.brightspace.com", status: "connected", scopes: [], last_verified_at: null, last_synced_at: null });
  assert(!/Connecté/.test(txt), "statut « connected » NON vérifié : n'affiche pas « Connecté », got: " + txt.slice(0, 90));
  assert(!(await page.$("#bs-sync-btn")), "statut non vérifié : aucune synchronisation proposée");
  assert(!!(await page.$("#bs-connect-btn")), "statut non vérifié : on propose de (re)faire le vrai OAuth");

  /* ---- 3. connexion réellement vérifiée ---- */
  txt = await show({
    tenant_url: "https://emlyon.brightspace.com", status: "connected",
    scopes: ["content:toc:read"], last_verified_at: new Date().toISOString(),
    external_user_name: "Anton S", last_synced_at: null,
  });
  assert(/Connecté/.test(txt), "connexion vérifiée : affiche « Connecté », got: " + txt.slice(0, 90));
  assert(/Anton S/.test(txt), "nomme le compte Brightspace réellement relié");
  assert(!!(await page.$("#bs-sync-btn")), "propose la synchronisation");
  assert(!!(await page.$("#bs-check-btn")), "propose de vérifier la connexion");

  /* ---- 4. session expirée : ni connecté, ni déconnecté ---- */
  txt = await show({ tenant_url: "https://emlyon.brightspace.com", status: "expired", scopes: [], last_verified_at: new Date().toISOString() });
  assert(/expirée/i.test(txt), "session expirée : l'état est nommé, got: " + txt.slice(0, 90));
  assert(!/^Connecté/.test(txt), "session expirée : n'affiche pas « Connecté »");
  assert(!(await page.$("#bs-sync-btn")), "session expirée : pas de synchronisation proposée");
  assert(!!(await page.$("#bs-connect-btn")), "session expirée : reconnexion proposée");

  /* ---- 5. le bouton de vérification appelle réellement l'Edge Function ---- */
  await page.evaluate(() => {
    window.__invoked = [];
    window.__statusReply = { connected: true, verified: true, status: "connected", probed: true, account: "Anton S", scopes: ["content:toc:read"] };
    window.__conn = { tenant_url: "https://emlyon.brightspace.com", status: "connected", scopes: ["content:toc:read"], last_verified_at: new Date().toISOString(), external_user_name: "Anton S" };
    state.brightspace = { connection: window.__conn, busy: null, progress: null, lastResult: null, error: null, check: null };
    render();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => { const el = document.getElementById("bs-check-btn"); if(el) el.click(); });
  await page.waitForTimeout(500);
  let st = await page.evaluate(() => ({ invoked: window.__invoked, check: state.brightspace.check, busy: state.brightspace.busy }));
  assert(st.invoked.length === 1 && st.invoked[0].fn === "brightspace-status",
    "la vérification appelle brightspace-status, got: " + JSON.stringify(st.invoked));
  assert(st.invoked[0].body && st.invoked[0].body.probe === true,
    "elle demande une vérification RÉELLE (probe), got: " + JSON.stringify(st.invoked[0].body));
  assert(st.busy === null, "l'interface revient au repos après vérification");
  txt = await page.evaluate(() => document.querySelector(".src-card").textContent);
  assert(/vérifiée/i.test(txt), "le résultat de la vérification est affiché, got: " + txt.replace(/\s+/g, " ").slice(0, 120));

  /* ---- 6. vérification qui échoue : on le dit, on ne prétend rien ---- */
  await page.evaluate(() => {
    window.__statusReply = { connected: false, verified: false, status: "expired", probed: true, reconnectRequired: true };
    state.brightspace.check = null;
    render();
  });
  await page.evaluate(() => { const el = document.getElementById("bs-check-btn"); if(el) el.click(); });
  await page.waitForTimeout(500);
  txt = await page.evaluate(() => document.querySelector(".src-card").textContent);
  assert(/n'a pas pu être vérifiée|n’a pas pu être vérifiée/i.test(txt),
    "un échec de vérification est annoncé, got: " + txt.replace(/\s+/g, " ").slice(0, 140));

  /* ---- 7. retour OAuth : le paramètre d'URL ne suffit jamais ---- */
  await page.evaluate(() => {
    window.__invoked = [];
    window.__conn = null;
    window.__statusReply = { connected: false, verified: false, status: "not_connected", probed: true };
    state.brightspace = { connection: null, busy: null, progress: null, lastResult: null, error: null, check: null };
    history.replaceState({}, "", location.pathname + "?brightspace=connected");
    bsHandleOAuthReturn();
  });
  await page.waitForTimeout(600);
  st = await page.evaluate(() => ({
    invoked: window.__invoked.map(i => i.fn),
    connected: bsConnected(),
    url: location.search,
  }));
  assert(st.invoked.includes("brightspace-status"),
    "au retour d'OAuth, la connexion est revérifiée côté serveur, got: " + JSON.stringify(st.invoked));
  assert(st.connected === false,
    "un ?brightspace=connected falsifié ne suffit pas à afficher « Connecté »");
  assert(!/brightspace=/.test(st.url), "le paramètre de retour est retiré de l'URL");

  /* ---- 8. configuration incomplète côté D2L : message explicite ---- */
  await page.evaluate(() => {
    history.replaceState({}, "", location.pathname + "?brightspace=no_refresh_token");
    bsHandleOAuthReturn();
  });
  await page.waitForTimeout(300);
  txt = await page.evaluate(() => document.querySelector(".src-card").textContent);
  assert(/Enable refresh tokens/.test(txt),
    "l'absence de refresh token est expliquée sans jargon technique brut, got: " + txt.replace(/\s+/g, " ").slice(0, 160));
  assert(!/undefined|\[object/.test(txt), "aucune valeur technique brute affichée");

  /* ---- 9. aucun secret n'est manipulé par la page ---- */
  const leaks = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return {
      secret: /client_secret|CLIENT_SECRET/.test(src),
      token: /access_token_enc|refresh_token_enc/.test(src),
      service: /service_role/.test(src),
    };
  });
  assert(!leaks.secret, "aucun client_secret dans la page");
  assert(!leaks.token, "aucune colonne de token dans la page");
  assert(!leaks.service, "aucune clé service_role dans la page");

  /* ---- 10. i18n : les nouveaux états existent dans les 5 langues ---- */
  for(const lang of ["fr", "en", "es", "de", "it"]){
    const missing = await page.evaluate((l) => {
      LyonI18n.setLang(l);
      const keys = ["sources.verify", "sources.verify_ok", "sources.verify_failed", "sources.verified_as",
                    "sources.session_expired", "sources.reconnect", "sources.reconnect_needed",
                    "sources.connect_no_refresh", "sources.connect_forbidden", "sources.checking"];
      return keys.filter(k => !t(k) || t(k) === k);
    }, lang);
    assert(missing.length === 0, `[${lang}] tous les libellés OAuth sont traduits` + (missing.length ? " — manque " + missing.join(", ") : ""));
  }
  await page.evaluate(() => LyonI18n.setLang("fr"));

  const newErrs = errs.slice(baseline);
  assert(newErrs.length === 0, "aucune nouvelle erreur console, got: " + JSON.stringify(newErrs.slice(0, 3)));

  console.log("\n=== OAuth Brightspace — l'interface ne simule jamais une connexion ===");
  let p = 0;
  results.forEach(r => { console.log((r.pass ? "PASS" : "FAIL") + " - " + r.l); if(r.pass) p++; });
  console.log("\n" + p + "/" + results.length + " assertions passées");
  await b.close();
  process.exit(results.every(r => r.pass) ? 0 : 1);
})();
