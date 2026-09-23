/* ============================================================================
   ÉTAPE 7 — PAGES INTERNES
   ----------------------------------------------------------------------------
   Trois questions, sur les quinze écrans :
     • la touche de rouge est-elle présente et MAÎTRISÉE (un repère par
       section, un filet par page, un seul traitement de sélection) ?
     • la grammaire SECTION → SOUS-SECTION → CONTENU → ACTION est-elle la même
       partout, et les panneaux appartiennent-ils à la même famille ?
     • rien n'a-t-il régressé — dans les cinq langues, aux trois largeurs ?

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/pages.test.mjs
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

/* Les quinze écrans demandés, et comment y aller. */
const PAGES = [
  ["mes-matieres", () => { libGoto("subjects"); switchTab("library"); }],
  ["matiere",      () => { libGoto("subjectDetail", { subjectId: "t-subj" }); switchTab("library"); }],
  ["chapitre",     () => { libGoto("chapterDetail", { chapterId: "t-ch1" }); switchTab("library"); }],
  ["fiche",        () => { libGoto("chapterDetail", { chapterId: "t-ch1" }); switchTab("library"); }],
  ["ressources",   () => { switchTab("fiches"); }],
  ["import",       () => { goToCourseImport(); switchTab("library"); }],
  ["quiz",         () => { switchTab("activities"); }],
  ["flashcards",   () => { state.flashScreen = "picker"; switchTab("flash"); }],
  ["smart",        () => { state.smartScreen = "home"; switchTab("smart"); }],
  ["statistiques", () => { state.statsView = { view: "overview", subjectId: null, chapterId: null }; switchTab("stats"); }],
  ["progression",  () => { switchTab("progress"); }],
  ["planning",     () => { switchTab("planning"); }],
  ["examens",      () => { switchTab("exams"); }],
  ["assistant-ia", () => { switchTab("ai"); }],
  ["profil",       () => { switchTab("account"); }],
  ["parametres",   () => { switchTab("settings"); }],
];

const SEED = () => {
  const now = Date.now(), subjId = "t-subj";
  state.userSubjects = [{ id: subjId, name: "Analyse financière",
                          semesterId: (SEMESTERS[0] || {}).id, icon: "", color: "#E31C3D" }];
  state.userChapters = [
    { id: "t-ch1", subjectId: subjId, num: 1, title: "Bilan et compte de résultat",
      desc: "Lire et interpréter les états financiers.",
      content: "Le bilan est une photographie du patrimoine à une date donnée.",
      aiQuiz: [{ q: "Que représente le bilan ?", opts: ["Le patrimoine", "Le résultat", "Les flux", "Les commandes"], correct: 0, exp: "Une photographie du patrimoine." }],
      aiFlashcards: [{ front: "Actif circulant ?", back: "Un actif consommé dans le cycle d'exploitation." }],
      aiReviewQuestions: [{ q: "Pourquoi le bilan est-il équilibré ?", a: "Par construction comptable." }],
      createdAt: now - 3 * 86400000, updatedAt: now - 86400000, markedReviewed: false },
  ];
  saveUserSubjects(); saveUserChapters();
  state.dash.recentChapters = [{ chapterId: "t-ch1", ts: now - 86400000 }];
  state.dash.recentActivity = [{ type: "quiz", label: "Bilan", pct: 72, ts: new Date(now - 3600000).toISOString() }];
  state.dash.timeSpentSeconds = 4230;
  const at = (h, m) => { const d = new Date(now); d.setHours(h, m || 0, 0, 0); return d.getTime(); };
  state.planning.events = [
    { id: "ev-current", summary: "Analyse financière", start: now - 1800000, end: now + 1800000, location: "A201" },
    { id: "ev-next", summary: "Droit des affaires", start: at(16), end: at(17, 30), location: "C012" },
  ];
};

