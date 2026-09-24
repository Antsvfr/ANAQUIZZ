/* ============================================================================
   REV-EM — comptes multi-appareils : le BRANCHEMENT, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html, auth.js, user-data.js, translations.js : le code du produit,
       chargé et exécuté tel quel par Chromium ;
     • l'état, le rendu, le cloisonnement du stockage local par compte, la
       modale de migration, les écrans de confirmation d'e-mail ;
     • deux « appareils » : deux contextes de navigateur INDÉPENDANTS, avec
       chacun son propre localStorage — c'est ce qui fait que « retrouver ses
       données sur l'autre appareil » veut dire quelque chose ici.

   CE QUI EST REMPLACÉ, ET POURQUOI
     Le SDK Supabase (`window.supabase`) est remplacé par un double qui garde
     les données EN MÉMOIRE, PARTAGÉES entre les deux contextes. Ce n'est pas
     une base de données : les policies RLS, les contraintes d'unicité et les
     clés étrangères ne sont pas exercées ici.

     Elles le sont ailleurs, pour de vrai : tests/user-data.test.mjs fait
     tourner le MÊME user-data.js contre un PostgreSQL réel, avec le schéma
     réel, les policies réelles et deux identités distinctes. Les deux suites
     sont complémentaires — celle-ci prouve que REV-EM appelle et applique ce
     qu'il faut, l'autre prouve que la base répond et protège comme il faut.

     Ce qu'AUCUNE des deux ne prouve : qu'un e-mail part réellement, et qu'un
     vrai téléphone retrouve les données via le vrai Supabase. Voir le rapport.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/account-sync.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

/* ══════════════════════════════════════════════════════════════════════════
   LE DOUBLE DU SDK SUPABASE
   ──────────────────────────────────────────────────────────────────────────
   Injecté AVANT tout script de la page (addInitScript), donc avant auth.js :
   c'est la seule façon de faire croire à LyonAuth que Supabase est disponible.

   Les données vivent dans `globalThis.__DB`, qu'on transporte d'un contexte à
   l'autre pour simuler deux appareils partageant le même compte.
   ══════════════════════════════════════════════════════════════════════════ */
