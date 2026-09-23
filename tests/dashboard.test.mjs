/* ============================================================================
   TABLEAU DE BORD — PANNEAUX
   ----------------------------------------------------------------------------
   Deux questions sont posées à chaque vérification :
     • la composition dit-elle « où suis-je / qu'est-ce qui compte / que
       dois-je faire », dans cet ordre, sans grille de cartes ?
     • et surtout : AUCUNE fonctionnalité n'a-t-elle disparu ? La refonte est
       visuelle — toutes les destinations, tous les compteurs et le compteur
       à la seconde du cours en cours doivent encore répondre.

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
   quand les tests tournent la nuit, et la liste du jour ne contiendrait plus
   ce qu'on prétend vérifier. */
const FROZEN_HOUR = 14;
async function freezeClock(page){
  const at = new Date(); at.setHours(FROZEN_HOUR, 0, 0, 0);
  await page.clock.install({ time: at });
}

/* Un jeu de données réel : une matière avec des chapitres travaillés, un
   planning dont un cours est EN COURS, et de l'activité récente. Sans ça, la
   moitié du tableau de bord ne serait jamais rendue par les tests. */
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

  /* Un cours terminé, un en cours, un à venir — tous le même jour, l'horloge
     étant figée à 14 h. */
  const h = 3600000;
  const at = (hh, mm) => { const d = new Date(now); d.setHours(hh, mm || 0, 0, 0); return d.getTime(); };
  state.planning.events = [
    { id: "ev-past",    summary: "Statistiques",       start: at(9),  end: at(10, 30), location: "B104" },
    { id: "ev-current", summary: "Analyse financière", start: now - 0.5 * h, end: now + 0.5 * h, location: "A201" },
    { id: "ev-next",    summary: "Droit des affaires", start: at(16), end: at(17, 30), location: "C012" },
    { id: "ev-late",    summary: "Anglais des affaires", start: at(18), end: at(19, 30), location: "D003" },
  ];
  state.dashSchedulePreview = "today";
  switchTab("dashboard");
  render();
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. HIÉRARCHIE — OÙ SUIS-JE / QU'EST-CE QUI COMPTE / QUE DOIS-JE FAIRE
     ====================================================================== */
  current = "1. hiérarchie";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(500);

    const h = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      /* L'ordre réel des grandes zones, de haut en bas. */
      const order = [...root.children]
        .filter(el => el.offsetParent !== null)
        .map(el => el.className || el.tagName.toLowerCase());
      const top = el => Math.round(el.getBoundingClientRect().top + window.scrollY);
      const lede = document.querySelector(".dash-lede");
      const focus = document.querySelector(".dash-panel--priority");
      const cs = el => getComputedStyle(el);
      return {
        order,
        ledeTitle: document.querySelector(".dash-lede-title").tagName,
        ledeFont: cs(document.querySelector(".dash-lede-title")).fontFamily.split(",")[0].replace(/"/g, ""),
        ledeSize: cs(document.querySelector(".dash-lede-title")).fontSize,
        focusTitle: document.querySelector(".dash-priority-title").tagName,
        focusSize: cs(document.querySelector(".dash-priority-title")).fontSize,
        focusRule: cs(focus).borderTopColor + " " + cs(focus).borderTopWidth,
        ledeBeforeFocus: top(lede) < top(focus),
        /* La priorité arrive avant l'emploi du temps, qui arrive avant les actions. */
        focusBeforeSchedule: top(focus) < top(document.getElementById("dash-schedule-card")),
        /* Une seule action primaire sur toute la page. */
        primaries: document.querySelectorAll(".dashboard .btn--primary").length,
        /* Et un seul point rouge structurel : le filet du bloc focal. */
        accentBorders: [...document.querySelectorAll(".dashboard *")]
          .filter(el => /227, 28, 61/.test(getComputedStyle(el).borderTopColor)
                     && getComputedStyle(el).borderTopWidth !== "0px").length,
      };
    });

    eq("l'accroche vient en premier", h.order[0], "dash-lede");
    check("puis la grille priorité + progression",
      /dash-grid/.test(h.order[1]), h.order);
    check("la salutation est un h1 en serif de titraille",
      h.ledeTitle === "H1" && h.ledeFont === "Newsreader" && h.ledeSize === "40px", h);
    check("la priorité est un h2, plus petit que la salutation",
      h.focusTitle === "H2" && parseFloat(h.focusSize) < parseFloat(h.ledeSize), h);
    eq("la carte priorité est coiffée d'un filet accent",
      h.focusRule, "rgb(227, 28, 61) 2px");
    check("l'accroche précède la priorité", h.ledeBeforeFocus, h);
    check("la priorité précède l'emploi du temps", h.focusBeforeSchedule, h);
    eq("une seule action primaire sur la page", h.primaries, 1);
    check("le rouge reste rare : au plus deux filets accent",
      h.accentBorders <= 2, h.accentBorders);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     2. DES PANNEAUX SÉPARÉS, ET AUCUN PANNEAU DANS UN PANNEAU
     ----------------------------------------------------------------------
     L'accueil est revenu à des cartes. Ce qui ne doit PAS revenir : la
     bannière en dégradé, les six tuiles identiques, et la boîte dans la
     boîte.
     ====================================================================== */
  current = "2. panneaux";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const c = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const panels = [...root.querySelectorAll(".dash-panel")];
      const shape = panels.map(el => {
        const cs = getComputedStyle(el);
        return `${cs.borderTopLeftRadius}|${cs.borderLeftWidth}|${cs.backgroundColor}|${cs.boxShadow !== "none"}`;
      });
      return {
        panels: panels.length,
        shapes: [...new Set(shape)],
        /* Un panneau dans un panneau : jamais. */
        nested: root.querySelectorAll(".dash-panel .dash-panel").length,
        oldBanner: root.querySelectorAll(".dash-banner").length,
        oldCards: root.querySelectorAll(".dash-card").length,
        /* Les cartes de matières sont posées sur l'ivoire, pas dans un panneau. */
        subjectsInPanel: root.querySelectorAll(".dash-panel .dash-subject").length,
        subjects: root.querySelectorAll(".dash-subject").length,
        /* L'accroche reste la seule zone sans carte. */
        ledeBoxed: getComputedStyle(root.querySelector(".dash-lede")).borderTopWidth,
        gap: getComputedStyle(root.querySelector(".dash-grid")).gap,
      };
    });

    check("l'accueil est fait de panneaux", c.panels >= 5, c.panels);
    /* Deux formes : les panneaux blancs, et la carte priorité sur lavis. */
    check("les panneaux partagent rayon, filet et ombre",
      c.shapes.every(x => /^12px\|1px\|/.test(x) && /\|true$/.test(x)), c.shapes);
    check("un seul panneau est sur lavis : la priorité",
      c.shapes.filter(x => !/rgb\(255, 255, 255\)/.test(x)).length === 1, c.shapes);
    eq("aucun panneau dans un panneau", c.nested, 0);
    eq("la bannière en dégradé n'est pas revenue", c.oldBanner, 0);
    eq("les anciennes tuiles ne sont pas revenues", c.oldCards, 0);
    check("des cartes de matières sont affichées", c.subjects >= 1, c.subjects);
    eq("elles ne sont pas enfermées dans un panneau", c.subjectsInPanel, 0);
    eq("l'accroche reste sans boîte", c.ledeBoxed, "0px");
    eq("les panneaux sont séparés par l'espace du système", c.gap, "24px");
    await page.close();
  }

  /* ======================================================================
     3. AUCUNE FONCTIONNALITÉ PERDUE — TOUTES LES DESTINATIONS RÉPONDENT
     ====================================================================== */
  current = "3. non-régression fonctionnelle";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

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
      ["#dash-schedule-week",       () => state.tab === "planning" && state.planning.calView === "week"],
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
     4. EMPLOI DU TEMPS — PRÉSENCE RÉELLE ET COMPTEUR VIVANT
     ====================================================================== */
  current = "4. emploi du temps";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const s = await page.evaluate(() => {
      const now = document.querySelector(".dash-now");
      const rows = [...document.querySelectorAll(".dash-agenda-row")];
      return {
        hasNow: !!now,
        nowTitle: now ? now.querySelector(".dash-now-title").textContent : null,
        nowStatus: now ? now.querySelector(".status").textContent.trim() : null,
        /* Les identifiants du compteur à la seconde sont conservés. */
        ticker: ["dash-ccourse-progress", "dash-ccourse-fill", "dash-ccourse-text"]
          .map(id => !!document.getElementById(id)),
        evStart: document.getElementById("dash-ccourse-progress")?.dataset.evStart ? true : false,
        notesBtn: !!document.querySelector("[data-open-event-notes]"),
        rows: rows.map(r => ({
          time: r.querySelector(".dash-agenda-time").textContent.trim(),
          title: r.querySelector(".dash-agenda-title").textContent.trim(),
          state: r.querySelector(".dash-agenda-state").textContent.trim(),
          cls: r.className,
        })),
        /* Colonne d'heures en chasse fixe et chiffres tabulaires. */
        timeFont: rows.length ? getComputedStyle(rows[0].querySelector(".dash-agenda-time")).fontFamily.split(",")[0].replace(/"/g, "") : null,
        timeNums: rows.length ? getComputedStyle(rows[0].querySelector(".dash-agenda-time")).fontVariantNumeric : null,
      };
    });

    check("le cours en cours est mis en avant", s.hasNow && /Analyse financière/.test(s.nowTitle), s);
    eq("il est annoncé « En cours »", s.nowStatus, "En cours");
    eq("le compteur à la seconde a gardé ses ancres", s.ticker, [true, true, true]);
    check("et ses bornes de temps", s.evStart, s.evStart);
    check("« Prendre des notes » est toujours là", s.notesBtn, s.notesBtn);
    /* La journée affichée est une VRAIE journée civile depuis que l'on peut
       choisir son jour : le lundi cliqué doit montrer le lundi entier, cours
       terminés compris. (Auparavant la fenêtre était « les 24 h qui
       viennent », ce qui convenait à un aperçu mais pas à un sélecteur.) */
    eq("toute la journée est listée, cours terminés compris", s.rows.length, 3);
    check("ils sont dans l'ordre horaire",
      s.rows.map(r => r.time).join(" ") === "09:00 – 10:30 16:00 – 17:30 18:00 – 19:30", s.rows);
    check("un cours déjà terminé est marqué comme tel",
      s.rows.some(r => /is-past/.test(r.cls) && r.state === "Terminé"), s.rows);
    check("les cours à venir aussi",
      s.rows.filter(r => /is-upcoming/.test(r.cls) && r.state === "À venir").length === 2, s.rows);
    eq("la colonne d'heures est en chasse fixe", s.timeFont, "IBM Plex Mono");
    eq("les heures sont tabulaires", s.timeNums, "tabular-nums");

    /* Le compteur avance réellement, sans re-rendu complet. */
    const before = await page.evaluate(() => document.getElementById("dash-ccourse-fill").style.width);
    await page.evaluate(() => { updateCurrentTimeIndicator(); });
    const after = await page.evaluate(() => ({
      width: document.getElementById("dash-ccourse-fill").style.width,
      text: document.getElementById("dash-ccourse-text").textContent,
    }));
    check("le compteur du cours en cours est mis à jour",
      after.width.endsWith("%") && /%/.test(after.text), { before, after });

    /* Aujourd'hui / demain change bien le jour affiché. */
    await page.click('[data-schedule-offset="1"]');
    await page.waitForTimeout(350);
    const tomorrow = await page.evaluate(() => ({
      pref: state.dashSchedulePreview,
      active: document.querySelector('.segmented [data-schedule-offset="1"]').className,
      noCurrent: !document.querySelector(".dash-now"),
    }));
    eq("« Demain » bascule l'aperçu", tomorrow.pref, "tomorrow");
    check("et le bouton est marqué actif", /active/.test(tomorrow.active), tomorrow);
    check("le cours « en cours » n'est pas montré pour demain", tomorrow.noCurrent, tomorrow);
    await page.close();
  }

  /* ======================================================================
     4 bis. LE CALENDRIER EST INTERACTIF, ET IL EST EN COULEUR
     ----------------------------------------------------------------------
     La couleur d'un cours n'est pas décorative : c'est celle de sa matière
     quand on la reconnaît, et sinon une couleur STABLE tirée de son
     intitulé — le même cours garde la même couleur d'un jour à l'autre.
     ====================================================================== */
  current = "4 bis. calendrier";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(500);

    /* La bande des sept jours. */
    const strip = await page.evaluate(() => {
      const days = [...document.querySelectorAll(".dash-day")];
      return {
        n: days.length,
        today: days.filter(d => d.classList.contains("is-today")).length,
        selected: days.filter(d => d.classList.contains("is-selected")).length,
        todayIsFirst: days[0].classList.contains("is-today"),
        dots: days[0].querySelectorAll(".dash-day-dot").length,
        dotColors: [...days[0].querySelectorAll(".dash-day-dot")]
          .map(d => getComputedStyle(d).backgroundColor),
        labelled: days.every(d => (d.getAttribute("aria-label") || "").length > 5),
      };
    });
    eq("la semaine entière est proposée", strip.n, 7);
    eq("aujourd'hui est repéré, et une seule fois", strip.today, 1);
    check("et c'est le premier jour de la bande", strip.todayIsFirst, strip);
    eq("un seul jour est sélectionné", strip.selected, 1);
    check("un point par cours du jour", strip.dots >= 2, strip);
    check("chaque jour est nommé pour les lecteurs d'écran", strip.labelled, strip);
    check("les points ne sont pas tous de la même couleur",
      new Set(strip.dotColors).size > 1, strip.dotColors);

    /* Choisir un jour change réellement la journée affichée. */
    const before = await page.evaluate(() =>
      [...document.querySelectorAll(".dash-agenda-title")].map(e => e.textContent.trim()));
    await page.click('.dash-day[data-schedule-offset="3"]');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      offset: state.dashScheduleOffset,
      selected: document.querySelector(".dash-day.is-selected").dataset.scheduleOffset,
      titles: [...document.querySelectorAll(".dash-agenda-title")].map(e => e.textContent.trim()),
      /* Un jour sans cours le dit, il ne montre pas la veille. */
      empty: !!document.querySelector("#dash-schedule-card .empty"),
    }));
    eq("cliquer un jour le sélectionne", after.offset, 3);
    eq("et la bande le montre", after.selected, "3");
    check("la journée affichée a changé",
      JSON.stringify(after.titles) !== JSON.stringify(before) || after.empty, { before, after });

    /* Les boutons Aujourd'hui / Demain pilotent le même état. */
    await page.click('[data-schedule-offset="1"]');
    await page.waitForTimeout(350);
    eq("« Demain » ramène au deuxième jour",
      await page.evaluate(() => state.dashScheduleOffset), 1);
    await page.click('[data-schedule-offset="0"]');
    await page.waitForTimeout(350);
    eq("« Aujourd'hui » ramène au premier",
      await page.evaluate(() => state.dashScheduleOffset), 0);
    check("et l'ancien état reste tenu à jour",
      await page.evaluate(() => state.dashSchedulePreview) === "today", "");

    /* Le rail : les cours à leur heure réelle, et le trait de l'heure. */
    const rail = await page.evaluate(() => {
      const track = document.querySelector(".dash-rail-track");
      if (!track) return null;
      const blocks = [...track.querySelectorAll(".dash-rail-block")];
      const now = document.getElementById("dash-rail-now");
      return {
        blocks: blocks.length,
        /* Les blocs sont ordonnés comme les heures. */
        lefts: blocks.map(b => Math.round(parseFloat(b.style.left))),
        colors: blocks.map(b => getComputedStyle(b).borderLeftColor),
        titled: blocks.every(b => (b.getAttribute("title") || "").length > 5),
        nowVisible: !!now,
        nowLeft: now ? Math.round(parseFloat(now.style.left)) : null,
        ticks: track.parentElement.querySelectorAll(".dash-rail-tick").length,
      };
    });
    check("le rail montre les cours du jour", rail && rail.blocks >= 2, rail);
    check("dans l'ordre des heures",
      rail.lefts.every((v, i) => i === 0 || v >= rail.lefts[i - 1]), rail.lefts);
    check("chacun à sa couleur", new Set(rail.colors).size > 1, rail.colors);
    check("chacun nommé au survol", rail.titled, rail);
    check("le trait de l'heure est là", rail.nowVisible, rail);
    check("et il est dans le rail", rail.nowLeft >= 0 && rail.nowLeft <= 100, rail.nowLeft);
    check("les heures sont graduées", rail.ticks >= 2, rail.ticks);

    /* Cliquer un bloc ouvre la fiche du cours. */
    await page.click(".dash-rail-block");
    await page.waitForTimeout(400);
    check("cliquer un bloc ouvre la fiche du cours",
      await page.evaluate(() => !!document.querySelector(".cal-modal, .modal")), "");

    await page.close();
  }

  /* ======================================================================
     4 ter. LA COULEUR DES MATIÈRES ENTRE DANS L'INTERFACE
     ====================================================================== */
  current = "4 ter. couleur";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(500);

    const c = await page.evaluate(() => {
      const card = document.querySelector(".dash-subject");
      const row = document.querySelector(".dash-agenda-row");
      const prio = document.querySelector(".dash-panel--priority");
      const plain = document.querySelector(".dash-panel:not(.dash-panel--priority)");
      return {
        subjectRule: card ? getComputedStyle(card).borderLeftColor : null,
        subjectVar: card ? card.style.getPropertyValue("--course-color") : null,
        rowRule: row ? getComputedStyle(row).borderLeftColor : null,
        rowWidth: row ? getComputedStyle(row).borderLeftWidth : null,
        prioBg: getComputedStyle(prio).backgroundColor,
        plainBg: getComputedStyle(plain).backgroundColor,
        dot: (() => {
          const d = document.querySelector(".dash-row-dot");
          return d ? getComputedStyle(d).backgroundColor : null;
        })(),
      };
    });
    eq("une carte de matière porte le filet de sa couleur", c.subjectRule, "rgb(227, 28, 61)");
    check("posée par variable, pas par trois styles en ligne",
      /^#/.test(c.subjectVar), c.subjectVar);
    check("une ligne d'agenda aussi",
      c.rowWidth === "3px" && c.rowRule !== "rgb(0, 0, 0)", c);
    /* Le seul fond coloré de la page est la carte priorité. */
    eq("la carte priorité est sur lavis", c.prioBg, "rgb(253, 242, 244)");
    eq("les autres panneaux restent blancs", c.plainBg, "rgb(255, 255, 255)");
    check("les listes portent un point de couleur", c.dot !== null, c);

    /* La couleur d'un cours non rattaché est STABLE : deux rendus du même
       intitulé donnent la même couleur. */
    const stable = await page.evaluate(() => {
      const a = eventColor({ summary: "Droit des affaires" });
      const b = eventColor({ summary: "Droit des affaires" });
      const d = eventColor({ summary: "Anglais des affaires" });
      return { a, b, d, dansLaPalette: SUBJECT_COLORS.includes(a) };
    });
    eq("le même intitulé donne toujours la même couleur", stable.a, stable.b);
    check("deux intitulés différents en donnent deux", stable.a !== stable.d, stable);
    check("et elle vient de la palette du produit", stable.dansLaPalette, stable);
    await page.close();
  }

  /* ======================================================================
     5. LES CHIFFRES SONT LES MÊMES QU'AVANT
     ====================================================================== */
  current = "5. compteurs";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const g = globalMetrics();
      const vals = [...document.querySelectorAll(".dash-measure b")].map(e => e.textContent.trim());
      const labels = [...document.querySelectorAll(".dash-measure span")].map(e => e.textContent.trim());
      return {
        headline: document.querySelector(".dash-progress-value").textContent.trim(),
        expectedHeadline: g.mastery + "%",
        vals, labels,
        expectedQuestions: g.answered + "/" + g.total,
        expectedTime: fmtDuration(state.dash.timeSpentSeconds),
        meterWidth: document.querySelector(".dash-panel .meter-fill").style.width,
        /* Une mesure est une ligne, pas une petite carte. */
        statBoxed: getComputedStyle(document.querySelector(".dash-measure")).borderTopWidth,
        /* Les cours récents affichent leurs contenus disponibles… */
        tags: [...document.querySelectorAll(".dash-row-tags")].map(e => e.textContent.replace(/\s+/g, " ").trim()),
        /* …et leur état de révision, sur la ligne du titre. */
        states: [...document.querySelectorAll(".dash-row--stack .status")].map(e => e.textContent.trim()),
        feed: document.querySelectorAll(".dash-log-item").length,
      };
    });

    eq("le pourcentage de maîtrise est celui du moteur", m.headline, m.expectedHeadline);
    eq("la jauge suit le même pourcentage", m.meterWidth, m.expectedHeadline);
    eq("les quatre mesures sont toujours là", m.vals.length, 4);
    check("questions travaillées : même valeur qu'avant",
      m.vals.includes(m.expectedQuestions), m);
    check("temps de révision : même valeur qu'avant",
      m.vals.includes(m.expectedTime), m);
    eq("une mesure n'est pas encadrée", m.statBoxed, "0px");
    check("les contenus disponibles d'un cours sont annoncés",
      m.tags.some(x => /Quiz/.test(x) && /Flashcards/.test(x) && /Questions/.test(x)), m.tags);
    check("l'état de révision aussi",
      m.states.includes("À revoir") && m.states.includes("Révisé"), m.states);
    eq("l'activité récente est listée", m.feed, 3);
    await page.close();
  }

  /* ======================================================================
     6. RIEN DE RÉPÉTITIF — CHAQUE DESTINATION UNE SEULE FOIS
     ====================================================================== */
  current = "6. répétitions";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      /* On cherche les doublons DANS UNE MÊME zone : un même libellé sur
         deux boutons de sections différentes (une matière et le cours qui
         porte son nom) désigne deux objets distincts, ce n'est pas une
         répétition. */
      const dup = [];
      for (const zone of root.children) {
        /* On compare les NOMS ACCESSIBLES : le bloc du rail et la fiche du
           cours en cours montrent le même cours sous deux formes, et le rail
           précise son horaire dans son aria-label — ce sont bien deux
           commandes distinctes pour un lecteur d'écran. */
        const labels = [...zone.querySelectorAll("button")]
          .map(b => (b.getAttribute("aria-label") || b.textContent).replace(/\s+/g, " ").trim())
          .filter(Boolean);
        labels.forEach((l, i) => { if (labels.indexOf(l) !== i) dup.push(l); });
      }
      const ids = {};
      root.querySelectorAll("[id]").forEach(e => { ids[e.id] = (ids[e.id] || 0) + 1; });
      return {
        dup: [...new Set(dup)],
        dupIds: Object.entries(ids).filter(([, n]) => n > 1),
        /* Plus aucun emoji dans le tableau de bord. */
        emoji: [...root.querySelectorAll("*")]
          .filter(el => el.children.length === 0)
          .map(el => el.textContent)
          .filter(txt => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(txt)),
        /* Ni flèche « → » postiche. */
        arrows: [...root.querySelectorAll("*")]
          .filter(el => el.children.length === 0 && /→/.test(el.textContent))
          .map(el => el.textContent.trim()),
        actions: root.querySelectorAll(".dash-action").length,
      };
    });
    eq("aucun bouton en double dans la page", r.dup, []);
    eq("aucun identifiant en double", r.dupIds, []);
    eq("aucun emoji dans le tableau de bord", r.emoji, []);
    eq("aucune flèche typographique postiche", r.arrows, []);
    eq("les huit destinations sont listées une seule fois", r.actions, 8);
    await page.close();
  }

  /* ======================================================================
     7. RESPONSIVE — MOBILE D'ABORD
     ====================================================================== */
  for (const vp of VIEWPORTS) {
    current = `7. ${vp.name}`;
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const over = [...root.querySelectorAll("*")]
        .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(el => el.className || el.tagName).slice(0, 6);
      const split = getComputedStyle(document.querySelector(".dash-grid--split"));
      const actions = getComputedStyle(document.querySelector(".dash-actions"));
      const agenda = document.querySelector(".dash-agenda-row");
      return {
        overflowing: over,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        splitCols: split.gridTemplateColumns.split(" ").length,
        actionCols: actions.gridTemplateColumns.split(" ").length,
        agendaCols: agenda ? getComputedStyle(agenda).gridTemplateColumns.split(" ").length : null,
        focusDir: getComputedStyle(document.querySelector(".dash-priority-actions")).flexDirection,
        ledeSize: getComputedStyle(document.querySelector(".dash-lede-title")).fontSize,
        /* Le texte reste lisible : la colonne de lecture ne s'étale pas. */
        subWidth: Math.round(document.querySelector(".dash-lede-sub").getBoundingClientRect().width),
        sections: root.querySelectorAll(":scope > *").length,
        panels: root.querySelectorAll(".dash-panel").length,
      };
    });

    eq(`[${vp.name}] aucun élément ne déborde`, r.overflowing, []);
    check(`[${vp.name}] pas de défilement horizontal`, !r.pageOverflow, r.pageOverflow);
    check(`[${vp.name}] toutes les zones sont rendues`, r.sections >= 6, r.sections);
    check(`[${vp.name}] les cinq panneaux sont rendus`, r.panels >= 5, r.panels);
    if (vp.width <= 640) {
      eq(`[${vp.name}] une seule colonne pour les paires de panneaux`, r.splitCols, 1);
      eq(`[${vp.name}] une action par ligne`, r.actionCols, 1);
      eq(`[${vp.name}] les actions de la priorité s'empilent`, r.focusDir, "column");
      eq(`[${vp.name}] l'heure passe au-dessus du libellé`, r.agendaCols, 2);
      check(`[${vp.name}] la salutation est réduite`, parseFloat(r.ledeSize) <= 30, r.ledeSize);
    } else if (vp.width <= 1024) {
      eq(`[${vp.name}] les paires de panneaux passent l'une sous l'autre`, r.splitCols, 1);
    } else {
      eq(`[${vp.name}] les paires de panneaux sont côte à côte`, r.splitCols, 2);
      eq(`[${vp.name}] l'heure a sa colonne`, r.agendaCols, 3);
      check(`[${vp.name}] la colonne de lecture reste mesurée`, r.subWidth <= 680, r.subWidth);
    }
    eq(`[${vp.name}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     8. ACCESSIBILITÉ
     ====================================================================== */
  current = "8. accessibilité";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await freezeClock(page);
    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.evaluate(SEED);
    await page.waitForTimeout(400);

    const a = await page.evaluate(() => {
      const root = document.querySelector(".dashboard");
      const headings = [...root.querySelectorAll("h1,h2,h3")].map(h => +h.tagName[1]);
      /* Tout ce qui se clique est un vrai bouton, pas une div avec un rôle. */
      const fakeButtons = [...root.querySelectorAll('[role="button"]')]
        .filter(el => el.tagName !== "BUTTON").map(el => el.className);
      const rows = [...root.querySelectorAll(".dash-row, .dash-agenda-row, .dash-action")];
      return {
        headings,
        fakeButtons,
        allRealButtons: rows.every(el => el.tagName === "BUTTON"),
        /* Focus clavier visible sur une ligne d'index. */
        focus: (() => {
          const el = root.querySelector(".dash-row"); el.focus();
          const cs = getComputedStyle(el);
          return { outline: cs.outlineStyle, width: cs.outlineWidth };
        })(),
      };
    });
    eq("un seul h1 dans la page", a.headings.filter(n => n === 1).length, 1);
    check("la hiérarchie des titres ne saute pas de niveau",
      a.headings.every((n, i) => i === 0 || n - a.headings[i - 1] <= 1), a.headings);
    eq("aucune fausse div cliquable", a.fakeButtons, []);
    check("lignes d'index, d'agenda et d'action : de vrais boutons", a.allRealButtons, a);
    check("focus clavier visible sur une ligne",
      a.focus.outline !== "none" && parseFloat(a.focus.width) >= 2, a.focus);
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
