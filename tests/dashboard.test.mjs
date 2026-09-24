/* ============================================================================
   TABLEAU DE BORD — BANNIÈRE, PLANNING AVANCÉ, SECTIONS ÉDITORIALES
   ----------------------------------------------------------------------------
   Trois questions sont posées à chaque vérification :
     • la composition dit-elle « où suis-je / qu'est-ce qui compte / que
       dois-je faire », dans cet ordre, en GRANDES SECTIONS et non en pile de
       cartes ?
     • le planning est-il une vraie section majeure — heure actuelle, cours en
       cours, prochain, timeline, jour/semaine/mois, navigation — et non un
       aperçu réduit ?
     • et surtout : AUCUNE fonctionnalité n'a-t-elle disparu ? La refonte est
       visuelle — toutes les destinations, tous les compteurs et le compteur à
       la seconde du cours en cours doivent encore répondre.

   Tout est mesuré sur la page RÉELLE, rendue par un vrai navigateur, avec une
   horloge figée pour que la journée testée soit toujours la même.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/dashboard.test.mjs
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

const VIEWPORTS = [
  { name: "bureau",   width: 1440, height: 1000 },
  { name: "tablette", width: 768,  height: 1024 },
  { name: "mobile",   width: 375,  height: 812 },
];

/* L'horloge est figée à 14 h 00 (heure locale) le jour du test : sinon un
   cours « passé » calé sur « maintenant moins 4 h » basculerait la veille
   quand les tests tournent la nuit, et la journée ne contiendrait plus ce
   qu'on prétend vérifier. */
const FROZEN_HOUR = 14;
async function freezeClock(page){
  const at = new Date(); at.setHours(FROZEN_HOUR, 0, 0, 0);
  await page.clock.install({ time: at });
}

/* Un jeu de données réel : une matière avec des chapitres travaillés, un
   planning dont un cours est EN COURS, et de l'activité récente. Sans ça, la
   moitié du tableau de bord ne serait jamais rendue par les tests.

   La journée contient volontairement quatre cours : un terminé, un en cours,
   deux à venir — et trois pauses d'au moins 20 minutes entre eux. */
const SEED = () => {
  const now = Date.now();
  const subjId = "t-subj";
  state.userSubjects = [{ id: subjId, name: "Analyse financière",
                          semesterId: (SEMESTERS[0] || {}).id, icon: "", color: "#E31C3D" }];
  state.userChapters = [
    { id: "t-ch1", subjectId: subjId, num: 1, title: "Bilan et compte de résultat",
      desc: "", content: "Texte du cours.", aiQuiz: [{ q: "?", opts: ["a","b"], correct: 0 }],
      aiFlashcards: [{ front: "a", back: "b" }], aiReviewQuestions: ["Pourquoi ?"],
      createdAt: now - 3 * 86400000, updatedAt: now - 86400000, markedReviewed: false },
    { id: "t-ch2", subjectId: subjId, num: 2, title: "Flux de trésorerie",
      desc: "", content: "Texte du cours.", aiQuiz: [], aiFlashcards: [],
      createdAt: now - 5 * 86400000, updatedAt: now - 2 * 86400000, markedReviewed: true },
  ];
  saveUserSubjects(); saveUserChapters();

  state.dash.recentChapters = [{ chapterId: "t-ch1", ts: now - 86400000 }];
  state.dash.recentActivity = [
    { type: "quiz", label: "Bilan et compte de résultat", pct: 72, ts: new Date(now - 3600000).toISOString() },
    { type: "flash", label: "Flux de trésorerie", pct: 90, ts: new Date(now - 7200000).toISOString() },
  ];
  state.dash.recentAdds = [{ label: "Analyse financière", ts: now - 2 * 86400000 }];
  state.dash.timeSpentSeconds = 4230;

  const h = 3600000;
  const at = (hh, mm) => { const d = new Date(now); d.setHours(hh, mm || 0, 0, 0); return d.getTime(); };
  state.planning.events = [
    { id: "ev-past",    summary: "Statistiques",         start: at(9),           end: at(10, 30), location: "B104" },
    { id: "ev-current", summary: "Analyse financière",   start: now - 0.5 * h,   end: now + 0.5 * h, location: "A201" },
    { id: "ev-next",    summary: "Droit des affaires",   start: at(16),          end: at(17, 30), location: "C012" },
    { id: "ev-late",    summary: "Anglais des affaires", start: at(18),          end: at(19, 30), location: "D003" },
  ];
  /* On repart toujours de la vue par défaut : aujourd'hui, en jour. */
  state.dashPlanView = "day";
  state.dashPlanDay = null;
  switchTab("dashboard");
  render();
};