const FAKE_SDK = `
(function(){
  const CONFLICT_KEYS = {
    subjects: ["user_id","local_id"], chapters: ["user_id","local_id"],
    documents: ["user_id","local_id"], planning_events: ["user_id","local_id"],
    progress: ["user_id","kind","scope"], question_stats: ["user_id","question_uid"],
    exam_history: ["user_id","taken_at"], badges: ["user_id","badge_id"],
    ai_cards: ["user_id","builtin_chapter_id"], course_notes: ["user_id","event_id"],
    ai_history: ["user_id"], preferences: ["user_id"], study_plans: ["user_id"],
    user_stats: ["user_id"], daily_stats: ["user_id","day"],
    activities: ["user_id","ts"], chapter_visits: ["user_id","chapter_key"],
    profiles: ["id"],
  };
  const DB = globalThis.__DB = globalThis.__DB || { tables: {}, calls: [], seq: 1 };
  const rowsOf = (t) => (DB.tables[t] = DB.tables[t] || []);
  const keyOf = (t, r) => (CONFLICT_KEYS[t] || ["id"]).map(k => String(r[k])).join("|");

  function builder(table){
    const st = { op: null, payload: null, filters: [], single: false };
    const matches = (r) => st.filters.every(f =>
      f.k === "eq" ? String(r[f.c]) === String(f.v)
      : f.k === "in" ? f.v.map(String).includes(String(r[f.c]))
      : true);
    function run(){
      DB.calls.push({ table: table, op: st.op });
      try{
        if(st.op === "select"){
          const data = rowsOf(table).filter(matches).map(r => JSON.parse(JSON.stringify(r)));
          return { data: st.single ? (data[0] || null) : data, error: st.single && !data.length ? { message: "no rows" } : null };
        }
        if(st.op === "upsert" || st.op === "insert"){
          const list = Array.isArray(st.payload) ? st.payload : [st.payload];
          const out = [];
          list.forEach(row => {
            const rows = rowsOf(table);
            const i = rows.findIndex(r => keyOf(table, r) === keyOf(table, row));
            const merged = Object.assign({}, i >= 0 ? rows[i] : { id: "row-" + (DB.seq++) }, row,
              { updated_at: new Date().toISOString() });
            if(!merged.created_at) merged.created_at = new Date().toISOString();
            if(i >= 0) rows[i] = merged; else rows.push(merged);
            out.push(JSON.parse(JSON.stringify(merged)));
          });
          return { data: out, error: null };
        }
        if(st.op === "delete"){
          const rows = rowsOf(table);
          const kept = rows.filter(r => !matches(r));
          DB.tables[table] = kept;
          return { data: [], error: null };
        }
        return { data: null, error: { message: "op inconnue" } };
      }catch(e){ return { data: null, error: { message: String(e) } }; }
    }
    const b = {
      select(){ if(!st.op) st.op = "select"; return b; },
      insert(p){ st.op = "insert"; st.payload = p; return b; },
      upsert(p){ st.op = "upsert"; st.payload = p; return b; },
      delete(){ st.op = "delete"; return b; },
      eq(c, v){ st.filters.push({ k: "eq", c: c, v: v }); return b; },
      neq(){ return b; }, in(c, v){ st.filters.push({ k: "in", c: c, v: v }); return b; },
      single(){ st.single = true; return b; },
      maybeSingle(){ st.single = true; return b; },
      then(res, rej){ return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }

  const authListeners = [];
  const auth = {
    _user: null,
    onAuthStateChange(cb){ authListeners.push(cb); setTimeout(()=>cb("INITIAL_SESSION", auth._user ? { user: auth._user } : null), 0); return { data: { subscription: { unsubscribe(){} } } }; },
    async getUser(){ return { data: { user: auth._user }, error: null }; },
    async signUp(){ return { data: { user: null, session: null }, error: null }; },
    async signInWithPassword(){ return { data: { user: auth._user }, error: null }; },
    async signOut(){ auth._user = null; authListeners.forEach(cb => cb("SIGNED_OUT", null)); return { error: null }; },
    async resend(){ DB.calls.push({ table: "@auth", op: "resend" }); return { error: null }; },
    async updateUser(p){ DB.calls.push({ table: "@auth", op: "updateUser", payload: p }); return { error: null }; },
    async resetPasswordForEmail(){ DB.calls.push({ table: "@auth", op: "reset" }); return { error: null }; },
  };
  /* Utilisé par le test pour « connecter » quelqu'un. */
  globalThis.__signInAs = function(id, email){
    auth._user = { id: id, email: email };
    authListeners.forEach(cb => cb("SIGNED_IN", { user: auth._user }));
  };
  globalThis.__signOut = function(){ auth.signOut(); };

  window.supabase = {
    createClient(){
      return {
        auth: auth,
        from: builder,
        storage: { from(){ return { async createSignedUrl(){ return { data: null, error: { message: "n/a" } }; },
                                     async upload(){ return { error: null }; },
                                     async remove(){ return { error: null }; } }; } },
      };
    },
  };
  window.SUPABASE_CONFIG = { url: "https://test.supabase.co", anonKey: "sb_publishable_test" };
})();
`;

/* Ouvre un « appareil » : un contexte de navigateur isolé (localStorage propre),
   avec le double du SDK et, éventuellement, le contenu de la base partagée. */
async function device(browser, db) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /* La base partagée est semée AVANT le double du SDK : celui-ci capture
     `globalThis.__DB` par référence au moment où il s'exécute, donc la
     remplacer ensuite ne changerait rien à ce qu'il lit — l'appareil 2
     repartirait d'une base vide en croyant lire celle de l'appareil 1. */
  if (db) await ctx.addInitScript(`globalThis.__DB = ${JSON.stringify(db)};`);
  await ctx.addInitScript(FAKE_SDK);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}
const dumpDb = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__DB)));

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

