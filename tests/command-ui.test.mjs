/* ============================================================================
   REV-EM — Command Center : le branchement, dans un vrai navigateur
   ----------------------------------------------------------------------------
   Le MOTEUR est testé séparément, sans navigateur (tests/command-center.test.js,
   60 vérifications). Ce fichier-ci teste ce qu'un test Node ne peut pas voir :
   le raccourci clavier réel, le focus, la navigation aux flèches, le rendu, le
   responsive, les cinq langues, et le fait qu'une action ouvre réellement ce
   qu'elle annonce.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/command-ui.test.mjs
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

/* Des données RÉELLES, créées par les fonctions du produit. « Intégration »
   n'a volontairement ni quiz ni flashcards : c'est lui qui prouve qu'on
   n'invente rien. */
const SEED = () => {
  const now = Date.now();
  state.userSubjects = [
    { id: "s1", name: "Mathématiques", semesterId: (SEMESTERS[0] || {}).id,
      color: "#2C5FA8", description: "Analyse et algèbre" },
    { id: "s2", name: "Analyse financière", semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D" },
  ];
  state.userChapters = [
    { id: "c1", subjectId: "s1", num: "1", title: "Dérivation", desc: "Taux de variation",
      content: "texte", aiQuiz: [{ q: "?", opts: ["a", "b"], correct: 0 }, { q: "?", opts: ["a", "b"], correct: 1 }],
      aiFlashcards: [{ front: "a", back: "b" }], aiReviewQuestions: ["?"],
      createdAt: now, updatedAt: now, markedReviewed: false },
    { id: "c2", subjectId: "s1", num: "2", title: "Intégration", desc: "",
      content: "texte", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
      createdAt: now, updatedAt: now, markedReviewed: false },
  ];
  saveUserSubjects(); saveUserChapters();
  switchTab("dashboard"); render();
};

async function open(browser, vp, lang) {
  const page = await browser.newPage({ viewport: vp || { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(1400);
  if (lang) { await page.evaluate(l => LyonI18n.setLang(l), lang); await page.waitForTimeout(300); }
  await page.evaluate(SEED);
  await page.waitForTimeout(300);
  return { page, errors };
}

/* Taper dans le champ réel, touche par touche : c'est le seul moyen de
   vérifier que le curseur ne repart pas au début à chaque frappe. */
const typeQuery = async (page, q) => {
  await page.click("#cc-input");
  await page.keyboard.type(q, { delay: 12 });
  await page.waitForTimeout(250);
};
const titles = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".cc-item-title")].map(e => e.textContent.trim()));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. OUVERTURE ET FERMETURE
     ====================================================================== */
  await scenario("1. ouvrir et fermer", async () => {
    const { page, errors } = await open(browser);

    eq("au repos, rien n'est rendu", await page.evaluate(() => document.getElementById("cc-root").innerHTML), "");

    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    check("Ctrl+K ouvre le panneau", await page.evaluate(() => !!document.querySelector(".cc-panel")), "");
    eq("le champ est actif d'emblée", await page.evaluate(() => document.activeElement.id), "cc-input");

    /* Le raccourci referme aussi : c'est ce qu'on attend d'une bascule. */
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    check("Ctrl+K referme", await page.evaluate(() => !document.querySelector(".cc-panel")), "");

    /* Cmd+K, pour les claviers Mac. */
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(250);
    check("Cmd+K ouvre aussi", await page.evaluate(() => !!document.querySelector(".cc-panel")), "");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check("Échap ferme", await page.evaluate(() => !document.querySelector(".cc-panel")), "");

    /* Le bouton visible de l'interface. */
    await page.click("#cc-trigger");
    await page.waitForTimeout(300);
    check("le bouton de l'en-tête ouvre", await page.evaluate(() => !!document.querySelector(".cc-panel")), "");

    await page.click(".cc-backdrop", { position: { x: 5, y: 5 } });
    await page.waitForTimeout(250);
    check("cliquer le fond ferme", await page.evaluate(() => !document.querySelector(".cc-panel")), "");

    /* Le focus revient d'où il venait. */
    await page.evaluate(() => document.getElementById("cc-trigger").focus());
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    eq("le focus est rendu à ce qui l'avait",
      await page.evaluate(() => document.activeElement.id), "cc-trigger");

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     2. L'EXEMPLE DE LA DEMANDE — « MATHS »
     ====================================================================== */
  await scenario("2. une matière ramène ses chapitres et ses contenus", async () => {
    const { page, errors } = await open(browser);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "maths");

    const vus = await titles(page);
    check("la matière", vus.includes("Mathématiques"), vus);
    check("ses chapitres", vus.includes("Dérivation") && vus.includes("Intégration"), vus);
    check("le quiz du chapitre qui en a un", vus.includes("Quiz : Dérivation"), vus);
    check("ses flashcards", vus.includes("Flashcards : Dérivation"), vus);

    /* AUCUNE DONNÉE INVENTÉE : « Intégration » n'a ni quiz ni flashcards, il
       ne doit donc produire aucune entrée de contenu. */
    check("le chapitre sans quiz n'en fait pas apparaître un",
      !vus.includes("Quiz : Intégration"), vus);
    check("ni de flashcards", !vus.includes("Flashcards : Intégration"), vus);

    const cats = await page.evaluate(() =>
      [...document.querySelectorAll(".cc-group-label")].map(e => e.textContent.trim()));
    check("chaque résultat est rangé sous sa catégorie", cats.length >= 3, cats);
    check("et les catégories sont traduites, pas des clés",
      cats.every(c => !/^cc\./.test(c)), cats);

    /* L'aperçu utile : ce que le chapitre contient vraiment. */
    const meta = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".cc-item")]
        .find(el => el.querySelector(".cc-item-title").textContent.trim() === "Dérivation");
      return row ? row.querySelector(".cc-item-meta").textContent.trim() : null;
    });
    check("un chapitre annonce ce qu'il contient", /Quiz/.test(meta) && /Flashcards/.test(meta), meta);

    const metaVide = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".cc-item")]
        .find(el => el.querySelector(".cc-item-title").textContent.trim() === "Intégration");
      return row ? row.querySelector(".cc-item-meta").textContent.trim() : null;
    });
    check("et celui qui n'a qu'une fiche ne promet rien d'autre",
      metaVide && !/Quiz|Flashcards/.test(metaVide), metaVide);

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     3. TOLÉRANCE AUX FAUTES, DANS LE VRAI CHAMP
     ====================================================================== */
  await scenario("3. tolérance aux fautes", async () => {
    const { page, errors } = await open(browser);
    const cherche = async (q) => {
      await page.evaluate(() => { if(!document.querySelector(".cc-panel")) ccOpen(); });
      await page.evaluate(() => { const i = document.getElementById("cc-input"); i.value = ""; i.dispatchEvent(new Event("input")); });
      await typeQuery(page, q);
      return await titles(page);
    };

    check("lettre manquante : « derivaton »", (await cherche("derivaton")).includes("Dérivation"), "");
    check("lettre en trop : « derivvation »", (await cherche("derivvation")).includes("Dérivation"), "");
    check("inversion : « dreivation »", (await cherche("dreivation")).includes("Dérivation"), "");
    check("sans accent : « integration »", (await cherche("integration")).includes("Intégration"), "");
    check("début de mot : « deriv »", (await cherche("deriv")).includes("Dérivation"), "");

    /* Et quand vraiment rien ne correspond, on le dit. */
    const rien = await cherche("zzzzzzzz");
    eq("aucune correspondance : aucune ligne", rien, []);
    const msg = await page.evaluate(() => {
      const e = document.querySelector(".cc-empty-title");
      return e ? e.textContent.trim() : null;
    });
    check("un message explique, il n'y a pas d'écran vide", msg && msg.length > 5, msg);
    check("et il reprend ce qui a été tapé", /zzzzzzzz/.test(msg), msg);

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     4. LE CLAVIER
     ====================================================================== */
  await scenario("4. navigation au clavier", async () => {
    const { page, errors } = await open(browser);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);

    const actif = () => page.evaluate(() => {
      const a = document.querySelector(".cc-item.is-active");
      return a ? { i: Number(a.dataset.ccIndex), titre: a.querySelector(".cc-item-title").textContent.trim() } : null;
    });

    const premier = await actif();
    eq("à l'ouverture, la première ligne est active", premier.i, 0);

    await page.keyboard.press("ArrowDown");
    eq("↓ descend d'une ligne", (await actif()).i, 1);
    await page.keyboard.press("ArrowUp");
    eq("↑ remonte", (await actif()).i, 0);

    /* La liste boucle : en haut, ↑ ramène en bas. */
    const total = await page.evaluate(() => document.querySelectorAll(".cc-item").length);
    await page.keyboard.press("ArrowUp");
    eq("↑ depuis la première ligne ramène à la dernière", (await actif()).i, total - 1);
    await page.keyboard.press("ArrowDown");
    eq("et ↓ depuis la dernière revient à la première", (await actif()).i, 0);

    await page.keyboard.press("End");
    eq("Fin va à la dernière", (await actif()).i, total - 1);
    await page.keyboard.press("Home");
    eq("Début revient à la première", (await actif()).i, 0);

    /* Une seule ligne active à la fois — deux surbrillances feraient douter
       de ce qu'Entrée va ouvrir. */
    eq("une seule ligne est active",
      await page.evaluate(() => document.querySelectorAll(".cc-item.is-active").length), 1);

    /* Le lien accessible entre le champ et l'option active. */
    const aria = await page.evaluate(() => {
      const i = document.getElementById("cc-input");
      const a = document.querySelector(".cc-item.is-active");
      return { pointe: i.getAttribute("aria-activedescendant"), id: a.id,
               selectionnee: a.getAttribute("aria-selected") };
    });
    eq("le champ désigne l'option active", aria.pointe, aria.id);
    eq("et elle est annoncée sélectionnée", aria.selectionnee, "true");

    /* Le focus ne sort pas du panneau. */
    await page.keyboard.press("Tab");
    const apresTab = await page.evaluate(() => document.activeElement.className || document.activeElement.id);
    check("Tab reste dans le panneau", /cc-/.test(String(apresTab)), apresTab);

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     5. ENTRÉE OUVRE RÉELLEMENT CE QUI EST ANNONCÉ
     ====================================================================== */
  await scenario("5. Entrée exécute", async () => {
    const { page, errors } = await open(browser);

    /* Une page. */
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "statistiques");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    eq("une page ouvre le bon écran", await page.evaluate(() => state.tab), "stats");
    check("et le panneau s'est fermé", await page.evaluate(() => !document.querySelector(".cc-panel")), "");

    /* Un chapitre. */
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "dérivation");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    eq("un chapitre ouvre sa fiche",
      await page.evaluate(() => ({ tab: state.tab, vue: state.library.view, ch: state.library.chapterId })),
      { tab: "library", vue: "chapterDetail", ch: "c1" });

    /* Un quiz : il démarre pour de vrai, avec les vraies questions. */
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "quiz dérivation");
    const cible = await page.evaluate(() => {
      const a = document.querySelector(".cc-item.is-active");
      return a ? a.querySelector(".cc-item-title").textContent.trim() : null;
    });
    eq("la première ligne est bien le quiz visé", cible, "Quiz : Dérivation");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const quiz = await page.evaluate(() => ({
      tab: state.tab, scope: state.playing && state.playing.scope, pool: state.pool ? state.pool.length : 0,
    }));
    eq("le quiz démarre sur le bon chapitre", [quiz.tab, quiz.scope], ["quiz", "chapter:c1"]);
    eq("avec les questions réelles du chapitre", quiz.pool, 2);

    /* Une action. */
    await page.evaluate(() => { switchTab("dashboard"); });
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "importer un cours");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    eq("une action mène là où elle annonce",
      await page.evaluate(() => ({ tab: state.tab, vue: state.library.view })),
      { tab: "library", vue: "import" });

    /* Le clic souris fait la même chose que la touche Entrée. */
    await page.evaluate(() => { switchTab("dashboard"); });
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await typeQuery(page, "planning");
    await page.click(".cc-item.is-active");
    await page.waitForTimeout(500);
    eq("le clic ouvre aussi", await page.evaluate(() => state.tab), "planning");

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     6. REQUÊTE VIDE — ON PROPOSE, ON NE DÉVERSE PAS
     ====================================================================== */
  await scenario("6. état initial", async () => {
    const { page } = await open(browser);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => ({
      lignes: document.querySelectorAll(".cc-item").length,
      cats: [...document.querySelectorAll(".cc-group-label")].map(e => e.textContent.trim()),
      titres: [...document.querySelectorAll(".cc-item-title")].map(e => e.textContent.trim()),
    }));
    check("quelques propositions, pas le catalogue", r.lignes > 0 && r.lignes <= 8, r.lignes);
    check("et ce sont des actions", r.cats.length === 1, r.cats);
    check("dont « commencer une révision »",
      r.titres.some(x => /rÉvision|revision|repaso|wiederholung|ripasso/i.test(x)), r.titres);

    /* Les raccourcis sont AFFICHÉS : un raccourci que personne ne voit
       n'existe pas. */
    const pied = await page.evaluate(() => document.querySelector(".cc-foot").textContent.replace(/\s+/g, " ").trim());
    check("les raccourcis sont montrés dans l'interface",
      /↑/.test(pied) && /↓/.test(pied), pied);
    check("avec Entrée et Échap", /Entr|Esc|Échap|Invio|Intro/i.test(pied), pied);
    await page.close();
  });

  /* ======================================================================
     7. ACCESSIBILITÉ
     ====================================================================== */
  await scenario("7. accessibilité", async () => {
    const { page } = await open(browser);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);

    const a = await page.evaluate(() => {
      const p = document.querySelector(".cc-panel");
      const i = document.getElementById("cc-input");
      const l = document.getElementById("cc-results");
      return {
        role: p.getAttribute("role"), modal: p.getAttribute("aria-modal"),
        champRole: i.getAttribute("role"), champAuto: i.getAttribute("aria-autocomplete"),
        listeRole: l.getAttribute("role"),
        options: document.querySelectorAll('.cc-item[role="option"]').length,
        lignes: document.querySelectorAll(".cc-item").length,
        iconesCachees: [...document.querySelectorAll(".cc-item-icon svg")]
          .every(s => s.getAttribute("aria-hidden") === "true"),
        boutonNomme: (document.getElementById("cc-trigger").getAttribute("aria-label") || "").length > 3,
      };
    });
    eq("le panneau est une boîte de dialogue modale", [a.role, a.modal], ["dialog", "true"]);
    eq("le champ est une liste déroulante de recherche", [a.champRole, a.champAuto], ["combobox", "list"]);
    eq("les résultats sont une liste d'options", a.listeRole, "listbox");
    eq("et chaque ligne est une option", a.options, a.lignes);
    check("les icônes décoratives sont cachées aux lecteurs d'écran", a.iconesCachees, a);
    check("le bouton de l'en-tête est nommé", a.boutonNomme, a);
    await page.close();
  });

  /* ======================================================================
     8. RESPONSIVE
     ====================================================================== */
  for (const vp of [{ name: "bureau", width: 1440, height: 900 },
                    { name: "tablette", width: 768, height: 1024 },
                    { name: "mobile", width: 375, height: 812 }]) {
    await scenario(`8. ${vp.name}`, async () => {
      const { page, errors } = await open(browser, { width: vp.width, height: vp.height });
      await page.evaluate(() => ccOpen());
      await page.waitForTimeout(350);
      await typeQuery(page, "math");

      const r = await page.evaluate(() => {
        const p = document.querySelector(".cc-panel").getBoundingClientRect();
        const f = document.querySelector(".cc-field").getBoundingClientRect();
        const pied = document.querySelector(".cc-foot").getBoundingClientRect();
        const items = [...document.querySelectorAll(".cc-item")];
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        return {
          panneauDansEcran: p.left >= -1 && p.right <= vw + 1 && p.top >= -1,
          champVisible: f.top >= 0 && f.height > 20,
          piedEnBas: Math.abs(pied.bottom - Math.min(p.bottom, vh)) < 2,
          hauteurLignes: items.map(el => Math.round(el.getBoundingClientRect().height)),
          debordement: items.some(el => el.getBoundingClientRect().right > vw + 1),
          pageDeborde: document.documentElement.scrollWidth > vw + 1,
          boutonVisible: (() => {
            const b = document.getElementById("cc-trigger").getBoundingClientRect();
            return b.width > 0 && b.height > 0;
          })(),
        };
      });

      check(`[${vp.name}] le panneau tient dans l'écran`, r.panneauDansEcran, r);
      check(`[${vp.name}] le champ de recherche est visible`, r.champVisible, r);
      check(`[${vp.name}] le pied est en bas du panneau`, r.piedEnBas, r);
      check(`[${vp.name}] aucune ligne ne déborde`, !r.debordement, r);
      check(`[${vp.name}] pas de défilement horizontal`, !r.pageDeborde, r);
      check(`[${vp.name}] le bouton d'accès reste visible`, r.boutonVisible, r);
      check(`[${vp.name}] les lignes se touchent (≥ 44px)`,
        r.hauteurLignes.every(h => h >= 44), r.hauteurLignes);
      eq(`[${vp.name}] aucune erreur JavaScript`, errors, []);
      await page.close();
    });
  }

  /* ======================================================================
     9. LES CINQ LANGUES
     ====================================================================== */
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    await scenario(`9. ${lang}`, async () => {
      const { page, errors } = await open(browser, { width: 1440, height: 900 }, lang);
      await page.evaluate(() => ccOpen());
      await page.waitForTimeout(350);

      const vide = await page.evaluate(() => ({
        placeholder: document.getElementById("cc-input").getAttribute("placeholder"),
        pied: document.querySelector(".cc-foot").textContent.replace(/\s+/g, " ").trim(),
        cats: [...document.querySelectorAll(".cc-group-label")].map(e => e.textContent.trim()),
        titres: [...document.querySelectorAll(".cc-item-title")].map(e => e.textContent.trim()),
        esc: document.querySelector(".cc-esc").textContent.trim(),
      }));
      check(`[${lang}] l'invite est traduite`, vide.placeholder && vide.placeholder.length > 10, vide.placeholder);
      check(`[${lang}] les raccourcis sont traduits`, vide.pied.length > 10, vide.pied);
      check(`[${lang}] le bouton de fermeture aussi`, vide.esc.length > 2, vide.esc);
      check(`[${lang}] aucune clé brute à l'écran`,
        ![vide.placeholder, vide.pied, vide.esc].concat(vide.cats, vide.titres)
          .some(s => /\b(cc|dashboard|nav)\.[a-z_]+/.test(String(s))),
        { cats: vide.cats, titres: vide.titres });

      await typeQuery(page, "math");
      const res = await page.evaluate(() => ({
        cats: [...document.querySelectorAll(".cc-group-label")].map(e => e.textContent.trim()),
        metas: [...document.querySelectorAll(".cc-item-meta")].map(e => e.textContent.trim()),
      }));
      check(`[${lang}] les catégories sont traduites`,
        res.cats.length > 0 && !res.cats.some(c => /\bcc\./.test(c)), res.cats);
      check(`[${lang}] les aperçus aussi`,
        !res.metas.some(m => /\bdashboard\./.test(m)), res.metas);
      eq(`[${lang}] aucune erreur JavaScript`, errors, []);
      await page.close();
    });
  }

  /* ======================================================================
     10. CONNECTÉ ET DÉCONNECTÉ
     ====================================================================== */
  await scenario("10. avec et sans compte", async () => {
    const { page, errors } = await open(browser);

    /* Déconnecté — l'état par défaut de cette page de test. */
    await page.evaluate(() => ccOpen());
    await page.waitForTimeout(300);
    await typeQuery(page, "maths");
    const hors = await titles(page);
    check("déconnecté : la recherche fonctionne", hors.includes("Mathématiques"), hors);
    await page.keyboard.press("Escape");

    /* Connecté : on remplace la seule source de vérité du nom affiché, sans
       toucher ni à l'authentification ni au stockage. */
    const dedans = await page.evaluate(async () => {
      const vrai = window.getCurrentUserDisplayName;
      window.getCurrentUserDisplayName = () => "Anton";
      render();
      ccOpen();
      const i = document.getElementById("cc-input");
      i.value = "maths"; i.dispatchEvent(new Event("input"));
      const out = [...document.querySelectorAll(".cc-item-title")].map(e => e.textContent.trim());
      ccClose();
      window.getCurrentUserDisplayName = vrai;
      render();
      return out;
    });
    check("connecté : les mêmes résultats", dedans.includes("Mathématiques"), dedans);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     11. RIEN N'EST CASSÉ AUTOUR
     ====================================================================== */
  await scenario("11. la navigation existante est intacte", async () => {
    const { page, errors } = await open(browser);

    /* La barre de navigation ne déborde pas — c'est le bouton ajouté qui
       l'avait fait, et la mesure le vérifie maintenant à chaque exécution. */
    const nav = await page.evaluate(() => {
      const n = document.querySelector(".mainnav");
      const contenu = [...n.children].reduce((s, c) => s + c.getBoundingClientRect().width, 0);
      return { marge: Math.round(n.getBoundingClientRect().width - contenu) };
    });
    check("la barre de navigation ne déborde pas", nav.marge >= 0, nav);

    /* Et elle mène toujours où il faut. */
    await page.click('[data-goto="planning"]');
    await page.waitForTimeout(400);
    eq("un onglet de la navigation fonctionne", await page.evaluate(() => state.tab), "planning");

    /* Échap ne doit pas fermer autre chose quand le panneau est fermé. */
    await page.evaluate(() => { state.planning.selectedEventId = null; switchTab("dashboard"); });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    eq("Échap hors panneau ne change rien", await page.evaluate(() => state.tab), "dashboard");

    /* Pendant un examen, le raccourci est neutralisé : le mode sans
       distraction ne doit pas pouvoir être percé. */
    const exam = await page.evaluate(() => {
      state.tab = "exam"; state.exam.screen = "running";
      const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      const ouvert = !!document.querySelector(".cc-panel");
      state.exam.screen = "setup"; state.tab = "dashboard"; render();
      return ouvert;
    });
    check("Ctrl+K est neutralisé pendant un examen", !exam, exam);

    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
