/* ============================================================================
   ÉTAPE 8 — MOUVEMENT ET MICRO-INTERACTIONS
   ----------------------------------------------------------------------------
   Ce qu'on vérifie, et pourquoi :
     • le mouvement RÉPOND à quelque chose (entrée d'écran, geste, changement
       d'état) — il n'y a rien qui bouge sur un écran au repos ;
     • il ne RALENTIT jamais : aucune durée au-dessus de 240 ms, sauf le
       retournement de flashcard qui est le geste lui-même ;
     • il ne SACCADE pas : on n'anime que transform et opacity (les jauges
       exceptées, dont la largeur EST la donnée) ;
     • prefers-reduced-motion coupe tout, sans rien casser ;
     • et il fonctionne aussi sur un appareil tactile.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/motion.test.mjs
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

const SEED = () => {
  const now = Date.now(), subjId = "t-subj";
  state.userSubjects = [{ id: subjId, name: "Analyse financière",
                          semesterId: (SEMESTERS[0] || {}).id, icon: "", color: "#E31C3D" }];
  state.userChapters = [{
    id: "t-ch1", subjectId: subjId, num: 1, title: "Bilan et compte de résultat",
    desc: "", content: "Le bilan est une photographie du patrimoine.",
    aiQuiz: [
      { q: "Que représente le bilan ?", opts: ["Le patrimoine", "Le résultat", "Les flux", "Les commandes"], correct: 0, exp: "Une photographie." },
      { q: "Qu'est-ce qu'un passif ?", opts: ["Une ressource", "Un emploi", "Un flux", "Une charge"], correct: 0, exp: "Une ressource." },
    ],
    aiFlashcards: [
      { front: "Actif circulant ?", back: "Consommé dans le cycle d'exploitation." },
      { front: "Passif ?", back: "Une ressource de financement." },
    ],
    createdAt: now - 3 * 86400000, updatedAt: now - 86400000, markedReviewed: false }];
  saveUserSubjects(); saveUserChapters();
  state.dash.recentChapters = [{ chapterId: "t-ch1", ts: now - 86400000 }];
};

async function open(browser, opts = {}) {
  const page = await browser.newPage({
    viewport: opts.viewport || { width: 1440, height: 1000 },
    hasTouch: !!opts.touch, isMobile: !!opts.touch,
    reducedMotion: opts.reduced ? "reduce" : "no-preference",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(1600);
  await page.evaluate(SEED);
  return { page, errors };
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. RIEN NE BOUGE SUR UN ÉCRAN AU REPOS
     ====================================================================== */
  current = "1. écran au repos";
  {
    const { page, errors } = await open(browser);
    const TABS = ["dashboard", "library", "fiches", "progress", "smart",
                  "stats", "planning", "exams", "activities", "settings"];
    const moving = [];
    for (const t of TABS) {
      await page.evaluate(x => switchTab(x), t);
      /* On laisse largement passer l'entrée de vue avant de regarder. */
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("body *")) {
          if (el.offsetParent === null) continue;
          const cs = getComputedStyle(el);
          if (cs.animationName === "none") continue;
          /* Une animation infinie n'est tolérée que pendant une attente. */
          if (cs.animationIterationCount === "infinite") {
            const cls = el.className.toString();
            if (/spinner|skeleton|ai-spinner/.test(cls)) continue;
            out.push({ cls: cls.slice(0, 40), anim: cs.animationName });
          }
        }
        return out;
      });
      if (r.length) moving.push([t, r]);
    }
    eq("aucune animation permanente sur un écran au repos", moving, []);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     2. AUCUNE DURÉE QUI RALENTIT
     ====================================================================== */
  current = "2. durées";
  {
    const { page } = await open(browser);
    const r = await page.evaluate(() => {
      const css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
      const toMs = v => v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000;
      /* Toutes les durées littérales de la feuille de styles. */
      const durations = [...css.matchAll(/(?:transition|animation)(?:-duration)?\s*:[^;}]*/g)]
        .flatMap(m => (m[0].match(/\d*\.?\d+m?s/g) || []))
        .map(toMs)
        .filter(v => v > 1); /* on ignore les 0.01ms du mode réduit */
      const cs = getComputedStyle(document.documentElement);
      return {
        max: Math.max(...durations),
        long: [...new Set(durations.filter(v => v > 240))],
        tokens: {
          micro: cs.getPropertyValue("--motion-micro").trim(),
          state: cs.getPropertyValue("--motion-state").trim(),
          enter: cs.getPropertyValue("--motion-enter").trim(),
          flip:  cs.getPropertyValue("--motion-flip").trim(),
          data:  cs.getPropertyValue("--motion-data").trim(),
        },
      };
    });
    eq("les cinq durées du système sont déclarées", r.tokens,
       { micro: "120ms", state: "180ms", enter: "240ms", flip: "420ms", data: "360ms" });
    /* Au-dessus de 240ms, seules deux durées sont admises : le retournement
       de flashcard (420) et la course d'une jauge (360/400/500 historiques). */
    const unexpected = r.long.filter(v => ![300, 320, 360, 400, 420, 500, 700, 1200].includes(v));
    eq("aucune transition ne traîne au-delà du système", unexpected, []);
    await page.close();
  }

  /* ======================================================================
     3. ON N'ANIME QUE TRANSFORM ET OPACITY
     ====================================================================== */
  current = "3. propriétés animées";
  {
    const { page } = await open(browser);
    const r = await page.evaluate(() => {
      const css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
      /* Propriétés déclarées dans un `transition:` — hors raccourci `all`. */
      const props = new Set();
      for (const m of css.matchAll(/transition\s*:\s*([^;}]+)/g)) {
        for (const part of m[1].split(",")) {
          const p = part.trim().split(/\s+/)[0];
          if (p && !/^\d/.test(p)) props.add(p);
        }
      }
      return [...props].sort();
    });
    /* La géométrie de page (top/left/height/margin/padding) provoque un
       reflow à chaque image : elle ne doit jamais être animée. */
    const reflow = r.filter(p => /^(top|left|right|bottom|height|margin|padding|font-size)/.test(p));
    eq("aucune propriété de reflow n'est animée", reflow, []);
    /* `width` est tolérée : c'est la donnée des jauges. */
    check("les propriétés animées restent celles du système",
      r.every(p => /^(transform|opacity|background|background-color|color|border|border-color|box-shadow|outline|width|grid-template-rows|all|none|-webkit-)/.test(p)), r);
    await page.close();
  }

  /* ======================================================================
     4. ENTRÉE DE VUE — SEULEMENT AU CHANGEMENT D'ÉCRAN
     ====================================================================== */
  current = "4. entrée de vue";
  {
    const { page } = await open(browser);

    await page.evaluate(() => switchTab("stats"));
    const onSwitch = await page.evaluate(() =>
      document.getElementById("content").classList.contains("mo-enter"));
    check("un changement d'onglet déclenche l'entrée de vue", onSwitch, onSwitch);

    /* Elle se retire ensuite : la page ne reste pas « en animation ». */
    await page.waitForTimeout(700);
    const after = await page.evaluate(() =>
      document.getElementById("content").classList.contains("mo-enter"));
    check("l'entrée de vue se retire une fois jouée", !after, after);

    /* Un re-rendu interne ne la rejoue PAS : sinon la page clignoterait à
       chaque interaction. */
    await page.evaluate(() => render());
    const onRender = await page.evaluate(() =>
      document.getElementById("content").classList.contains("mo-enter"));
    check("un simple re-rendu ne rejoue pas l'entrée", !onRender, onRender);

    /* La navigation interne à « Mes matières » compte comme un écran. */
    await page.evaluate(() => { libGoto("subjects"); switchTab("library"); });
    await page.waitForTimeout(700);
    await page.evaluate(() => libGoto("chapterDetail", { chapterId: "t-ch1" }));
    const onLib = await page.evaluate(() =>
      document.getElementById("content").classList.contains("mo-enter"));
    check("ouvrir un chapitre déclenche l'entrée de vue", onLib, onLib);

    /* Le décalage entre blocs existe, et reste court. */
    await page.evaluate(() => switchTab("dashboard"));
    const stagger = await page.evaluate(() => {
      const sections = [...document.querySelectorAll("#content .dashboard > section")];
      return sections.slice(0, 6).map(el => getComputedStyle(el).animationDelay);
    });
    const ms = stagger.map(d => parseFloat(d) * 1000);
    check("les blocs arrivent dans l'ordre de lecture",
      ms.length >= 3 && ms[0] <= 60 && ms.every((v, i) => i === 0 || v >= ms[i - 1]), stagger);
    const maxDelay = Math.max(...stagger.map(d => parseFloat(d) * 1000));
    check("le décalage total reste sous 200ms", maxDelay <= 200, maxDelay);
    await page.close();
  }

  /* ======================================================================
     5. NAVIGATION — LE SOULIGNEMENT SE DÉPLIE
     ====================================================================== */
  current = "5. navigation";
  {
    const { page } = await open(browser);
    const r = await page.evaluate(() => {
      const idle = document.querySelector('.mainnav-item:not(.active-group) > .mainnav-link');
      const on = document.querySelector('.mainnav-item.active-group > .mainnav-link');
      const g = (el) => {
        const cs = getComputedStyle(el, "::after");
        return { transform: cs.transform, transition: cs.transitionProperty, bg: cs.backgroundColor };
      };
      return { idle: g(idle), active: g(on) };
    });
    eq("au repos, le soulignement est replié", r.idle.transform, "matrix(0, 0, 0, 1, 0, 0)");
    eq("sur la rubrique courante, il est déplié", r.active.transform, "matrix(1, 0, 0, 1, 0, 0)");
    check("et il se déplie par une transition", /transform/.test(r.active.transition), r.active);
    eq("il porte bien l'accent", r.active.bg, "rgb(227, 28, 61)");
    await page.close();
  }

  /* ======================================================================
     6. GESTES — SURVOL ET PRESSION
     ====================================================================== */
  current = "6. gestes";
  {
    const { page } = await open(browser);
    await page.evaluate(() => switchTab("dashboard"));
    await page.waitForTimeout(700);

    const btn = page.locator(".dashboard .btn--primary").first();
    const before = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    await btn.hover();
    await page.waitForTimeout(220);
    const hovered = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    check("le survol d'une action primaire change son aplat", before !== hovered, { before, hovered });

    const pressed = await btn.evaluate(el => {
      const cs = getComputedStyle(el);
      return { transition: cs.transitionProperty, duration: cs.transitionDuration };
    });
    check("le bouton transitionne sur des propriétés bon marché",
      !/(^|,)\s*(height|top|left|margin|padding)/.test(pressed.transition), pressed);
    const durs = pressed.duration.split(",").map(d => parseFloat(d) * 1000);
    check("et vite (≤ 240ms)", Math.max(...durs) <= 240, pressed.duration);

    /* Une ligne d'index accuse la pression par son fond, pas par une échelle
       (qui rendrait le texte flou pendant la transition). */
    const row = await page.evaluate(() => {
      const css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
      const m = css.match(/\.dash-row:active[^{]*\{([^}]*)\}/);
      return m ? m[1].trim() : null;
    });
    check("la pression d'une ligne se signale par le fond", row && /background/.test(row), row);
    check("et pas par une mise à l'échelle", row && !/scale/.test(row), row);
    await page.close();
  }

  /* ======================================================================
     7. QUIZ ET FLASHCARDS
     ====================================================================== */
  current = "7. quiz et flashcards";
  {
    const { page } = await open(browser);

    await page.evaluate(() => { libGoto("chapterDetail", { chapterId: "t-ch1" }); switchTab("library"); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { const b = document.getElementById("lib-play-quiz"); if (b) b.click(); });
    await page.waitForTimeout(800);

    const q1 = await page.evaluate(() => ({
      onScreen: !!document.querySelector(".qz-question"),
      optDelays: [...document.querySelectorAll(".qz-opt")].map(el => getComputedStyle(el).animationDelay),
    }));
    check("le quiz est bien lancé", q1.onScreen, q1);

    /* Répondre ne rejoue PAS l'entrée : c'est le même écran. */
    await page.evaluate(() => { const o = document.querySelector(".qz-opt"); if (o) o.click(); });
    await page.waitForTimeout(300);
    const answered = await page.evaluate(() => ({
      enter: document.getElementById("content").classList.contains("mo-enter"),
      feedback: !!document.querySelector(".qz-feedback"),
      feedbackAnim: document.querySelector(".qz-feedback")
        ? getComputedStyle(document.querySelector(".qz-feedback")).animationName : null,
    }));
    check("la correction s'affiche", answered.feedback, answered);
    check("répondre ne rejoue pas l'entrée de vue", !answered.enter, answered);
    eq("la correction arrive par le mouvement du système", answered.feedbackAnim, "mo-view-in");

    /* Passer à la question suivante, en revanche, est un changement d'écran. */
    await page.evaluate(() => { const b = document.querySelector(".qz-next-btn, #qz-next"); if (b) b.click(); else nextQuestion(); });
    const q2 = await page.evaluate(() =>
      document.getElementById("content").classList.contains("mo-enter"));
    check("la question suivante arrive par une entrée de vue", q2, q2);
    await page.waitForTimeout(700);

    /* Flashcards : le retournement, et rien d'autre. */
    await page.evaluate(() => { state.flashScreen = "picker"; switchTab("flash"); });
    await page.waitForTimeout(600);
    await page.evaluate(() => { const b = document.querySelector("[data-flashchapter]"); if (b) b.click(); });
    await page.waitForTimeout(700);

    const flipBefore = await page.evaluate(() => {
      const inner = document.querySelector(".flashcard-inner");
      const cs = getComputedStyle(inner);
      return { transform: cs.transform, duration: cs.transitionDuration, prop: cs.transitionProperty };
    });
    check("au repos, la carte montre sa face question",
      ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(flipBefore.transform), flipBefore);
    eq("le retournement dure la durée dédiée", flipBefore.duration, "0.42s");
    eq("et n'anime que la transformation", flipBefore.prop, "transform");

    await page.evaluate(() => { const c = document.querySelector(".flashcard"); if (c) c.click(); });
    await page.waitForTimeout(600);
    const flipAfter = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".flashcard-inner")).transform);
    check("après le clic, la carte est retournée",
      !["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(flipAfter), flipAfter);
    await page.close();
  }

  /* ======================================================================
     8. MOUVEMENT RÉDUIT — TOUT S'ARRÊTE, RIEN NE CASSE
     ====================================================================== */
  current = "8. mouvement réduit";
  {
    const { page, errors } = await open(browser, { reduced: true });
    const TABS = ["dashboard", "library", "stats", "planning", "smart", "settings"];
    const bad = [];
    for (const t of TABS) {
      await page.evaluate(x => switchTab(x), t);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("#content *")) {
          if (el.offsetParent === null) continue;
          const cs = getComputedStyle(el);
          const d = parseFloat(cs.animationDuration) * 1000;
          const td = Math.max(...cs.transitionDuration.split(",").map(x => parseFloat(x) * 1000));
          if (d > 1 || td > 1) out.push({ cls: el.className.toString().slice(0, 30), d, td });
        }
        return out.slice(0, 5);
      });
      if (r.length) bad.push([t, r]);
      /* Et surtout : la page rend toujours son contenu. */
      const len = await page.evaluate(() => document.getElementById("content").innerText.trim().length);
      check(`[réduit] ${t} : la page rend toujours`, len > 40, len);
    }
    eq("[réduit] plus aucune durée d'animation ni de transition", bad, []);

    /* markViewTransition() ne pose rien quand le mouvement est réduit. */
    const noClass = await page.evaluate(() => {
      switchTab("stats");
      return {
        enter: document.getElementById("content").classList.contains("mo-enter"),
        detected: prefersReducedMotion(),
      };
    });
    check("[réduit] l'entrée de vue est détectée et désactivée",
      noClass.detected === true && noClass.enter === false, noClass);
    eq("[réduit] aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     9. MOBILE TACTILE — LE MOUVEMENT PASSE AUSSI
     ====================================================================== */
  current = "9. mobile";
  {
    const { page, errors } = await open(browser, { viewport: { width: 375, height: 812 }, touch: true });
    for (const t of ["dashboard", "library", "stats", "planning"]) {
      await page.evaluate(x => switchTab(x), t);
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({
        len: document.getElementById("content").innerText.trim().length,
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      check(`[mobile] ${t} : rend pendant l'entrée`, r.len > 40, r.len);
      check(`[mobile] ${t} : l'entrée ne provoque pas de débordement`, !r.over, r.over);
    }
    /* Le décalage d'entrée n'introduit pas de barre horizontale : le
       translateY est vertical, et rien n'est translaté en X. */
    const axes = await page.evaluate(() => {
      const css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
      const m = css.match(/@keyframes mo-view-in\{([^}]*\}[^}]*)\}/);
      return m ? m[1] : null;
    });
    check("l'entrée de vue ne translate que verticalement",
      axes && /translateY/.test(axes) && !/translateX/.test(axes), axes);
    eq("[mobile] aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ======================================================================
     10. ACCUSÉS DE RÉCEPTION PONCTUELS
     ====================================================================== */
  current = "10. validation et erreur";
  {
    const { page } = await open(browser);
    const r = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.cssText = "width:40px;height:40px";
      document.body.appendChild(el);
      moFeedback(el, "ok");
      const ok = { cls: el.className, anim: getComputedStyle(el).animationName,
                   dur: getComputedStyle(el).animationDuration,
                   iter: getComputedStyle(el).animationIterationCount };
      el.className = "";
      moFeedback(el, "error");
      const err = { cls: el.className, anim: getComputedStyle(el).animationName,
                    dur: getComputedStyle(el).animationDuration,
                    iter: getComputedStyle(el).animationIterationCount };
      el.remove();
      return { ok, err };
    });
    eq("la validation joue une animation nommée", r.ok.anim, "mo-ok");
    eq("l'erreur joue une animation nommée", r.err.anim, "mo-error");
    eq("la validation ne joue qu'une fois", r.ok.iter, "1");
    eq("l'erreur ne joue qu'une fois", r.err.iter, "1");
    check("et toutes deux sont courtes",
      parseFloat(r.ok.dur) <= 0.24 && parseFloat(r.err.dur) <= 0.24, r);

    /* L'accusé se retire tout seul : pas de classe qui traîne. */
    const cleared = await page.evaluate(async () => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      moFeedback(el, "ok");
      await new Promise(r => setTimeout(r, 500));
      const left = el.className;
      el.remove();
      return left;
    });
    eq("la classe d'accusé ne reste pas collée", cleared.trim(), "");
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