/* Crée des données comme le ferait l'élève : par les fonctions du produit. */
const CREATE_DATA = (tag) => {
  state.userSubjects = [{ id: "subj_" + tag, name: "Matière " + tag, semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D" }];
  state.userChapters = [{ id: "ch_" + tag, subjectId: "subj_" + tag, num: "1", title: "Chapitre " + tag,
                          desc: "", content: "texte", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
                          createdAt: Date.now(), updatedAt: Date.now(), markedReviewed: false }];
  saveUserSubjects(); saveUserChapters();
  state.progress["chapter:ch_" + tag] = { best: 70, attempts: 2 };
  lsSet(KEY_QUIZ, state.progress);
  state.dash.totalAnswered = 20; state.dash.totalCorrect = 15;
  saveDashboardStats();
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. INVITÉ — RIEN NE CHANGE, RIEN NE PART
     ====================================================================== */
  await scenario("1. sans compte, aucune donnée ne quitte l'appareil", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "invite");
    await d.page.waitForTimeout(600);
    const db = await dumpDb(d.page);
    eq("aucune écriture distante", Object.keys(db.tables), []);
    eq("aucun appel à Supabase pour les données", db.calls.filter(c => c.table !== "profiles" && c.table !== "@auth"), []);
    const local = await d.page.evaluate(() => ({
      subjects: state.userSubjects.length,
      stocke: !!localStorage.getItem("revisions-etude-marche:user-subjects"),
    }));
    eq("les données restent en local, comme avant", local, { subjects: 1, stocke: true });
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     2. PREMIÈRE CONNEXION — L'UTILISATEUR DÉCIDE, RIEN N'EST SILENCIEUX
     ====================================================================== */
  let dbAfterA = null;
  await scenario("2. première connexion : la migration est proposée, pas imposée", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "a");
    await d.page.waitForTimeout(400);

    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1200);

    const modal = await d.page.evaluate(() => {
      const m = document.querySelector(".modal--confirm");
      if (!m) return null;
      return {
        titre: m.querySelector(".modal-title").textContent.trim(),
        corps: m.querySelector(".ds-confirm-body").textContent.trim(),
        boutons: [...m.querySelectorAll("[data-ds-confirm]")].map(b => b.dataset.dsConfirm + ":" + b.textContent.trim()),
      };
    });
    check("une modale demande ce qu'il faut faire", !!modal, modal);
    check("elle annonce le nombre d'éléments concernés", /\d/.test(modal.corps), modal.corps);
    check("elle dit que rien n'est supprimé", /supprim/i.test(modal.corps), modal.corps);
    check("« Plus tard » est proposé", modal.boutons.some(b => b.startsWith("no:")), modal.boutons);

    /* Avant la réponse, RIEN n'est parti. */
    /* On compte les LIGNES, pas les tables : lire une table vide suffit à
       en créer l'entrée côté double du SDK, ce qui ne prouve rien. */
    const before = await dumpDb(d.page);
    const lignes = Object.values(before.tables).reduce((n, rows) => n + rows.length, 0);
    eq("rien n'est envoyé avant la réponse", lignes, 0);

    await d.page.click('[data-ds-confirm="yes"]');
    await d.page.waitForTimeout(1500);

    const db = await dumpDb(d.page);
    check("les matières sont parties", (db.tables.subjects || []).length === 1, db.tables.subjects);
    check("les chapitres aussi", (db.tables.chapters || []).length === 1, db.tables.chapters);
    check("la progression aussi", (db.tables.progress || []).length === 1, db.tables.progress);
    check("les compteurs aussi", (db.tables.user_stats || []).length === 1, db.tables.user_stats);
    eq("et ils portent bien l'identifiant du compte",
      [...new Set((db.tables.subjects || []).map(r => r.user_id))], [USER_A]);
    eq("aucune erreur JavaScript", d.errors, []);
    dbAfterA = db;
    await d.ctx.close();
  });

  /* ======================================================================
     3. DEUXIÈME APPAREIL — LES DONNÉES SONT LÀ
     ====================================================================== */
  await scenario("3. un autre appareil retrouve tout après connexion", async () => {
    const d = await device(browser, dbAfterA);
    /* Appareil vierge : aucune donnée locale. */
    const avant = await d.page.evaluate(() => ({
      subjects: state.userSubjects.length, chapters: state.userChapters.length,
    }));
    eq("il ne contient rien au départ", avant, { subjects: 0, chapters: 0 });

    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1800);

    /* Aucune modale : cet appareil n'a rien à envoyer, il n'y a rien à arbitrer. */
    const modale = await d.page.evaluate(() => !!document.querySelector(".modal--confirm"));
    check("aucune question inutile n'est posée", !modale, modale);

    const apres = await d.page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name),
      chapters: state.userChapters.map(c => c.title),
      progress: state.progress,
      totalAnswered: state.dash.totalAnswered,
      cacheLocal: !!localStorage.getItem("revisions-etude-marche:u." + LyonAuth.state.user.id + ".user-subjects"),
    }));
    eq("les matières sont retrouvées", apres.subjects, ["Matière a"]);
    eq("les chapitres aussi", apres.chapters, ["Chapitre a"]);
    eq("la progression aussi", apres.progress, { "chapter:ch_a": { best: 70, attempts: 2 } });
    eq("les compteurs aussi", apres.totalAnswered, 20);
    check("et le cache local de cet appareil est renseigné", apres.cacheLocal, apres);

    /* L'interface affiche réellement la matière retrouvée. */
    const visible = await d.page.evaluate(() => {
      libGoto("subjects"); switchTab("library");
      return document.getElementById("content").textContent;
    });
    check("la matière est visible à l'écran", /Matière a/.test(visible), visible.slice(0, 200));
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     4. UNE MODIFICATION VOYAGE
     ====================================================================== */
  let dbAfterEdit = null;
  await scenario("4. une modification faite ici se retrouve là-bas", async () => {
    const d1 = await device(browser, dbAfterA);
    await d1.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d1.page.waitForTimeout(1500);

    await d1.page.evaluate(() => {
      const ch = state.userChapters[0];
      ch.title = "Chapitre révisé";
      ch.markedReviewed = true;
      ch.updatedAt = Date.now();
      saveUserChapters();
      state.progress["chapter:ch_a"] = { best: 95, attempts: 4 };
      lsSet(KEY_QUIZ, state.progress);
    });
    await d1.page.waitForTimeout(1500);
    dbAfterEdit = await dumpDb(d1.page);
    await d1.ctx.close();

    const d2 = await device(browser, dbAfterEdit);
    await d2.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d2.page.waitForTimeout(1800);
    const seen = await d2.page.evaluate(() => ({
      titre: state.userChapters[0] && state.userChapters[0].title,
      revise: state.userChapters[0] && state.userChapters[0].markedReviewed,
      best: state.progress["chapter:ch_a"] && state.progress["chapter:ch_a"].best,
    }));
    eq("le nouveau titre est arrivé", seen.titre, "Chapitre révisé");
    check("l'état « révisé » aussi", seen.revise === true, seen);
    eq("le meilleur score aussi", seen.best, 95);
    eq("aucune erreur JavaScript", d2.errors, []);
    await d2.ctx.close();
  });

  /* ======================================================================
     5. CHANGEMENT DE COMPTE — AUCUNE FUITE
     ====================================================================== */
  await scenario("5. B ne voit jamais les données de A", async () => {
    const d = await device(browser, dbAfterEdit);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1600);
    const vuParA = await d.page.evaluate(() => state.userChapters.map(c => c.title));
    eq("A voit les siennes", vuParA, ["Chapitre révisé"]);

    /* Déconnexion, puis connexion de B SUR LE MÊME APPAREIL. */
    await d.page.evaluate(() => globalThis.__signOut());
    await d.page.waitForTimeout(1200);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_B, "b@test.invalid"]);
    await d.page.waitForTimeout(1600);

    const vuParB = await d.page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name),
      chapters: state.userChapters.map(c => c.title),
      progress: Object.keys(state.progress),
      totalAnswered: state.dash.totalAnswered,
      ecran: document.getElementById("content").textContent,
    }));
    eq("B n'hérite d'aucune matière de A", vuParB.subjects, []);
    eq("ni d'aucun chapitre", vuParB.chapters, []);
    eq("ni d'aucune progression", vuParB.progress, []);
    eq("ni d'aucun compteur", vuParB.totalAnswered, 0);
    check("et rien de A n'apparaît à l'écran", !/Chapitre révisé|Matière a/.test(vuParB.ecran), "");

    /* B crée ses propres données, puis A revient : chacun retrouve les siennes. */
    await d.page.evaluate(CREATE_DATA, "b");
    await d.page.waitForTimeout(400);
    const modalB = await d.page.evaluate(() => !!document.querySelector(".modal--confirm"));
    if (modalB) await d.page.click('[data-ds-confirm="yes"]');
    await d.page.waitForTimeout(1500);

    await d.page.evaluate(() => globalThis.__signOut());
    await d.page.waitForTimeout(1000);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1800);
    const retourA = await d.page.evaluate(() => state.userChapters.map(c => c.title));
    eq("A retrouve exactement les siennes", retourA, ["Chapitre révisé"]);

    const db = await dumpDb(d.page);
    const parUser = {};
    (db.tables.subjects || []).forEach(r => { parUser[r.user_id] = (parUser[r.user_id] || 0) + 1; });
    eq("chaque compte a ses propres lignes", parUser, { [USER_A]: 1, [USER_B]: 1 });
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     6. DÉCONNEXION — ON ÉCRIT, PUIS ON EFFACE LE CACHE
     ====================================================================== */
  await scenario("6. la déconnexion n'efface qu'après avoir enregistré", async () => {
    const d = await device(browser, dbAfterEdit);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1600);

    const avant = await d.page.evaluate((uid) =>
      localStorage.getItem("revisions-etude-marche:u." + uid + ".user-chapters") !== null, USER_A);
    check("le cache du compte existe pendant la session", avant, avant);

    await d.page.evaluate(() => globalThis.__signOut());
    await d.page.waitForTimeout(1500);

    const apres = await d.page.evaluate((uid) => ({
      cache: localStorage.getItem("revisions-etude-marche:u." + uid + ".user-chapters"),
      etat: state.userChapters.length,
      invite: localStorage.getItem("revisions-etude-marche:user-chapters"),
    }), USER_A);
    eq("le cache du compte est effacé à la déconnexion", apres.cache, null);
    eq("l'état affiché ne contient plus ses données", apres.etat, 0);

    /* Et surtout : ce n'est pas une perte, la donnée est dans le compte. */
    const db = await dumpDb(d.page);
    eq("les données sont toujours dans le compte",
      (db.tables.chapters || []).filter(r => r.user_id === USER_A).map(r => r.title), ["Chapitre révisé"]);

    /* Se reconnecter les fait revenir. */
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1800);
    eq("et elles reviennent à la reconnexion",
      await d.page.evaluate(() => state.userChapters.map(c => c.title)), ["Chapitre révisé"]);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     7. « PLUS TARD » — ON NE SYNCHRONISE PAS DANS SON DOS
     ====================================================================== */
  await scenario("7. refuser la migration ne pousse rien en douce", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "refus");
    await d.page.waitForTimeout(400);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_B, "b@test.invalid"]);
    await d.page.waitForTimeout(1200);
    await d.page.click('[data-ds-confirm="no"]');
    await d.page.waitForTimeout(800);

    /* Nouvelle écriture locale APRÈS le refus : elle ne doit pas partir. */
    await d.page.evaluate(() => { state.userSubjects.push({ id: "subj_x", name: "Après refus" }); saveUserSubjects(); });
    await d.page.waitForTimeout(1500);

    const db = await dumpDb(d.page);
    eq("aucune matière n'est partie", (db.tables.subjects || []).length, 0);
    const local = await d.page.evaluate(() => state.userSubjects.map(s => s.name));
    check("et les données locales sont intactes", local.includes("Après refus"), local);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     8. L'INDICATEUR DIT LA VÉRITÉ
     ====================================================================== */
  await scenario("8. l'état de la synchronisation est visible, sans être bruyant", async () => {
    const d = await device(browser, dbAfterEdit);
    const cache = await d.page.evaluate(() => {
      const el = document.getElementById("cloud-indicator");
      return { present: !!el, cache: el ? el.hidden : null };
    });
    check("l'indicateur existe", cache.present, cache);
    check("mais reste caché sans compte", cache.cache === true, cache);

    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1800);
    const idle = await d.page.evaluate(() => {
      const el = document.getElementById("cloud-indicator");
      return { cache: el.hidden, classe: el.className };
    });
    check("et redevient discret une fois tout enregistré", idle.cache === true, idle);

    /* Une panne doit se voir. */
    const erreur = await d.page.evaluate(async () => {
      cloudState = { phase: "error", at: Date.now(), errors: [] };
      updateCloudIndicator();
      const el = document.getElementById("cloud-indicator");
      return { cache: el.hidden, classe: el.className, titre: el.getAttribute("title") };
    });
    check("une erreur, elle, est affichée", erreur.cache === false, erreur);
    check("avec une classe d'état", /is-error/.test(erreur.classe), erreur.classe);
    check("et un libellé compréhensible, sans jargon",
      erreur.titre && erreur.titre.length > 10 && !/error|exception|null/i.test(erreur.titre), erreur.titre);
    await d.ctx.close();
  });

  /* ======================================================================
     9. LES ÉCRANS DE CONFIRMATION D'E-MAIL, DANS LES CINQ LANGUES
     ====================================================================== */
  const ETATS = [
    ["#type=signup&access_token=x", "confirmed"],
    ["#type=recovery&access_token=x", "recovery"],
    ["#type=email_change&access_token=x", "email_changed"],
    ["?error=access_denied&error_code=otp_expired", "expired"],
  ];
  await scenario("9. le retour d'un lien e-mail est expliqué, jamais muet", async () => {
    for (const [frag, attendu] of ETATS) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(FAKE_SDK);
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", e => errs.push(String(e)));
      await page.goto(APP + frag);
      await page.waitForTimeout(1400);

      const r = await page.evaluate(() => ({
        etat: state.accountUI.linkResult,
        onglet: state.tab,
        texte: document.getElementById("content").textContent.replace(/\s+/g, " ").trim(),
        url: location.href,
      }));
      eq(`[${attendu}] l'état est reconnu`, r.etat, attendu);
      eq(`[${attendu}] et l'écran du compte est affiché`, r.onglet, "myspace");
      check(`[${attendu}] le jeton est retiré de l'URL`,
        !/access_token|error_code|type=/.test(r.url), r.url);
      check(`[${attendu}] un message explique la situation`, r.texte.length > 40, r.texte.slice(0, 120));
      check(`[${attendu}] sans clé de traduction brute`, !/auth\.[a-z_]+/.test(r.texte), r.texte.slice(0, 160));
      eq(`[${attendu}] aucune erreur JavaScript`, errs, []);

      if (attendu === "recovery") {
        const form = await page.evaluate(() => ({
          champs: document.querySelectorAll("#account-newpass-form input[type=password]").length,
        }));
        eq("le formulaire de nouveau mot de passe est là", form.champs, 2);
      }
      await ctx.close();
    }

    /* Les cinq langues, sur l'écran de confirmation. */
    for (const lang of ["fr", "en", "es", "de", "it"]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(FAKE_SDK);
      await ctx.addInitScript(`try{ localStorage.setItem("lyon-lang", ${JSON.stringify(lang)}); }catch(e){}`);
      const page = await ctx.newPage();
      await page.goto(APP + "#type=signup&access_token=x");
      await page.waitForTimeout(1300);
      await page.evaluate(l => LyonI18n.setLang(l), lang);
      await page.waitForTimeout(400);
      const txt = await page.evaluate(() => {
        const h = document.querySelector("#account-section h2");
        const p = document.querySelector("#account-section p");
        const b = document.getElementById("account-continue-btn");
        return { titre: h && h.textContent.trim(), corps: p && p.textContent.trim(), cta: b && b.textContent.trim() };
      });
      check(`[${lang}] l'écran « compte confirmé » est traduit`,
        !!txt.titre && !!txt.corps && !!txt.cta
        && !/auth\./.test(txt.titre + txt.corps + txt.cta), txt);
      await ctx.close();
    }
  });

  /* ======================================================================
     10. RENVOYER L'E-MAIL
     ====================================================================== */
  await scenario("10. « Renvoyer l'e-mail » est proposé et fonctionne", async () => {
    const d = await device(browser);
    await d.page.evaluate(() => {
      state.accountUI.pendingConfirmationEmail = "eleve@test.invalid";
      switchTab("myspace");
    });
    await d.page.waitForTimeout(500);

    const ui = await d.page.evaluate(() => {
      const b = document.getElementById("account-resend-btn");
      const txt = document.getElementById("account-section").textContent;
      return { bouton: !!b, libelle: b && b.textContent.trim(), rappelleEmail: /eleve@test\.invalid/.test(txt) };
    });
    check("le bouton est là", ui.bouton, ui);
    check("il porte un libellé traduit", ui.libelle && !/auth\./.test(ui.libelle), ui.libelle);
    check("et l'adresse concernée est rappelée", ui.rappelleEmail, ui);

    await d.page.click("#account-resend-btn");
    await d.page.waitForTimeout(700);
    const db = await dumpDb(d.page);
    eq("Supabase est bien sollicité", db.calls.filter(c => c.op === "resend").length, 1);
    const msg = await d.page.evaluate(() => {
      const el = document.getElementById("account-form-msg");
      return el ? el.textContent.trim() : "";
    });
    check("et l'utilisateur est informé", /eleve@test\.invalid/.test(msg), msg);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     11. AUCUN SECRET DANS LE FRONTEND
     ====================================================================== */
  await scenario("11. rien de secret n'est exposé ni stocké", async () => {
    const d = await device(browser, dbAfterEdit);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1600);

    const s = await d.page.evaluate(() => {
      const dump = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        dump.push(k + "=" + String(localStorage.getItem(k)).slice(0, 400));
      }
      const blob = dump.join("\n");
      return {
        serviceRole: /service_role|SUPABASE_SERVICE/i.test(blob),
        motDePasse: /"password"|password=/i.test(blob),
        refresh: /refresh_token/i.test(blob),
        cleConfig: (window.SUPABASE_CONFIG || {}).anonKey || "",
      };
    });
    check("aucune service_role key dans le stockage", !s.serviceRole, s);
    check("aucun mot de passe stocké par REV-EM", !s.motDePasse, s);
    check("aucun jeton de rafraîchissement écrit par REV-EM", !s.refresh, s);
    check("la clé de configuration est bien une clé publique",
      /^sb_publishable_|^ey/.test(s.cleConfig), s.cleConfig.slice(0, 20));
    await d.ctx.close();
  });

  /* ======================================================================
     12. CHANGEMENT D'ADRESSE E-MAIL
     ====================================================================== */
  await scenario("12. changer d'adresse passe par Supabase, et ne ment pas", async () => {
    const d = await device(browser, dbAfterEdit);
    await d.page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [USER_A, "a@test.invalid"]);
    await d.page.waitForTimeout(1600);

    await d.page.evaluate(() => { switchTab("myspace"); openAccountEditModal(); });
    await d.page.waitForTimeout(500);

    const champ = await d.page.evaluate(() => {
      const el = document.getElementById("account-edit-email");
      const hint = el && el.parentElement.querySelector(".hint");
      return { present: !!el, valeur: el && el.value, indication: hint && hint.textContent.trim() };
    });
    check("l'adresse est modifiable", champ.present, champ);
    eq("elle est pré-remplie avec celle du compte connecté", champ.valeur, "a@test.invalid");
    check("et l'interface annonce la confirmation à venir",
      champ.indication && champ.indication.length > 20 && !/account\./.test(champ.indication), champ.indication);

    /* Une adresse invalide est refusée avant tout appel réseau. */
    await d.page.evaluate(() => { document.getElementById("account-edit-email").value = "pas-une-adresse"; });
    await d.page.click("#account-modal-save");
    await d.page.waitForTimeout(600);
    const refus = await d.page.evaluate(() => ({
      message: (document.getElementById("account-edit-msg") || {}).textContent || "",
      appels: globalThis.__DB.calls.filter(c => c.op === "updateUser").length,
    }));
    check("une adresse invalide est refusée", refus.message.length > 5, refus.message);
    eq("et rien n'est envoyé à Supabase", refus.appels, 0);

    /* Une adresse valide déclenche le mécanisme Supabase prévu. */
    await d.page.evaluate(() => { document.getElementById("account-edit-email").value = "nouvelle@test.invalid"; });
    await d.page.click("#account-modal-save");
    await d.page.waitForTimeout(900);
    const envoi = await d.page.evaluate(() => ({
      appels: globalThis.__DB.calls.filter(c => c.op === "updateUser"),
      toast: (document.querySelector(".toast") || {}).textContent || "",
    }));
    eq("Supabase est appelé une fois", envoi.appels.length, 1);
    eq("avec la nouvelle adresse", envoi.appels[0].payload, { email: "nouvelle@test.invalid" });
    check("et on annonce que la confirmation reste à faire",
      /confirmation|lien/i.test(envoi.toast), envoi.toast);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