async function open(browser, width, height, lang) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  const at = new Date(); at.setHours(14, 0, 0, 0);
  await page.clock.install({ time: at });
  await page.goto(APP);
  await page.waitForTimeout(1600);
  if (lang) { await page.evaluate(l => LyonI18n.setLang(l), lang); await page.waitForTimeout(400); }
  await page.evaluate(SEED);
  return { page, errors };
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. LA TOUCHE DE ROUGE — PRÉSENTE SUR CHAQUE PAGE, ET MAÎTRISÉE
     ====================================================================== */
  current = "1. le rouge";
  {
    const { page, errors } = await open(browser, 1440, 1000);
    const ACCENT = "rgb(227, 28, 61)";

    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(450);
      const r = await page.evaluate(a => {
        const view = document.getElementById("view") || document.body;
        const all = [...view.querySelectorAll("*")];
        const isA = v => v === a;
        /* Tout ce qui porte du rouge, quelle que soit la propriété. */
        const carriers = all.filter(el => {
          const cs = getComputedStyle(el);
          return isA(cs.color) || isA(cs.backgroundColor)
              || isA(cs.borderTopColor) && cs.borderTopWidth !== "0px"
              || isA(cs.borderLeftColor) && cs.borderLeftWidth !== "0px";
        });
        const pseudo = all.filter(el => {
          for (const p of ["::before", "::after"]) {
            const cs = getComputedStyle(el, p);
            if (cs.content !== "none" && isA(cs.backgroundColor)) return true;
          }
          return false;
        });
        /* Aplats rouges pleins : ils doivent rester rares (action primaire). */
        const solids = all.filter(el => isA(getComputedStyle(el).backgroundColor)
                                     && el.getBoundingClientRect().height > 8);
        return {
          carriers: carriers.length, pseudo: pseudo.length,
          solids: solids.map(el => el.className.toString().slice(0, 40)),
          text: view.innerText.trim().length,
        };
      }, ACCENT);
      check(`[${name}] la page a du rouge`, r.carriers + r.pseudo > 0, r);
      check(`[${name}] les aplats rouges restent rares`, r.solids.length <= 4, r.solids);
      check(`[${name}] la page rend du contenu`, r.text > 40, r.text);
    }
    eq("aucune erreur JavaScript sur les quinze écrans", errors, []);
    await page.close();
  }

  /* ======================================================================
     2. LE REPÈRE DE SECTION — LE MÊME PARTOUT
     ====================================================================== */
  current = "2. repère de section";
  {
    const { page } = await open(browser, 1440, 1000);
    const seen = [];
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        const titles = [...view.querySelectorAll(".section-title")];
        if (!titles.length) return null;
        const cs = getComputedStyle(titles[0], "::before");
        return { bg: cs.backgroundColor, w: cs.width, h: cs.height, n: titles.length };
      });
      if (r) seen.push([name, r]);
    }
    check("des titres de sous-section existent sur plusieurs pages", seen.length >= 5, seen.length);
    const shapes = new Set(seen.map(([, r]) => `${r.bg}|${r.w}|${r.h}`));
    eq("le repère de section est identique sur toutes les pages", [...shapes],
       ["rgb(227, 28, 61)|14px|2px"]);
    await page.close();
  }

  /* ======================================================================
     3. LE FILET DE PAGE — LA MÊME OUVERTURE PARTOUT
     ====================================================================== */
  current = "3. filet de page";
  {
    const { page } = await open(browser, 1440, 1000);
    const shapes = new Set(); let withTitle = 0;
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        const h = view.querySelector(".page-title");
        if (!h) return null;
        const cs = getComputedStyle(h, "::before");
        const t = getComputedStyle(h);
        return { bg: cs.backgroundColor, w: cs.width, h: cs.height, font: t.fontFamily.split(",")[0].replace(/"/g, ""), size: t.fontSize };
      });
      if (r) { withTitle++; shapes.add(`${r.bg}|${r.w}|${r.h}|${r.font}|${r.size}`); }
    }
    check("la plupart des pages ont un titre de page", withTitle >= 8, withTitle);
    eq("le filet d'ouverture est identique partout", [...shapes],
       ["rgb(227, 28, 61)|40px|2px|Newsreader|30px"]);
    await page.close();
  }

  /* ======================================================================
     4. UN SEUL TRAITEMENT DE SÉLECTION
     ====================================================================== */
  current = "4. sélection";
  {
    const { page } = await open(browser, 1440, 1000);
    const treatments = new Map();
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        return [...view.querySelectorAll(".active, [aria-selected='true']")]
          .filter(el => el.offsetParent !== null && el.tagName === "BUTTON")
          .map(el => {
            const cs = getComputedStyle(el);
            return { cls: el.className.toString().split(" ")[0], bg: cs.backgroundColor, color: cs.color };
          });
      });
      r.forEach(x => treatments.set(x.cls, x));
    }
    const found = [...treatments.values()];
    check("des états sélectionnés ont été rencontrés", found.length >= 2, found.length);
    /* Aucun aplat rouge plein : la sélection se signale par le lavis et le texte. */
    const solid = found.filter(x => x.bg === "rgb(227, 28, 61)");
    eq("aucune sélection n'est un aplat rouge plein", solid, []);
    /* Et aucune sélection n'est un aplat encre non plus. */
    const ink = found.filter(x => x.bg === "rgb(22, 22, 26)");
    eq("aucune sélection n'est un aplat encre", ink, []);
    await page.close();
  }

  /* ======================================================================
     5. MÊME FAMILLE DE PANNEAUX SUR TOUTES LES PAGES
     ====================================================================== */
  current = "5. famille de panneaux";
  {
    const { page } = await open(browser, 1440, 1000);
    const shapes = new Set(); let n = 0;
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        return [...view.querySelectorAll(".card, .dash-section, .block--feature, .fiche-card")]
          .filter(el => el.offsetParent !== null)
          .map(el => {
            const cs = getComputedStyle(el);
            return `${cs.borderTopLeftRadius}|${cs.borderTopWidth}|${cs.backgroundColor}`;
          });
      });
      n += r.length; r.forEach(x => shapes.add(x));
    }
    check("des panneaux ont été rencontrés", n >= 10, n);
    /* Un seul rayon, un seul filet, une seule surface — la nuance creusée
       n'apparaît que pour un panneau imbriqué. */
    const radii = new Set([...shapes].map(x => x.split("|")[0]));
    eq("tous les panneaux partagent le rayon de surface", [...radii], ["12px"]);
    const widths = new Set([...shapes].map(x => x.split("|")[1]));
    eq("tous les panneaux partagent le filet", [...widths], ["1px"]);
    await page.close();
  }

  /* ======================================================================
     6. PAGES PÉDAGOGIQUES — LISIBILITÉ
     ====================================================================== */
  current = "6. pages pédagogiques";
  {
    const { page } = await open(browser, 1440, 1000);

    /* FICHE : lecture confortable. */
    await page.evaluate(() => { libGoto("chapterDetail", { chapterId: "t-ch1" }); switchTab("library"); });
    await page.waitForTimeout(500);
    const fiche = await page.evaluate(() => {
      const c = document.querySelector(".fiche-content");
      if (!c) return null;
      const p = c.querySelector("p") || c;
      const cs = getComputedStyle(p);
      return {
        size: cs.fontSize, leading: cs.lineHeight,
        width: Math.round(c.getBoundingClientRect().width),
      };
    });
    check("fiche : corps de texte à 16px", fiche && fiche.size === "16px", fiche);
    check("fiche : interlignage large", fiche && parseFloat(fiche.leading) / parseFloat(fiche.size) >= 1.7, fiche);
    check("fiche : colonne de lecture mesurée", fiche && fiche.width <= 680, fiche);

    /* QUIZ : la question domine, les réponses sont lisibles. */
    await page.evaluate(() => { startModeQuiz("never"); });
    await page.waitForTimeout(600);
    const quiz = await page.evaluate(() => {
      const q = document.querySelector(".qz-question");
      const o = document.querySelector(".qz-opt");
      const card = document.querySelector(".qz-card");
      const track = document.querySelector(".qz-progress-track");
      if (!q || !o) return null;
      const qc = getComputedStyle(q), oc = getComputedStyle(o);
      return {
        qSize: qc.fontSize, qFont: qc.fontFamily.split(",")[0].replace(/"/g, ""),
        oSize: oc.fontSize, oHeight: Math.round(o.getBoundingClientRect().height),
        cardBoxed: card ? getComputedStyle(card).borderTopWidth : null,
        trackHeight: track ? getComputedStyle(track).height : null,
        screenWidth: Math.round(document.querySelector(".qz-screen").getBoundingClientRect().width),
      };
    });
    check("quiz : la question domine (30px, sérif)",
      quiz && quiz.qSize === "30px" && quiz.qFont === "Newsreader", quiz);
    check("quiz : les réponses sont lisibles (16px, cible généreuse)",
      quiz && quiz.oSize === "16px" && quiz.oHeight >= 56, quiz);
    eq("quiz : plus de cadre autour de la question", quiz && quiz.cardBoxed, "0px");
    eq("quiz : progression en filet de 2px", quiz && quiz.trackHeight, "2px");
    check("quiz : colonne de concentration", quiz && quiz.screenWidth <= 680, quiz);

    /* FLASHCARDS : contenu en avant, retournement raffiné. */
    await page.evaluate(() => { state.flashScreen = "picker"; switchTab("flash"); });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const b = document.querySelector("[data-flashchapter]");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    const flash = await page.evaluate(() => {
      const card = document.querySelector(".flashcard");
      const inner = document.querySelector(".flashcard-inner");
      const q = document.querySelector(".flashcard-front .q");
      const back = document.querySelector(".flashcard-back");
      if (!card || !q) return null;
      const qc = getComputedStyle(q), ic = getComputedStyle(inner), bc = getComputedStyle(back);
      return {
        qSize: qc.fontSize, qFont: qc.fontFamily.split(",")[0].replace(/"/g, ""),
        duration: ic.transitionDuration,
        backGradient: bc.backgroundImage,
        backRule: bc.borderTopColor + " " + bc.borderTopWidth,
        width: Math.round(card.getBoundingClientRect().width),
      };
    });
    check("flashcards : la question prend le sérif de titraille",
      flash && flash.qFont === "Newsreader" && flash.qSize === "30px", flash);
    eq("flashcards : retournement à la durée du système", flash && flash.duration, "0.42s");
    eq("flashcards : plus de dégradé au verso", flash && flash.backGradient, "none");
    eq("flashcards : un filet accent signale le verso", flash && flash.backRule, "rgb(227, 28, 61) 2px");
    await page.close();
  }

  /* ======================================================================
     7. CINQ LANGUES — RIEN NE CASSE, RIEN NE DÉBORDE
     ====================================================================== */
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    current = `7. ${lang}`;
    const { page, errors } = await open(browser, 1440, 1000, lang);
    let empty = [], overflow = [];
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        return {
          len: view.innerText.trim().length,
          over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          /* Une clé manquante s'afficherait telle quelle : « library.foo ». */
          raw: (view.innerText.match(/\b[a-z_]+\.[a-z_]{3,}\b/g) || [])
                 .filter(x => !/\.(js|html|css|com|fr|io|pdf|docx|txt|md)$/.test(x)).slice(0, 4),
        };
      });
      if (r.len <= 40) empty.push(name);
      if (r.over) overflow.push(name);
      if (r.raw.length) check(`[${lang}] ${name} : aucune clé de traduction brute`, false, r.raw);
    }
    eq(`[${lang}] toutes les pages rendent du contenu`, empty, []);
    eq(`[${lang}] aucune page ne déborde`, overflow, []);
    eq(`[${lang}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     8. RESPONSIVE — LES QUINZE ÉCRANS, AUX TROIS LARGEURS
     ====================================================================== */
  for (const vp of [{ n: "bureau", w: 1440, h: 1000 }, { n: "tablette", w: 768, h: 1024 }, { n: "mobile", w: 375, h: 812 }]) {
    current = `8. ${vp.n}`;
    const { page, errors } = await open(browser, vp.w, vp.h);
    const bad = [], over = [];
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        const inScroller = el => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const ov = getComputedStyle(n).overflowX;
            if (ov === "auto" || ov === "scroll") return true;
          }
          return false;
        };
        const outside = [...view.querySelectorAll("*")]
          .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 2)
          .filter(el => !inScroller(el))
          .map(el => el.className.toString().slice(0, 30)).slice(0, 3);
        return {
          len: view.innerText.trim().length,
          page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          outside,
        };
      });
      if (r.len <= 40) bad.push(name);
      if (r.page || r.outside.length) over.push([name, r.outside]);
    }
    eq(`[${vp.n}] toutes les pages rendent du contenu`, bad, []);
    eq(`[${vp.n}] rien ne déborde`, over, []);
    eq(`[${vp.n}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     9. PLUS D'EMOJI DÉCORATIF DANS LES PAGES
     ====================================================================== */
  current = "9. emojis";
  {
    const { page } = await open(browser, 1440, 1000);
    const found = [];
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const view = document.getElementById("view") || document.body;
        const rx = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}]/u;
        return [...view.querySelectorAll("*")]
          .filter(el => el.children.length === 0 && el.offsetParent !== null)
          .map(el => el.textContent.trim())
          .filter(t => rx.test(t)).slice(0, 3);
      });
      if (r.length) found.push([name, r]);
    }
    eq("aucun emoji décoratif dans les quinze écrans", found, []);
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
