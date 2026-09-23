/* ============================================================================
   ÉTAPE 9 — FINITION
   ----------------------------------------------------------------------------
   Ce suite mesure ce qu'un œil finit par manquer : le nombre de valeurs
   distinctes réellement RENDUES à l'écran. Un système tient quand ce nombre
   est petit — pas quand la feuille de styles est jolie.

   Sur les seize écrans, en 1440 et en 375 :
     • combien de tailles de texte ?      (l'échelle en compte 7)
     • combien de graisses ?               (le système en autorise 3)
     • combien de rayons ?                 (trois, plus la pastille)
     • combien d'ombres ?                  (une seule, plus l'anneau de focus)
     • les écarts verticaux sont-ils sur la grille de 8 ?
     • les titres se hiérarchisent-ils vraiment (h1 > h2 ≥ h3) ?
     • y a-t-il une boîte dans une boîte ?
     • du vide mort en bas d'un panneau ?
     • une couleur hors palette ?

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/detail.test.mjs
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

const PAGES = [
  ["accueil",      () => { switchTab("dashboard"); }],
  ["mes-matieres", () => { libGoto("subjects"); switchTab("library"); }],
  ["matiere",      () => { libGoto("subjectDetail", { subjectId: "t-subj" }); switchTab("library"); }],
  ["chapitre",     () => { libGoto("chapterDetail", { chapterId: "t-ch1" }); switchTab("library"); }],
  ["ressources",   () => { switchTab("fiches"); }],
  ["import",       () => { goToCourseImport(); switchTab("library"); }],
  ["activites",    () => { switchTab("activities"); }],
  ["flashcards",   () => { state.flashScreen = "picker"; switchTab("flash"); }],
  ["smart",        () => { state.smartScreen = "home"; switchTab("smart"); }],
  ["stats",        () => { state.statsView = { view: "overview", subjectId: null, chapterId: null }; switchTab("stats"); }],
  ["progression",  () => { switchTab("progress"); }],
  ["planning",     () => { switchTab("planning"); }],
  ["examens",      () => { switchTab("exams"); }],
  ["ia",           () => { switchTab("ai"); }],
  ["profil",       () => { switchTab("account"); }],
  ["parametres",   () => { switchTab("settings"); }],
];

const SEED = () => {
  const now = Date.now(), subjId = "t-subj";
  state.userSubjects = [{ id: subjId, name: "Analyse financière", semesterId: (SEMESTERS[0]||{}).id, icon: "", color: "#E31C3D" }];
  state.userChapters = [{
    id: "t-ch1", subjectId: subjId, num: 1, title: "Bilan et compte de résultat",
    desc: "Lire et interpréter les états financiers.",
    content: "Le bilan est une photographie du patrimoine à une date donnée.",
    aiQuiz: [{ q: "Que représente le bilan ?", opts: ["Le patrimoine","Le résultat","Les flux","Les commandes"], correct: 0, exp: "Une photographie." }],
    aiFlashcards: [{ front: "Actif circulant ?", back: "Consommé dans le cycle." }],
    aiReviewQuestions: [{ q: "Pourquoi équilibré ?", a: "Par construction." }],
    createdAt: now - 3*86400000, updatedAt: now - 86400000, markedReviewed: false }];
  saveUserSubjects(); saveUserChapters();
  state.dash.recentChapters = [{ chapterId: "t-ch1", ts: now - 86400000 }];
  state.dash.recentActivity = [{ type: "quiz", label: "Bilan", pct: 72, total: 10,
                                 ts: new Date(now-3600000).toISOString(), date: dateKey(new Date(now-3600000)) }];
  state.dash.timeSpentSeconds = 4230;
  const at = (h,m)=>{const d=new Date(now); d.setHours(h,m||0,0,0); return d.getTime();};
  state.planning.events = [
    { id:"ev-current", summary:"Analyse financière", start: now-1800000, end: now+1800000, location:"A201" },
    { id:"ev-next", summary:"Droit des affaires", start: at(16), end: at(17,30), location:"C012" }];
};

/* Ce qu'on mesure sur une page. */
const PROBE = () => {
  const view = document.getElementById("content");
  const px = v => Math.round(parseFloat(v) * 10) / 10;
  const r = { sizes: [], weights: [], radii: [], shadows: [], colors: [],
              gaps: [], nested: [], dead: [], headings: [], tight: [] };

  for (const el of view.querySelectorAll("*")) {
    if (el.offsetParent === null) continue;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());

    if (hasText) {
      r.sizes.push(px(cs.fontSize));
      r.weights.push(cs.fontWeight);
      r.colors.push(cs.color);
      const lh = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
      if (lh && lh < 1.25 && el.textContent.trim().length > 80) {
        r.tight.push(el.className.toString().slice(0, 30) + " (" + Math.round(lh*100)/100 + ")");
      }
    }
    if (!/%/.test(cs.borderTopLeftRadius) && px(cs.borderTopLeftRadius) > 0) r.radii.push(px(cs.borderTopLeftRadius));
    if (cs.boxShadow !== "none") r.shadows.push(cs.boxShadow.slice(0, 48));
    if (/^H[1-6]$/.test(el.tagName)
        && !/\b(panel-label|section-head-label|eyebrow)\b/.test(el.className.toString())) {
      r.headings.push([el.tagName, px(cs.fontSize)]);
    }

    /* Une boîte encadrée directement dans une boîte encadrée. Une bordure
       transparente n'est pas une boîte ; un contrôle (bouton, champ, chip)
       est bordé par nature — ce n'est pas un emboîtement de surfaces. */
    const boxed = e => {
      const c = getComputedStyle(e);
      /* Une boîte est fermée sur ses quatre côtés. Une bordure sur un seul
         côté est un FILET de séparation — c'est le geste du système, pas un
         emboîtement. */
      const sides = ["Top", "Right", "Bottom", "Left"]
        .filter(sd => parseFloat(c["border" + sd + "Width"]) > 0 && c["border" + sd + "Style"] === "solid");
      if (sides.length < 4) return false;
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(c.borderTopColor)) return false;
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.tagName)) return false;
      if (/\b(btn|chip|input|select|textarea|badge|status|segmented|seal|toggle|mark)\b/
            .test(e.className.toString())) return false;
      return true;
    };
    if (boxed(el) && box.height > 40) {
      for (let n = el.parentElement; n && n !== view; n = n.parentElement) {
        if (boxed(n)) {
          r.nested.push(el.className.toString().slice(0,26) + " dans " + n.className.toString().slice(0,22));
          break;
        }
      }
    }
    /* Vide mort : le padding bas d'un panneau plus la marge de son dernier
       enfant. Au-delà de 48px, c'est un trou, pas de la respiration. */
    if (/\b(card|dash-section|block--feature|fiche-card)\b/.test(el.className.toString())) {
      const pd = el.parentElement ? getComputedStyle(el.parentElement).display : "";
      if (pd === "grid" || pd === "flex") continue;
      const kids = [...el.children].filter(k => k.offsetParent !== null);
      const last = kids[kids.length - 1];
      if (last) {
        const gap = Math.round(box.bottom - last.getBoundingClientRect().bottom);
        if (gap > 48) r.dead.push(el.className.toString().slice(0,26) + " : " + gap + "px");
      }
    }
  }

  /* Écarts verticaux entre blocs de premier niveau. */
  const tops = [...view.children].filter(e => e.offsetParent !== null);
  for (let i = 1; i < tops.length; i++) {
    const a = tops[i-1].getBoundingClientRect(), b = tops[i].getBoundingClientRect();
    const g = Math.round(b.top - a.bottom);
    if (g > 0) r.gaps.push(g);
  }
  return r;
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  for (const vp of [{ n: "bureau", w: 1440, h: 1000 }, { n: "mobile", w: 375, h: 812 }]) {
    current = vp.n;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    const at = new Date(); at.setHours(14, 0, 0, 0);
    await page.clock.install({ time: at });
    await page.goto(APP);
    await page.waitForTimeout(1600);
    await page.evaluate(SEED);

    const all = { sizes: [], weights: [], radii: [], shadows: [], colors: [],
                  gaps: [], nested: [], dead: [], headings: [], tight: [] };
    for (const [name, go] of PAGES) {
      await page.evaluate(go);
      await page.waitForTimeout(450);
      const r = await page.evaluate(PROBE);
      for (const k of Object.keys(all)) all[k] = all[k].concat(r[k].map(x =>
        (k === "nested" || k === "dead" || k === "tight") ? `${name} · ${x}` : x));
    }
    const uniq = a => [...new Set(a)].sort((x, y) => (typeof x === "number" ? x - y : String(x).localeCompare(String(y))));

    /* ── ÉCHELLE TYPOGRAPHIQUE ─────────────────────────────────────────── */
    const SCALE = [11, 13, 14, 16, 20, 30, 40];
    const sizes = uniq(all.sizes);
    eq(`[${vp.n}] toutes les tailles de texte sont sur l'échelle`,
       sizes.filter(s => !SCALE.includes(s)), []);
    check(`[${vp.n}] l'échelle ne s'est pas étalée (${sizes.length} tailles)`,
      sizes.length <= SCALE.length, sizes);

    /* ── GRAISSES : le système plafonne à 600 ──────────────────────────── */
    eq(`[${vp.n}] aucune graisse au-dessus du plafond du système`,
       uniq(all.weights).filter(w => !["400", "500", "600"].includes(w)), []);

    /* ── FORMES ────────────────────────────────────────────────────────── */
    const ALLOWED_RADII = [2, 8, 12, 16, 999];
    eq(`[${vp.n}] aucun rayon hors système`,
       uniq(all.radii).filter(x => !ALLOWED_RADII.includes(x) && x < 100), []);
    check(`[${vp.n}] une seule ombre de surface`,
      uniq(all.shadows).length <= 2, uniq(all.shadows));

    /* ── COULEURS DE TEXTE : uniquement la palette ─────────────────────── */
    const PALETTE = [
      "rgb(22, 22, 26)", "rgb(74, 74, 82)", "rgb(138, 138, 147)", "rgb(255, 255, 255)",
      "rgb(227, 28, 61)", "rgb(196, 22, 47)", "rgb(180, 21, 47)",
      "rgb(31, 107, 77)", "rgb(143, 92, 0)", "rgb(179, 38, 30)", "rgb(44, 95, 168)",
      "rgb(214, 210, 203)", "rgb(232, 229, 224)", "rgb(92, 88, 80)", "rgb(42, 39, 33)",
    ];
    eq(`[${vp.n}] aucune couleur de texte hors palette`,
       uniq(all.colors).filter(c => !PALETTE.includes(c)), []);

    /* ── GRILLE DE 8 ───────────────────────────────────────────────────── */
    const GRID = [4, 8, 12, 16, 24, 32, 48, 64];
    const offGrid = uniq(all.gaps).filter(g => !GRID.includes(g) && g <= 64);
    eq(`[${vp.n}] les écarts entre blocs sont sur la grille`, offGrid, []);

    /* ── BOÎTES ET VIDE ────────────────────────────────────────────────── */
    eq(`[${vp.n}] aucune boîte encadrée dans une boîte encadrée`, uniq(all.nested), []);
    eq(`[${vp.n}] aucun vide mort en bas d'un panneau`, uniq(all.dead), []);
    eq(`[${vp.n}] aucun texte à l'interligne trop serré`, uniq(all.tight), []);

    /* ── HIÉRARCHIE DES TITRES ─────────────────────────────────────────── */
    const byTag = {};
    all.headings.forEach(([tag, size]) => { (byTag[tag] = byTag[tag] || new Set()).add(size); });
    const maxOf = t => byTag[t] ? Math.max(...byTag[t]) : 0;
    check(`[${vp.n}] h1 domine h2`, maxOf("H1") > maxOf("H2"), byTag);
    check(`[${vp.n}] h2 domine ou égale h3`, maxOf("H2") >= maxOf("H3"), byTag);
    /* Les libellés de panneau en chasse fixe sont exclus : ils sont des
       titres pour le lecteur d'écran, pas des titres visuels. */
    check(`[${vp.n}] aucun titre visuel sous le corps de texte`,
      all.headings.length > 0 && Math.min(...all.headings.map(([, z]) => z)) >= 14,
      all.headings.filter(([, z]) => z < 14));

    eq(`[${vp.n}] aucune erreur JavaScript`, errors, []);
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