/* Ouvre l'application, sème les données, attend le rendu. */
async function open(browser, vp, lang){
  const page = await browser.newPage({ viewport: vp || { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await freezeClock(page);
  await page.goto(APP);
  await page.waitForTimeout(1500);
  if (lang) { await page.evaluate(l => LyonI18n.setLang(l), lang); await page.waitForTimeout(300); }
  await page.evaluate(SEED);
  await page.waitForTimeout(400);
  return { page, errors };
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. COMPOSITION — DES SECTIONS, PAS UNE PILE DE CARTES
     ====================================================================== */
  current = "1. composition";
  {
    const { page, errors } = await open(browser);

    const h = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const top = el => Math.round(el.getBoundingClientRect().top + window.scrollY);
      const cs = el => getComputedStyle(el);
      const banner = root.querySelector(".dash-banner");
      const blocks = [...root.querySelectorAll(".dash-section-block")];
      const sectionTitles = [...root.querySelectorAll(".dash-section-title")];
      return {
        /* La bannière ouvre la page, puis les sections, dans l'ordre. */
        firstChild: root.children[0].className,
        blockCount: blocks.length,
        titles: sectionTitles.map(e => e.textContent.trim()),
        titleTags: [...new Set(sectionTitles.map(e => e.tagName))],
        /* Une section n'est PAS une carte : ni fond, ni filet, ni ombre. */
        blockShapes: [...new Set(blocks.map(b =>
          `${cs(b).backgroundColor}|${cs(b).borderTopWidth}|${cs(b).boxShadow}`))],
        /* Le planning vient juste après la bannière. */
        bannerBeforePlan: top(banner) < top(document.getElementById("dash-schedule-card")),
        planBeforeRevision: top(document.getElementById("dash-schedule-card"))
                          < top(root.querySelector(".dash-panel--priority")),
        /* Une seule action primaire sur toute la page. */
        primaries: root.querySelectorAll(".btn--primary").length,
        /* Le repère de niveau 2 devant chaque titre de section. */
        sectionMark: sectionTitles.length
          ? getComputedStyle(sectionTitles[0], "::before").backgroundColor : null,
        panelMark: getComputedStyle(root.querySelector(".dash-panel-label"), "::before").backgroundColor,
        h1: root.querySelectorAll("h1").length,
      };
    });

    eq("la bannière ouvre la page", h.firstChild, "dash-banner");
    check("quatre grandes sections structurent la page", h.blockCount === 4, h.blockCount);
    eq("leurs titres sont des h2", h.titleTags, ["H2"]);
    check("une section n'est pas une carte : ni fond, ni filet, ni ombre",
      h.blockShapes.every(s => /^rgba\(0, 0, 0, 0\)\|0px\|none$/.test(s)), h.blockShapes);
    check("le planning suit immédiatement la bannière", h.bannerBeforePlan, h);
    check("puis vient la révision", h.planBeforeRevision, h);
    eq("une seule action primaire sur la page", h.primaries, 1);
    eq("le repère de section est le rouge de niveau 2", h.sectionMark, "rgb(234, 82, 108)");
    eq("celui d'un panneau est le rouge de niveau 3", h.panelMark, "rgb(240, 137, 154)");
    eq("un seul h1 dans la page", h.h1, 1);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     2. LA BANNIÈRE — DÉGRADÉ CONSTRUIT, TEXTE BLANC, CHIFFRES RÉELS
     ====================================================================== */
  current = "2. bannière";
  {
    const { page } = await open(browser);

    const b = await page.evaluate(() => {
      const el = document.querySelector(".dash-banner");
      const cs = getComputedStyle(el);
      const stats = [...el.querySelectorAll(".dash-banner-stat")]
        .map(s => [s.querySelector("b").textContent.trim(), s.querySelector("span").textContent.trim()]);
      const g = globalMetrics();
      return {
        bg: cs.backgroundImage,
        /* Un dégradé linéaire avec plusieurs arrêts, pas un deux-tons.
           (Le dégradé linéaire est la dernière couche : les deux premières
           sont les voiles radiaux de profondeur.) */
        stops: (cs.backgroundImage.split("linear-gradient(").pop().match(/rgb/g) || []).length,
        color: cs.color,
        radius: cs.borderTopLeftRadius,
        /* Pas de flou, pas de filtre, pas de 3D : zéro coût de rendu. */
        filter: cs.filter, backdropFilter: cs.backdropFilter, transform: cs.transform,
        /* La trame et l'arc sont des pseudo-éléments, pas des images. */
        texture: getComputedStyle(el, "::before").backgroundImage,
        arc: getComputedStyle(el, "::after").borderTopWidth,
        noImage: !/url\(/.test(cs.backgroundImage),
        title: el.querySelector(".dash-banner-title").textContent.trim(),
        titleTag: el.querySelector(".dash-banner-title").tagName,
        date: el.querySelector(".dash-banner-date").textContent.trim(),
        sub: el.querySelector(".dash-banner-sub").textContent.trim(),
        stats,
        expectedMastery: g.mastery + "%",
        expectedCourses: String(eventsOnCalendarDay(new Date()).length),
        expectedRecos: String(getSmartRevisionRecommendations().length),
      };
    });

    check("le fond est un dégradé construit, à plus de deux arrêts", b.stops >= 4, b.stops);
    check("et il est diagonal, pas vertical", /118deg/.test(b.bg), b.bg);
    eq("le texte y est blanc", b.color, "rgb(255, 255, 255)");
    check("les angles sont arrondis", parseFloat(b.radius) >= 8, b.radius);
    eq("aucun flou ni filtre", [b.filter, b.backdropFilter], ["none", "none"]);
    eq("aucune transformation 3D", b.transform, "none");
    check("la profondeur vient d'une trame CSS, pas d'une image",
      /radial-gradient/.test(b.texture) && b.noImage, b);
    check("un arc discret reprend la marque", parseFloat(b.arc) > 0, b.arc);
    check("la salutation est un h1 et garde son signe de la main",
      b.titleTag === "H1" && /👋/.test(b.title), b);
    check("la date du jour est annoncée", b.date.length > 8, b.date);
    check("la phrase de contexte parle du cours en cours",
      /Analyse financière/.test(b.sub), b.sub);
    eq("trois mesures, pas une de plus", b.stats.length, 3);
    check("le nombre de cours du jour est le vrai",
      b.stats.some(([v]) => v === b.expectedCourses), b);
    check("le nombre de notions à réviser est le vrai",
      b.stats.some(([v]) => v === b.expectedRecos), b);
    check("la maîtrise est celle du moteur",
      b.stats.some(([v]) => v === b.expectedMastery), b);

    /* Sans planning, la bannière ne montre pas de chiffre de planning : elle
       n'invente rien pour remplir la ligne. */
    const bare = await page.evaluate(() => {
      state.planning.events = []; render();
      return {
        stats: [...document.querySelectorAll(".dash-banner-stat b")].map(e => e.textContent.trim()),
        sub: document.querySelector(".dash-banner-sub").textContent.trim(),
      };
    });
    check("sans planning, aucun chiffre de planning n'est inventé",
      bare.stats.length <= 2, bare.stats);
    check("et la phrase se rabat sur ce qui est vrai",
      !/Analyse financière/.test(bare.sub), bare.sub);
    await page.close();
  }

  /* ======================================================================
     2 bis. CONNECTÉ / DÉCONNECTÉ
     ====================================================================== */
  current = "2 bis. connecté / déconnecté";
  {
    const { page, errors } = await open(browser);

    const out = await page.evaluate(() => document.querySelector(".dash-banner-title").textContent.trim());
    check("déconnecté : la salutation est sans nom", /^Bonjour\s*👋$/.test(out), out);

    /* Connecté : le prénom vient du profil. On remplace la seule source de
       vérité utilisée par la bannière — ni l'auth ni le stockage ne sont
       touchés, donc le cloisonnement par compte reste intact. */
    const inn = await page.evaluate(() => {
      const real = window.getCurrentUserDisplayName;
      window.getCurrentUserDisplayName = () => "Anton";
      render();
      const txt = document.querySelector(".dash-banner-title").textContent.trim();
      const stats = document.querySelectorAll(".dash-banner-stat").length;
      window.getCurrentUserDisplayName = real;
      render();
      return { txt, stats, back: document.querySelector(".dash-banner-title").textContent.trim() };
    });
    check("connecté : le prénom est salué, le signe reste",
      /Anton/.test(inn.txt) && /👋/.test(inn.txt), inn);
    check("et le reste de la bannière est rendu pareil", inn.stats === 3, inn);
    check("le retour à l'état déconnecté est propre", /^Bonjour\s*👋$/.test(inn.back), inn);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     2 ter. LA BANNIÈRE EST LISIBLE — CONTRASTE MESURÉ SUR LES VRAIS PIXELS
     ----------------------------------------------------------------------
     Du texte blanc sur un dégradé rouge, ça se vérifie, ça ne se devine pas :
     on masque le texte, on photographie le fond réellement peint (dégradé +
     voiles + trame), on relève le pixel le plus clair sous chaque libellé, on
     y compose la couleur calculée du texte, et on calcule le rapport WCAG.
     Seuil : 4,5:1, et 3:1 pour les grands titres.
     ====================================================================== */
  current = "2 ter. contraste de la bannière";
  for (const vp of VIEWPORTS) {
    const { page } = await open(browser, { width: vp.width, height: vp.height });

    const geo = await page.evaluate(() => {
      const sels = [".dash-banner-date", ".dash-banner-title", ".dash-banner-sub",
                    ".dash-banner-stat b", ".dash-banner-stat span"];
      const items = [];
      sels.forEach(s => document.querySelectorAll(s).forEach(el => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        items.push({ sel: s, color: cs.color, size: parseFloat(cs.fontSize), weight: cs.fontWeight,
                     x: Math.round(r.left), y: Math.round(r.top),
                     w: Math.round(r.width), h: Math.round(r.height) });
      }));
      const b = document.querySelector(".dash-banner").getBoundingClientRect();
      return { items, banner: { x: Math.round(b.left), y: Math.round(b.top),
                                w: Math.round(b.width), h: Math.round(b.height) } };
    });

    await page.evaluate(() =>
      document.querySelectorAll(".dash-banner-inner").forEach(e => e.style.visibility = "hidden"));
    const b64 = (await page.screenshot({ clip: {
      x: geo.banner.x, y: geo.banner.y, width: geo.banner.w, height: geo.banner.h } })).toString("base64");
    await page.evaluate(() =>
      document.querySelectorAll(".dash-banner-inner").forEach(e => e.style.visibility = ""));

    /* La photo est relue dans un canevas de la page : on n'a pas de décodeur
       PNG côté Node, et le navigateur en a un. */
    const rows = await page.evaluate(({ b64, banner, items }) => new Promise(res => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const parse = s => { const m = s.match(/[\d.]+/g).map(Number);
                             return { r: m[0], g: m[1], b: m[2], a: m[3] === undefined ? 1 : m[3] }; };
        res(items.map(it => {
          const c = parse(it.color);
          let worst = Infinity, worstBg = null;
          for (let y = it.y - banner.y; y < it.y - banner.y + it.h; y += 2) {
            for (let x = it.x - banner.x; x < it.x - banner.x + it.w; x += 4) {
              if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue;
              const i = (cv.width * y + x) << 2;
              const bg = [px[i], px[i + 1], px[i + 2]];
              const blend = [0, 1, 2].map(k => c.a * [c.r, c.g, c.b][k] + (1 - c.a) * bg[k]);
              const Lt = lum(blend[0], blend[1], blend[2]), Lb = lum(bg[0], bg[1], bg[2]);
              const ratio = (Math.max(Lt, Lb) + 0.05) / (Math.min(Lt, Lb) + 0.05);
              if (ratio < worst) { worst = ratio; worstBg = bg; }
            }
          }
          const need = (it.size >= 24 || (it.size >= 18.66 && +it.weight >= 700)) ? 3 : 4.5;
          return { sel: it.sel, size: it.size, color: it.color,
                   worst: Math.round(worst * 100) / 100, need, bg: worstBg };
        }));
      };
      img.src = "data:image/png;base64," + b64;
    }), { b64, banner: geo.banner, items: geo.items });

    const under = rows.filter(r => r.worst < r.need);
    eq(`[${vp.name}] tout le texte de la bannière passe le seuil WCAG`, under, []);
    check(`[${vp.name}] et il reste de la marge (pire cas ≥ 4,5:1)`,
      Math.min(...rows.map(r => r.worst)) >= 4.5,
      rows.map(r => `${r.sel} ${r.worst}:1`));
    await page.close();
  }

  /* ======================================================================
     3. AUCUNE FONCTIONNALITÉ PERDUE — TOUTES LES DESTINATIONS RÉPONDENT
     ====================================================================== */
  current = "3. non-régression fonctionnelle";
  {
    const { page } = await open(browser);

    /* Chaque entrée : un sélecteur du tableau de bord, et ce qu'on doit
       observer après le clic. */
    const ROUTES = [
      ["[data-dash-import]",        () => state.tab === "library" && state.library.view === "import"],
      ["#dash-library-btn2",        () => state.tab === "library" && state.library.view === "subjects"],
      ["[data-dash-add-subject]",   () => state.tab === "library" && state.library.view === "subjectForm"],
      ["#dash-activities-btn",      () => state.tab === "activities"],
      ["#dash-start-revision",      () => state.tab === "smart" || state.tab === "activities"],
      ["#dash-exams-btn",           () => state.tab === "exams"],
      ["#dash-planning-btn",        () => state.tab === "planning"],
      ["#dash-ai-btn",              () => state.tab === "ai"],
      ["#dash-progress-link",       () => state.tab === "progress"],
      ["#dash-stats-link",          () => state.tab === "stats"],
      ["#dash-viewall-subjects",    () => state.tab === "library" && state.library.view === "subjects"],
      ["#dash-viewall-revisions",   () => state.tab === "library" && state.library.view === "subjects"],
      ["#dash-schedule-full",       () => state.tab === "planning"],
      ["[data-open-subject-dash]",  () => state.tab === "library" && state.library.view === "subjectDetail"],
      ["[data-open-revision]",      () => state.tab === "library" && state.library.view === "chapterDetail"],
    ];

    for (const [sel, assertFn] of ROUTES) {
      await page.evaluate(SEED);
      await page.waitForTimeout(250);
      const exists = await page.evaluate(s => !!document.querySelector(s), sel);
      if (!exists) { check(`« ${sel} » est présent`, false, "absent du tableau de bord"); continue; }
      await page.click(sel);
      await page.waitForTimeout(350);
      const ok = await page.evaluate(fn => {
        try { return !!new Function("return (" + fn + ")()")(); } catch (e) { return String(e); }
      }, assertFn.toString());
      check(`« ${sel} » mène au bon écran`, ok === true, ok);
    }

    /* L'ancienne destination « la semaine dans Planning » n'a pas disparu :
       elle suit désormais le sélecteur du tableau de bord. */
    await page.evaluate(SEED);
    await page.waitForTimeout(250);
    const week = await page.evaluate(() => {
      document.querySelector('[data-plan-view="week"]').click();
      document.getElementById("dash-schedule-full").click();
      return { tab: state.tab, view: state.planning.calView };
    });
    eq("depuis la vue semaine, « Voir tout le planning » ouvre la semaine",
      week, { tab: "planning", view: "week" });

    /* Reprendre la révision : le bouton existe et lance bien une session. */
    await page.evaluate(SEED);
    await page.waitForTimeout(250);
    const resumeOk = await page.evaluate(() => {
      const b = document.getElementById("dash-continue-btn");
      return !!b && b.textContent.trim().length > 0;
    });
    check("« Reprendre » est toujours proposé", resumeOk, resumeOk);

    /* La recommandation du moteur mène à la révision intelligente. */
    const smartOk = await page.evaluate(() => {
      const b = document.getElementById("dash-smart-btn");
      if (!b) return "absent";
      b.click();
      return state.tab === "smart" && state.smartScreen === "home";
    });
    check("la recommandation mène à la révision intelligente", smartOk === true, smartOk);
    await page.close();
  }

  /* ======================================================================
     4. PLANNING — VUE JOUR : EN COURS, PROCHAIN, TIMELINE, HEURE
     ====================================================================== */
  current = "4. planning — vue jour";
  {
    const { page } = await open(browser);

    const d = await page.evaluate(() => {
      const card = document.getElementById("dash-schedule-card");
      const live = card.querySelector(".dash-live");
      const next = card.querySelector(".dash-next");
      const tl = card.querySelector(".dash-timeline");
      const kids = [...tl.children];
      const rows = [...tl.querySelectorAll(".dash-tl-row")];
      const cs = el => getComputedStyle(el);
      return {
        /* L'ÉVÉNEMENT EN COURS */
        liveTitle: live ? live.querySelector(".dash-live-title button").textContent.trim() : null,
        liveBadge: live ? live.querySelector(".dash-live-badge").textContent.trim() : null,
        liveMeta: live ? live.querySelector(".dash-live-meta").textContent.trim() : null,
        liveRemaining: live ? live.querySelector("#dash-ccourse-text").textContent.trim() : null,
        liveFill: live ? live.querySelector("#dash-ccourse-fill").style.width : null,
        liveBg: live ? cs(live).backgroundColor : null,
        liveRule: live ? cs(live).borderLeftColor + " " + cs(live).borderLeftWidth : null,
        notesBtn: !!card.querySelector("[data-open-event-notes]"),
        ticker: ["dash-ccourse-progress", "dash-ccourse-fill", "dash-ccourse-text"]
          .map(id => !!document.getElementById(id)),
        evBounds: !!document.getElementById("dash-ccourse-progress")?.dataset.evStart
               && !!document.getElementById("dash-ccourse-progress")?.dataset.evEnd,

        /* LE PROCHAIN */
        nextWhen: next ? next.querySelector(".dash-next-when").textContent.trim() : null,
        nextLabel: next ? next.querySelector(".dash-next-label").textContent.trim() : null,
        nextTitle: next ? next.querySelector(".dash-next-title").textContent.trim() : null,
        nextIn: next ? next.querySelector("#dash-next-in").textContent.trim() : null,

        /* LA TIMELINE */
        rowCount: rows.length,
        times: rows.map(r => r.querySelector(".dash-tl-time").textContent.trim()),
        titles: rows.map(r => r.querySelector(".dash-tl-title").textContent.trim()),
        states: rows.map(r => r.className.replace("dash-tl-row is-", "")),
        /* Chaque ligne dit son horaire, sa durée, sa matière et son état. */
        metas: rows.map(r => r.querySelector(".dash-tl-meta").textContent.replace(/\s+/g, " ").trim()),
        gaps: [...tl.querySelectorAll(".dash-tl-gap")].map(g => g.textContent.trim()),
        /* Le rail est continu : un trait derrière chaque ligne. */
        rail: cs(rows[0].querySelector(".dash-tl-rail"), "::before").width,
        dotColors: rows.map(r => cs(r.querySelector(".dash-tl-dot")).borderTopColor),
        timeFont: cs(rows[0].querySelector(".dash-tl-time")).fontFamily.split(",")[0].replace(/"/g, ""),
        timeNums: cs(rows[0].querySelector(".dash-tl-time")).fontVariantNumeric,

        /* LE TRAIT DE L'HEURE : sa position réelle dans la journée. */
        nowIndex: kids.indexOf(tl.querySelector(".dash-tl-now")),
        afterCurrent: kids.indexOf(tl.querySelector(".dash-tl-now")) > kids.indexOf(rows[1]),
        beforeNext: kids.indexOf(tl.querySelector(".dash-tl-now")) < kids.indexOf(rows[2]),
        nowTime: tl.querySelector("#dash-tl-now-time")?.textContent.trim(),
        nowLine: tl.querySelector(".dash-tl-now-line")
          ? cs(tl.querySelector(".dash-tl-now-line")).backgroundColor : null,
      };
    });

    check("le cours en cours est mis en avant", /Analyse financière/.test(d.liveTitle), d);
    eq("il est annoncé « En cours »", d.liveBadge, "En cours");
    check("avec son horaire et sa salle", /13:30/.test(d.liveMeta) && /A201/.test(d.liveMeta), d.liveMeta);
    check("son avancement est chiffré", /^\d+% · /.test(d.liveRemaining), d.liveRemaining);
    check("et le temps restant annoncé", /30 min restantes/.test(d.liveRemaining), d.liveRemaining);
    eq("la jauge est à mi-course", d.liveFill, "50%");
    eq("le bloc est posé sur lavis", d.liveBg, "rgb(253, 242, 244)");
    eq("et coiffé à gauche d'un filet accent", d.liveRule, "rgb(227, 28, 61) 3px");
    check("« Prendre des notes » est toujours là", d.notesBtn, d.notesBtn);
    eq("le compteur à la seconde a gardé ses ancres", d.ticker, [true, true, true]);
    check("et ses bornes de temps", d.evBounds, d.evBounds);

    eq("le prochain cours est annoncé", d.nextLabel, "Prochain");
    eq("à son heure", d.nextWhen, "16:00");
    eq("avec son intitulé", d.nextTitle, "Droit des affaires");
    eq("et dans combien de temps", d.nextIn, "dans 2 h");

    eq("les quatre cours du jour sont sur la timeline", d.rowCount, 4);
    eq("dans l'ordre des heures", d.times, ["09:00", "13:30", "16:00", "18:00"]);
    eq("chacun à son état réel", d.states, ["past", "current", "upcoming", "upcoming"]);
    check("chaque ligne dit son horaire, sa durée et son état",
      /09:00 – 10:30/.test(d.metas[0]) && /1 h 30/.test(d.metas[0]) && /Terminé/.test(d.metas[0]), d.metas);
    check("et la matière quand on la reconnaît",
      /Analyse financière/.test(d.metas[1]), d.metas[1]);
    eq("les trois pauses de la journée sont dites", d.gaps.length, 3);
    check("et elles sont chiffrées", /Pause de 3 h/.test(d.gaps[0]), d.gaps);
    check("le rail est un trait continu", parseFloat(d.rail) > 0, d.rail);
    check("les points portent la couleur de leur cours",
      new Set(d.dotColors).size > 1, d.dotColors);
    eq("la colonne d'heures est en chasse fixe", d.timeFont, "IBM Plex Mono");
    eq("les heures sont tabulaires", d.timeNums, "tabular-nums");

    check("le trait de l'heure est dans la timeline", d.nowIndex >= 0, d.nowIndex);
    check("après le cours en cours", d.afterCurrent, d);
    check("et avant le suivant", d.beforeNext, d);
    eq("il porte l'heure qu'il est", d.nowTime, "14:00");
    eq("et il est rouge", d.nowLine, "rgb(227, 28, 61)");
    await page.close();
  }

  /* ======================================================================
     4 bis. LE COMPTEUR EST VIVANT — SANS RE-RENDU
     ====================================================================== */
  current = "4 bis. compteur vivant";
  {
    const { page } = await open(browser);

    const READ = () => ({
      fill: document.getElementById("dash-ccourse-fill").style.width,
      text: document.getElementById("dash-ccourse-text").textContent,
      now: document.getElementById("dash-tl-now-time").textContent,
      countdown: document.getElementById("dash-next-in").textContent,
    });
    /* On marque le nœud de la jauge : s'il survit, il n'y a pas eu de
       re-rendu — la mise à jour a bien été chirurgicale. */
    const before = await page.evaluate(fn => {
      document.getElementById("dash-ccourse-fill").dataset.witness = "1";
      return new Function("return (" + fn + ")()")();
    }, READ.toString());

    /* Dix minutes passent, puis la fonction de rafraîchissement fait son
       travail — celle-là même que la minuterie de l'application appelle. */
    await page.clock.fastForward(600000);
    const after = await page.evaluate(fn => {
      updateCurrentTimeIndicator();
      return new Function("return (" + fn + ")()")();
    }, READ.toString());
    const live = {
      before, after,
      survived: await page.evaluate(() =>
        document.getElementById("dash-ccourse-fill").dataset.witness === "1"),
    };

    check("la jauge du cours avance", live.before.fill === "50%" && live.after.fill === "67%", live);
    check("le temps restant se met à jour",
      /30 min/.test(live.before.text) && /20 min/.test(live.after.text), live);
    check("le trait de l'heure suit l'heure",
      live.before.now === "14:00" && live.after.now === "14:10", live);
    check("le décompte du prochain cours descend",
      live.before.countdown === "dans 2 h" && /1 h 50/.test(live.after.countdown), live);
    check("tout cela sans re-rendre la page", live.survived, live);
    await page.close();
  }

  /* ======================================================================
     5. PLANNING — NAVIGATION JOUR / SEMAINE / MOIS
     ====================================================================== */
  current = "5. navigation";
  {
    const { page, errors } = await open(browser);

    /* État initial : aujourd'hui, vue jour, « Aujourd'hui » désactivé. */
    const start = await page.evaluate(() => ({
      label: document.querySelector(".dash-plan-label").textContent.trim(),
      todayDisabled: document.getElementById("dash-plan-today").disabled,
      active: [...document.querySelectorAll("[data-plan-view]")]
        .filter(b => b.classList.contains("active")).map(b => b.dataset.planView),
      pressed: [...document.querySelectorAll("[data-plan-view]")].map(b => b.getAttribute("aria-pressed")),
    }));
    check("la vue jour est active au départ",
      JSON.stringify(start.active) === '["day"]', start);
    eq("et l'état est annoncé aux lecteurs d'écran", start.pressed, ["true", "false", "false"]);
    check("« Aujourd'hui » est désactivé quand on y est déjà", start.todayDisabled, start);

    /* Jour suivant. */
    await page.click('[data-plan-step="1"]');
    await page.waitForTimeout(350);
    const tomorrow = await page.evaluate(() => ({
      offsetDays: Math.round((state.dashPlanDay - todayMidnightMs()) / 86400000),
      label: document.querySelector(".dash-plan-label").textContent.trim(),
      todayDisabled: document.getElementById("dash-plan-today").disabled,
      live: document.querySelectorAll(".dash-live").length,
      now: document.querySelectorAll(".dash-tl-now").length,
      empty: !!document.querySelector("#dash-schedule-card .empty"),
    }));
    eq("« jour suivant » avance d'un jour", tomorrow.offsetDays, 1);
    check("l'étiquette change", tomorrow.label !== start.label, tomorrow);
    check("« Aujourd'hui » redevient actif", !tomorrow.todayDisabled, tomorrow);
    eq("aucun cours « en cours » un autre jour", tomorrow.live, 0);
    eq("ni trait de l'heure", tomorrow.now, 0);
    check("un jour sans cours le dit", tomorrow.empty, tomorrow);

    /* Jour précédent, deux fois : on revient à la veille d'aujourd'hui. */
    await page.click('[data-plan-step="-1"]');
    await page.waitForTimeout(300);
    await page.click('[data-plan-step="-1"]');
    await page.waitForTimeout(300);
    eq("« jour précédent » recule d'un jour",
      await page.evaluate(() => Math.round((state.dashPlanDay - todayMidnightMs()) / 86400000)), -1);

    /* Retour à aujourd'hui. */
    await page.click("#dash-plan-today");
    await page.waitForTimeout(350);
    const back = await page.evaluate(() => ({
      day: state.dashPlanDay === todayMidnightMs(),
      view: state.dashPlanView,
      live: document.querySelectorAll(".dash-live").length,
    }));
    eq("« Aujourd'hui » ramène au jour et à la vue du jour",
      back, { day: true, view: "day", live: 1 });

    /* Le pas suit la vue : une semaine en vue semaine, un mois en vue mois. */
    await page.click('[data-plan-view="week"]');
    await page.waitForTimeout(300);
    await page.click('[data-plan-step="1"]');
    await page.waitForTimeout(300);
    eq("en vue semaine, le pas vaut sept jours",
      await page.evaluate(() => Math.round((state.dashPlanDay - todayMidnightMs()) / 86400000)), 7);

    await page.evaluate(SEED);
    await page.waitForTimeout(300);
    await page.click('[data-plan-view="month"]');
    await page.waitForTimeout(300);
    await page.click('[data-plan-step="1"]');
    await page.waitForTimeout(300);
    eq("en vue mois, le pas vaut un mois",
      await page.evaluate(() => {
        const d = new Date(state.dashPlanDay), n = new Date(todayMidnightMs());
        return (d.getFullYear() - n.getFullYear()) * 12 + (d.getMonth() - n.getMonth());
      }), 1);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     6. PLANNING — VUE SEMAINE ET VUE MOIS
     ====================================================================== */
  current = "6. semaine et mois";
  {
    const { page } = await open(browser);

    await page.click('[data-plan-view="week"]');
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => {
      const cols = [...document.querySelectorAll(".dash-week-col")];
      const evs = [...document.querySelectorAll(".dash-week-ev")];
      return {
        cols: cols.length,
        today: cols.filter(c => c.classList.contains("is-today")).length,
        heads: cols.map(c => c.querySelector(".dash-week-num").textContent.trim()),
        evs: evs.length,
        titles: evs.map(e => e.querySelector(".dash-week-ev-t").textContent.trim()),
        hours: evs.map(e => e.querySelector(".dash-week-ev-h").textContent.trim()),
        colors: [...new Set(evs.map(e => getComputedStyle(e).borderLeftColor))],
        past: evs.filter(e => e.classList.contains("is-past")).length,
        titled: evs.every(e => (e.getAttribute("title") || "").length > 5),
        label: document.querySelector(".dash-plan-label").textContent.trim(),
      };
    });
    eq("la semaine a ses sept colonnes", w.cols, 7);
    eq("aujourd'hui y est repéré une seule fois", w.today, 1);
    eq("les quatre cours de la journée y sont", w.evs, 4);
    check("chacun avec son heure", w.hours.includes("09:00") && w.hours.includes("16:00"), w.hours);
    check("chacun à sa couleur", w.colors.length > 1, w.colors);
    eq("le cours terminé est estompé", w.past, 1);
    check("chacun nommé au survol", w.titled, w);
    check("l'étiquette annonce la plage de la semaine", /–/.test(w.label), w.label);

    /* Cliquer un cours de la semaine ouvre sa fiche. */
    await page.click(".dash-week-ev");
    await page.waitForTimeout(400);
    check("cliquer un cours ouvre sa fiche",
      await page.evaluate(() => !!document.querySelector(".cal-modal, .modal")), "");
    await page.evaluate(() => closeCourseModal());
    await page.waitForTimeout(300);

    /* Vue mois. */
    await page.evaluate(SEED);
    await page.waitForTimeout(300);
    await page.click('[data-plan-view="month"]');
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const days = [...document.querySelectorAll(".dash-month-day")];
      const today = days.find(d => d.classList.contains("is-today"));
      return {
        wd: document.querySelectorAll(".dash-month-wd").length,
        days: days.length,
        today: days.filter(d => d.classList.contains("is-today")).length,
        out: days.filter(d => d.classList.contains("is-out")).length,
        todayDots: today ? today.querySelectorAll(".dash-month-dot").length : null,
        dotColors: today ? [...new Set([...today.querySelectorAll(".dash-month-dot")]
          .map(x => getComputedStyle(x).backgroundColor))].length : null,
        labelled: days.every(d => (d.getAttribute("aria-label") || "").length > 5),
        clickable: days.every(d => d.tagName === "BUTTON" && d.dataset.planDay),
      };
    });
    eq("les sept initiales de jours coiffent le mois", m.wd, 7);
    eq("la grille du mois fait six semaines", m.days, 42);
    eq("aujourd'hui y est repéré une seule fois", m.today, 1);
    check("les jours des mois voisins sont estompés", m.out > 0, m.out);
    eq("aujourd'hui porte un point par cours", m.todayDots, 4);
    check("et ils ne sont pas tous de la même couleur", m.dotColors > 1, m.dotColors);
    check("chaque jour est nommé pour les lecteurs d'écran", m.labelled, m);
    check("et chacun est un vrai bouton", m.clickable, m);

    /* Cliquer un jour du mois ouvre ce jour, en vue jour. */
    const target = await page.evaluate(() => {
      const d = [...document.querySelectorAll(".dash-month-day")]
        .find(x => !x.classList.contains("is-out") && !x.classList.contains("is-today"));
      const ms = Number(d.dataset.planDay);
      d.click();
      return ms;
    });
    await page.waitForTimeout(400);
    const opened = await page.evaluate(() => ({ day: state.dashPlanDay, view: state.dashPlanView }));
    eq("cliquer un jour du mois l'ouvre en vue jour", opened, { day: target, view: "day" });
    await page.close();
  }

  /* ======================================================================
     7. LA COULEUR DIT QUELQUE CHOSE
     ====================================================================== */
  current = "7. couleur";
  {
    const { page } = await open(browser);

    const c = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const cs = el => getComputedStyle(el);
      return {
        subjectRule: cs(root.querySelector(".dash-subject")).borderLeftColor,
        subjectVar: root.querySelector(".dash-subject").style.getPropertyValue("--course-color"),
        prioBg: cs(root.querySelector(".dash-panel--priority")).backgroundColor,
        prioRule: cs(root.querySelector(".dash-panel--priority")).borderTopColor,
        plainBg: cs(root.querySelector(".dash-panel:not(.dash-panel--priority)")).backgroundColor,
        dot: cs(root.querySelector(".dash-row-dot")).backgroundColor,
        /* La gamme de rouges, du niveau 1 (écran) au niveau 4 (information). */
        ramp: ["--accent", "--accent-2", "--accent-3", "--accent-4", "--accent-wash"]
          .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim()),
      };
    });
    eq("une carte de matière porte le filet de sa couleur", c.subjectRule, "rgb(227, 28, 61)");
    check("posée par variable, pas par trois styles en ligne", /^#/.test(c.subjectVar), c.subjectVar);
    eq("la carte priorité est sur lavis", c.prioBg, "rgb(253, 242, 244)");
    eq("et coiffée du rouge de niveau 1", c.prioRule, "rgb(227, 28, 61)");
    eq("les autres panneaux restent blancs", c.plainBg, "rgb(255, 255, 255)");
    check("les listes portent un point de couleur", c.dot !== null, c);
    eq("la gamme de rouges est complète et dans l'ordre",
      c.ramp, ["#E31C3D", "#EA526C", "#F0899A", "#F5ADB9", "#FDF2F4"]);

    /* La couleur d'un cours non rattaché est STABLE : deux rendus du même
       intitulé donnent la même couleur. */
    const stable = await page.evaluate(() => {
      const a = eventColor({ summary: "Droit des affaires" });
      const b = eventColor({ summary: "Droit des affaires" });
      const d = eventColor({ summary: "Anglais des affaires" });
      const known = eventColor({ summary: "Analyse financière" });
      return { a, b, d, known, dansLaPalette: SUBJECT_COLORS.includes(a) };
    });
    eq("le même intitulé donne toujours la même couleur", stable.a, stable.b);
    check("deux intitulés différents en donnent deux", stable.a !== stable.d, stable);
    check("et elle vient de la palette du produit", stable.dansLaPalette, stable);
    eq("un cours rattaché prend la couleur de sa matière", stable.known, "#E31C3D");
    await page.close();
  }

  /* ======================================================================
     8. LES CHIFFRES SONT LES MÊMES QU'AVANT
     ====================================================================== */
  current = "8. compteurs";
  {
    const { page } = await open(browser);

    const m = await page.evaluate(() => {
      const g = globalMetrics();
      return {
        headline: document.querySelector(".dash-progress-value").textContent.trim(),
        expectedHeadline: g.mastery + "%",
        vals: [...document.querySelectorAll(".dash-measure b")].map(e => e.textContent.trim()),
        expectedQuestions: g.answered + "/" + g.total,
        expectedTime: fmtDuration(state.dash.timeSpentSeconds),
        meterWidth: document.querySelector(".dash-panel .meter-fill").style.width,
        statBoxed: getComputedStyle(document.querySelector(".dash-measure")).borderTopWidth,
        tags: [...document.querySelectorAll(".dash-row-tags")].map(e => e.textContent.replace(/\s+/g, " ").trim()),
        states: [...document.querySelectorAll(".dash-row--stack .status")].map(e => e.textContent.trim()),
        feed: document.querySelectorAll(".dash-log-item").length,
        /* Le temps total est repris en note de section — même valeur. */
        note: document.querySelector("#dash-recent-activity .dash-section-note").textContent.trim(),
      };
    });

    eq("le pourcentage de maîtrise est celui du moteur", m.headline, m.expectedHeadline);
    eq("la jauge suit le même pourcentage", m.meterWidth, m.expectedHeadline);
    eq("les quatre mesures sont toujours là", m.vals.length, 4);
    check("questions travaillées : même valeur qu'avant", m.vals.includes(m.expectedQuestions), m);
    check("temps de révision : même valeur qu'avant", m.vals.includes(m.expectedTime), m);
    check("et la note d'activité reprend le même temps",
      m.note.startsWith(m.expectedTime), m);
    eq("une mesure n'est pas encadrée", m.statBoxed, "0px");
    check("les contenus disponibles d'un cours sont annoncés",
      m.tags.some(x => /Quiz/.test(x) && /Flashcards/.test(x) && /Questions/.test(x)), m.tags);
    check("l'état de révision aussi",
      m.states.includes("À revoir") && m.states.includes("Révisé"), m.states);
    eq("l'activité récente est listée", m.feed, 3);
    await page.close();
  }

  /* ======================================================================
     9. RIEN DE DÉCORATIF, RIEN EN DOUBLE
     ====================================================================== */
  current = "9. sobriété";
  {
    const { page } = await open(browser);

    const r = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      /* On cherche les doublons DANS UNE MÊME zone : un même libellé sur deux
         boutons de sections différentes (une matière et le cours qui porte son
         nom) désigne deux objets distincts, ce n'est pas une répétition. */
      const dup = [];
      for (const zone of root.children) {
        const labels = [...zone.querySelectorAll("button")]
          .map(b => (b.getAttribute("aria-label") || b.textContent).replace(/\s+/g, " ").trim())
          .filter(Boolean);
        labels.forEach((l, i) => { if (labels.indexOf(l) !== i) dup.push(l); });
      }
      const ids = {};
      root.querySelectorAll("[id]").forEach(e => { ids[e.id] = (ids[e.id] || 0) + 1; });
      const RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
      const emoji = [...root.querySelectorAll("*")]
        .filter(el => el.children.length === 0 && RE.test(el.textContent));
      return {
        dup: [...new Set(dup)],
        dupIds: Object.entries(ids).filter(([, n]) => n > 1),
        /* Le seul emoji du tableau de bord est le signe de la salutation : il
           porte un sens, les autres ont été retirés. */
        emojiCount: emoji.length,
        emojiWhere: emoji.map(el => el.className || el.tagName),
        arrows: [...root.querySelectorAll("*")]
          .filter(el => el.children.length === 0 && /→/.test(el.textContent))
          .map(el => el.textContent.trim()),
        actions: root.querySelectorAll(".dash-action").length,
        /* Aucune animation permanente, aucun flou, aucune 3D. */
        animated: [...root.querySelectorAll("*")]
          .filter(el => {
            const cs = getComputedStyle(el);
            return (cs.animationName !== "none" && cs.animationIterationCount === "infinite")
                || cs.backdropFilter !== "none"
                || /matrix3d|perspective/.test(cs.transform);
          }).map(el => el.className || el.tagName),
      };
    });
    eq("aucun bouton en double dans la page", r.dup, []);
    eq("aucun identifiant en double", r.dupIds, []);
    eq("un seul emoji dans la page", r.emojiCount, 1);
    eq("et c'est celui de la salutation", r.emojiWhere, ["dash-banner-title"]);
    eq("aucune flèche typographique postiche", r.arrows, []);
    eq("les huit destinations sont listées une seule fois", r.actions, 8);
    eq("aucune animation permanente, aucun flou, aucune 3D", r.animated, []);
    await page.close();
  }

  /* ======================================================================
     10. RESPONSIVE — LE PLANNING MOBILE N'EST PAS UN PLANNING RÉDUIT
     ====================================================================== */
  for (const vp of VIEWPORTS) {
    current = `10. ${vp.name}`;
    const { page, errors } = await open(browser, vp);

    const r = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const cs = el => getComputedStyle(el);
      const cols = el => cs(el).gridTemplateColumns.split(" ").length;
      const over = [...root.querySelectorAll("*")]
        .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(el => el.className || el.tagName).slice(0, 6);
      const row = root.querySelector(".dash-tl-row");
      return {
        overflowing: over,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        blocks: root.querySelectorAll(".dash-section-block").length,
        panels: root.querySelectorAll(".dash-panel").length,
        /* Le planning garde SA colonne d'heures et SON rail à toutes les
           largeurs : c'est cela qui le rend lisible au doigt. */
        rowCols: cols(row),
        railWidth: cs(row.querySelector(".dash-tl-rail"), "::before").width,
        nowCols: cols(root.querySelector(".dash-tl-now")),
        rows: root.querySelectorAll(".dash-tl-row").length,
        live: root.querySelectorAll(".dash-live").length,
        now: root.querySelectorAll(".dash-tl-now").length,
        /* Le sélecteur de vue reste utilisable au doigt. */
        viewBtnH: Math.round(root.querySelector('[data-plan-view="day"]').getBoundingClientRect().height),
        stepH: Math.round(root.querySelector('[data-plan-step="1"]').getBoundingClientRect().height),
        splitCols: cols(root.querySelector(".dash-grid--split")),
        actionCols: cols(root.querySelector(".dash-actions")),
        bannerTitle: parseFloat(cs(root.querySelector(".dash-banner-title")).fontSize),
        bannerPad: cs(root.querySelector(".dash-banner")).paddingTop,
      };
    });

    eq(`[${vp.name}] aucun élément ne déborde`, r.overflowing, []);
    check(`[${vp.name}] pas de défilement horizontal`, !r.pageOverflow, r.pageOverflow);
    eq(`[${vp.name}] les quatre sections sont rendues`, r.blocks, 4);
    check(`[${vp.name}] les panneaux sont rendus`, r.panels >= 3, r.panels);
    eq(`[${vp.name}] la timeline garde heure, rail et contenu`, r.rowCols, 3);
    check(`[${vp.name}] le rail reste tracé`, parseFloat(r.railWidth) > 0, r.railWidth);
    eq(`[${vp.name}] le trait de l'heure garde sa colonne d'heure`, r.nowCols, 2);
    eq(`[${vp.name}] les quatre cours du jour sont là`, r.rows, 4);
    eq(`[${vp.name}] le cours en cours est mis en avant`, r.live, 1);
    eq(`[${vp.name}] et l'heure est tracée`, r.now, 1);
    check(`[${vp.name}] le sélecteur de vue se touche (≥ 32px)`, r.viewBtnH >= 32, r.viewBtnH);
    check(`[${vp.name}] les flèches de navigation aussi`, r.stepH >= 32, r.stepH);

    if (vp.width <= 640) {
      eq(`[${vp.name}] une seule colonne pour les paires de panneaux`, r.splitCols, 1);
      eq(`[${vp.name}] une action par ligne`, r.actionCols, 1);
      check(`[${vp.name}] la salutation est réduite`, r.bannerTitle <= 34, r.bannerTitle);
      eq(`[${vp.name}] la bannière respire moins`, r.bannerPad, "24px");

      /* La semaine mobile n'est pas sept colonnes serrées : c'est une liste
         de jours. */
      await page.click('[data-plan-view="week"]');
      await page.waitForTimeout(400);
      const wk = await page.evaluate(() => {
        const root = document.querySelector(".dashboard");
        return {
          cols: getComputedStyle(root.querySelector(".dash-week")).gridTemplateColumns.split(" ").length,
          visible: [...root.querySelectorAll(".dash-week-col")]
            .filter(c => c.offsetParent !== null).length,
          over: [...root.querySelectorAll("*")]
            .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
            .map(el => el.className).slice(0, 4),
        };
      });
      eq(`[${vp.name}] la semaine devient une liste de jours`, wk.cols, 1);
      check(`[${vp.name}] et seuls les jours avec cours sont montrés`, wk.visible === 1, wk);
      eq(`[${vp.name}] la semaine ne déborde pas`, wk.over, []);

      await page.click('[data-plan-view="month"]');
      await page.waitForTimeout(400);
      const mo = await page.evaluate(() => ({
        cols: getComputedStyle(document.querySelector(".dash-month")).gridTemplateColumns.split(" ").length,
        h: Math.round(document.querySelector(".dash-month-day").getBoundingClientRect().height),
        over: [...document.querySelectorAll(".dashboard *")]
          .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .map(el => el.className).slice(0, 4),
      }));
      eq(`[${vp.name}] le mois garde ses sept colonnes`, mo.cols, 7);
      check(`[${vp.name}] et ses jours restent touchables (≥ 44px)`, mo.h >= 44, mo.h);
      eq(`[${vp.name}] le mois ne déborde pas`, mo.over, []);
    } else if (vp.width <= 1024) {
      eq(`[${vp.name}] les paires de panneaux passent l'une sous l'autre`, r.splitCols, 1);
    } else {
      eq(`[${vp.name}] les paires de panneaux sont côte à côte`, r.splitCols, 2);
    }
    eq(`[${vp.name}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     11. LES CINQ LANGUES
     ----------------------------------------------------------------------
     Le tableau de bord est rendu réellement dans chaque langue : on vérifie
     qu'aucune clé ne fuit, que les libellés sont bien traduits, et que la
     date et les heures suivent la locale.
     ====================================================================== */
  const ATTENDU = {
    fr: { today: "Aujourd'hui", day: "Jour", cur: "En cours", next: "Prochain" },
    en: { today: "Today",       day: "Day",  cur: "Ongoing",  next: "Next" },
    es: { today: "Hoy",         day: "Día",  cur: "En curso", next: "Siguiente" },
    de: { today: "Heute",       day: "Tag",  cur: "Läuft",    next: "Als Nächstes" },
    it: { today: "Oggi",        day: "Giorno", cur: "In corso", next: "Prossimo" },
  };
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    current = `11. ${lang}`;
    const { page, errors } = await open(browser, { width: 1440, height: 1000 }, lang);

    const l = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const txt = root.textContent.replace(/\s+/g, " ");
      return {
        sectionTitle: root.querySelector(".dash-section-title").textContent.trim(),
        viewDay: root.querySelector('[data-plan-view="day"]').textContent.trim(),
        todayBtn: document.getElementById("dash-plan-today").textContent.trim(),
        badge: root.querySelector(".dash-live-badge").textContent.trim(),
        nextLabel: root.querySelector(".dash-next-label").textContent.trim(),
        remaining: root.querySelector("#dash-ccourse-text").textContent.trim(),
        countdown: root.querySelector("#dash-next-in").textContent.trim(),
        gap: root.querySelector(".dash-tl-gap").textContent.trim(),
        greeting: root.querySelector(".dash-banner-title").textContent.trim(),
        date: root.querySelector(".dash-banner-date").textContent.trim(),
        statLabels: [...root.querySelectorAll(".dash-banner-stat span")].map(e => e.textContent.trim()),
        rows: root.querySelectorAll(".dash-tl-row").length,
        /* Aucune clé brute : « dashboard.xxx » ne doit jamais s'afficher. */
        rawKeys: (txt.match(/\b[a-z_]+\.[a-z_]{3,}\b/g) || [])
          .filter(k => !/\.(com|fr|io|org|js|html)$/.test(k)),
        /* Rien de vide non plus. */
        blanks: [...root.querySelectorAll(".dash-section-title, .dash-banner-stat span, .dash-tl-title")]
          .filter(e => !e.textContent.trim()).length,
      };
    });

    const exp = ATTENDU[lang];
    eq(`[${lang}] la section « aujourd'hui » est traduite`, l.sectionTitle, exp.today);
    eq(`[${lang}] la vue « jour » est traduite`, l.viewDay, exp.day);
    eq(`[${lang}] le bouton « aujourd'hui » est traduit`, l.todayBtn, exp.today);
    eq(`[${lang}] « en cours » est traduit`, l.badge, exp.cur);
    eq(`[${lang}] « prochain » est traduit`, l.nextLabel, exp.next);
    check(`[${lang}] le temps restant est traduit et chiffré`,
      /30 min/.test(l.remaining) && l.remaining.length > 10, l.remaining);
    check(`[${lang}] le décompte du prochain est traduit`, /2 h/.test(l.countdown), l.countdown);
    check(`[${lang}] la pause est traduite et chiffrée`, /3 h/.test(l.gap), l.gap);
    check(`[${lang}] la salutation garde son signe`, /👋/.test(l.greeting), l.greeting);
    check(`[${lang}] la date suit la locale`, l.date.length > 8, l.date);
    eq(`[${lang}] les trois mesures sont étiquetées`, l.statLabels.length, 3);
    check(`[${lang}] et aucune étiquette n'est vide`, l.statLabels.every(Boolean), l.statLabels);
    eq(`[${lang}] les quatre cours du jour sont rendus`, l.rows, 4);
    eq(`[${lang}] aucune clé de traduction brute à l'écran`, l.rawKeys, []);
    eq(`[${lang}] aucun libellé vide`, l.blanks, 0);
    eq(`[${lang}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     12. ACCESSIBILITÉ ET MOUVEMENT RÉDUIT
     ====================================================================== */
  current = "12. accessibilité";
  {
    const { page } = await open(browser);

    const a = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const headings = [...root.querySelectorAll("h1,h2,h3")].map(h => +h.tagName[1]);
      const fakeButtons = [...root.querySelectorAll('[role="button"]')]
        .filter(el => el.tagName !== "BUTTON").map(el => el.className);
      const clickables = [...root.querySelectorAll(
        ".dash-row, .dash-tl-row, .dash-action, .dash-subject, .dash-next, .dash-month-day, .dash-week-ev")];
      return {
        headings,
        fakeButtons,
        allRealButtons: clickables.every(el => el.tagName === "BUTTON"),
        /* Les flèches de navigation ont un nom, leur icône n'en donne pas. */
        stepsLabelled: [...root.querySelectorAll("[data-plan-step]")]
          .every(b => (b.getAttribute("aria-label") || "").length > 2),
        /* Les SVG décoratifs sont cachés aux lecteurs d'écran. */
        svgHidden: [...root.querySelectorAll("svg")].every(s => s.getAttribute("aria-hidden") === "true"),
        focus: (() => {
          const el = root.querySelector(".dash-tl-row"); el.focus();
          const cs = getComputedStyle(el);
          return { outline: cs.outlineStyle, width: cs.outlineWidth };
        })(),
      };
    });
    eq("un seul h1 dans la page", a.headings.filter(n => n === 1).length, 1);
    check("la hiérarchie des titres ne saute pas de niveau",
      a.headings.every((n, i) => i === 0 || n - a.headings[i - 1] <= 1), a.headings);
    eq("aucune fausse div cliquable", a.fakeButtons, []);
    check("tout ce qui se clique est un vrai bouton", a.allRealButtons, a);
    check("les flèches de navigation sont nommées", a.stepsLabelled, a);
    check("les icônes décoratives sont cachées aux lecteurs d'écran", a.svgHidden, a);
    check("focus clavier visible sur une ligne de la timeline",
      a.focus.outline !== "none" && parseFloat(a.focus.width) >= 2, a.focus);
    await page.close();
  }

  current = "12 bis. mouvement réduit";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const moving = [...document.querySelectorAll(".dashboard *")].filter(el => {
        const cs = getComputedStyle(el);
        const dur = parseFloat(cs.transitionDuration) + parseFloat(cs.animationDuration);
        return dur > 0.01;
      }).map(el => el.className || el.tagName);
      return {
        moving: moving.slice(0, 6),
        /* Le contenu, lui, est intact. */
        rows: document.querySelectorAll(".dash-tl-row").length,
        live: document.querySelectorAll(".dash-live").length,
        now: document.querySelectorAll(".dash-tl-now").length,
      };
    });
    eq("mouvement réduit : plus rien ne bouge", m.moving, []);
    eq("mais la timeline est entière", m.rows, 4);
    eq("le cours en cours est là", m.live, 1);
    eq("et l'heure est tracée", m.now, 1);
    await page.close();
  }
} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${e.message}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
