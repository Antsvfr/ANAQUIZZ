/* ============================================================================
   REV-EM — vérification du design system
   ----------------------------------------------------------------------------
   Prérequis : dépôt servi sur http://localhost:9109
   Exécution  : NODE_PATH=/opt/node22/lib/node_modules node tests/design-system.test.mjs

   Ce test ne juge pas du goût. Il vérifie ce qui est vérifiable :
     • les tokens existent, résolvent, et les anciens noms redirigent bien
       vers les nouveaux (aucun système parallèle) ;
     • les contrastes respectent WCAG AA sur les paires réellement employées ;
     • le focus clavier est visible sur tous les contrôles ;
     • les cibles tactiles atteignent 44px en pointeur grossier ;
     • aucun débordement horizontal à 375 / 768 / 1440 ;
     • les onglets rendent toujours leur contenu (non-régression).
   ============================================================================ */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const results = [];
let current = "";
function check(label, ok, detail) { results.push({ scenario: current, label, ok: !!ok, detail: detail || "" }); }
function eq(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(label, ok, ok ? "" : "attendu " + JSON.stringify(b) + ", obtenu " + JSON.stringify(a));
}

/* ---- contraste WCAG ---- */
function srgb(c) { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map(x => x + x).join("") : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const TABS = ["dashboard", "library", "fiches", "progress", "smart", "stats", "planning", "ai", "exams"];

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  /* ======================================================================
     1. TOKENS — source unique, alias redirigés
     ====================================================================== */
  current = "1. tokens";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1500);

    const t = await page.evaluate(() => {
      const g = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const names = [
        "background","surface","surface-sunken","text-primary","text-secondary","text-muted",
        "border","border-strong","accent","accent-hover","accent-active","success","warning","error","info",
        "text-display","text-h1","text-h2","text-h3","text-body","text-small","text-metadata","text-label",
        "space-2xs","space-xs","space-sm","space-md","space-lg","space-xl","space-2xl","space-3xl",
        "radius-sm","radius-md","radius-lg","radius-pill",
        "shadow-subtle","shadow-elevated","shadow-modal",
        "motion-micro","motion-state","motion-enter","ease-enter","ease-exit",
        "font-display","font-ui","font-data","width-read","width-work",
      ];
      const out = {};
      names.forEach(n => out[n] = g("--" + n));
      const aliases = {
        "--ink": "--text-primary", "--muted": "--text-muted", "--bg": "--background",
        "--red": "--accent", "--red-dark": "--accent-active", "--green": "--success",
        "--amber": "--warning", "--blue": "--info", "--text-sm": "--text-small",
        "--text-xs": "--text-metadata", "--text-2xs": "--text-label",
        "--shadow-md": "--shadow-elevated", "--font-main": "--font-ui", "--font-heading": "--font-display",
      };
      const aliasOk = {};
      Object.entries(aliases).forEach(([a, c]) => { aliasOk[a] = g(a) === g(c) && g(a) !== ""; });
      return { out, aliasOk };
    });

    const missing = Object.entries(t.out).filter(([, v]) => !v).map(([k]) => k);
    eq(`les ${Object.keys(t.out).length} tokens canoniques résolvent tous`, missing, []);

    const brokenAlias = Object.entries(t.aliasOk).filter(([, v]) => !v).map(([k]) => k);
    eq("chaque alias historique redirige vers son token canonique", brokenAlias, []);
    check("aucun système parallèle : les anciens noms n'ont pas de valeur propre",
      brokenAlias.length === 0, brokenAlias.join(", "));

    eq("échelle typographique appliquée (corps)", t.out["text-body"], "16px");
    eq("échelle typographique appliquée (titre de page)", t.out["text-h1"], "30px");
    eq("grille d'espacement en base 8", [t.out["space-xs"], t.out["space-md"], t.out["space-lg"]], ["8px", "16px", "24px"]);
    eq("trois rayons + pastille", [t.out["radius-sm"], t.out["radius-md"], t.out["radius-lg"], t.out["radius-pill"]],
      ["8px", "12px", "16px", "999px"]);
    check("trois familles déclarées, à rôle exclusif",
      /Newsreader/.test(t.out["font-display"]) && /Public Sans/.test(t.out["font-ui"]) && /Plex Mono/.test(t.out["font-data"]));

    await page.close();
  }

  /* ======================================================================
     2. CONTRASTE — WCAG AA sur les paires réellement employées
     ====================================================================== */
  current = "2. contraste";
  {
    /* Les couleurs sont LUES dans la page, jamais recopiées ici : un test qui
       recopie les valeurs finit par vérifier sa propre copie. */
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1200);
    const C = await page.evaluate(() => {
      const g = n => getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim();
      return {
        background: g("background"), surface: g("surface"), sunken: g("surface-sunken"),
        primary: g("text-primary"), secondary: g("text-secondary"), muted: g("text-muted"),
        accent: g("accent"), accentHover: g("accent-hover"), accentActive: g("accent-active"),
        success: g("success"), successWash: g("success-wash"),
        warning: g("warning"), warningWash: g("warning-wash"),
        error: g("error"), errorWash: g("error-wash"),
        info: g("info"), infoWash: g("info-wash"),
        white: g("text-on-accent"),
      };
    });
    await page.close();

    const AA = 4.5, AA_LARGE = 3.0, UI = 3.0;
    const pairs = [
      ["texte principal sur ivoire", C.primary, C.background, AA],
      ["texte principal sur surface", C.primary, C.surface, AA],
      ["texte secondaire sur ivoire", C.secondary, C.background, AA],
      ["texte secondaire sur surface", C.secondary, C.surface, AA],
      ["métadonnée sur ivoire", C.muted, C.background, AA_LARGE],
      ["blanc sur bouton primaire", C.white, C.accent, AA_LARGE],
      ["blanc sur primaire survolé", C.white, C.accentHover, AA],
      ["blanc sur primaire pressé", C.white, C.accentActive, AA],
      ["succès sur son aplat", C.success, C.successWash, AA],
      ["avertissement sur son aplat", C.warning, C.warningWash, AA],
      ["erreur sur son aplat", C.error, C.errorWash, AA],
      ["information sur son aplat", C.info, C.infoWash, AA],
      ["anneau de focus sur ivoire", C.accent, C.background, UI],
      ["anneau de focus sur surface", C.accent, C.surface, UI],
      ["texte sur aplat creusé", C.primary, C.sunken, AA],
    ];
    for (const [label, fg, bg, min] of pairs) {
      const r = ratio(fg, bg);
      check(`${label} — ${r.toFixed(2)}:1 (min ${min})`, r >= min, `${r.toFixed(2)} < ${min}`);
    }
    /* Le rouge passe l'AA sur fond clair : ce n'est donc pas le contraste qui le
       limite, c'est une règle de DIRECTION — il reste réservé à l'action, à
       l'onglet actif et à la marque. */
    const redOnWhite = ratio(C.accent, C.surface);
    check(`le rouge reste lisible là où il sert de texte (${redOnWhite.toFixed(2)}:1)`, redOnWhite >= AA, "");
  }

  /* ======================================================================
     3. FOCUS CLAVIER
     ====================================================================== */
  current = "3. focus clavier";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1500);

    const first = await page.evaluate(async () => {
      document.body.focus();
      return true;
    });
    await page.keyboard.press("Tab");
    const skip = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { cls: el.className, text: (el.textContent || "").trim(), left: cs.left, outline: cs.outlineWidth };
    });
    check("la première tabulation atteint le lien d'évitement", /skip-link/.test(skip.cls), skip.cls + " / " + skip.text);
    check("le lien d'évitement devient visible au focus", skip.left !== "-9999px", skip.left);

    const rings = await page.evaluate(() => {
      const out = [];
      const sel = [".btn", ".btn-text", ".mainnav-link", ".profile-chip", "input", "select"];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (!el) { out.push({ s, found: false }); continue; }
        el.focus();
        const cs = getComputedStyle(el);
        out.push({ s, found: true, w: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, offset: cs.outlineOffset });
      }
      return out;
    });
    for (const r of rings) {
      if (!r.found) continue;
      const visible = parseFloat(r.w) >= 2 && r.style !== "none";
      check(`${r.s} — anneau de focus visible (${r.w} ${r.style})`, visible, JSON.stringify(r));
    }
    await page.close();
  }

  /* ======================================================================
     4. CIBLES TACTILES
     ====================================================================== */
  current = "4. cibles tactiles";
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1500);
    const sizes = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll(".btn, .hamburger-btn").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0) out.push({ cls: el.className.slice(0, 28), h: Math.round(r.height) });
      });
      return out;
    });
    const small = sizes.filter(s => s.h < 44);
    check(`toutes les cibles tactiles atteignent 44px (${sizes.length} contrôles mesurés)`,
      small.length === 0, small.slice(0, 4).map(s => s.cls + ":" + s.h).join(", "));
    await page.close();
  }

  /* ======================================================================
     5. RESPONSIVE — aucun débordement horizontal
     ====================================================================== */
  current = "5. responsive";
  {
    for (const [w, h, name] of [[375, 812, "mobile"], [768, 1024, "tablette"], [1440, 900, "bureau"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto("http://localhost:9109/index.html");
      await page.waitForTimeout(1200);

      const doc = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      check(`[${name}] aucun débordement horizontal de la page (${doc.scroll} ≤ ${doc.client})`,
        doc.scroll <= doc.client + 1, `${doc.scroll} > ${doc.client}`);

      const bar = await page.evaluate(() => {
        const el = document.querySelector(".topbar-inner");
        const nav = document.querySelector(".mainnav");
        const ham = document.querySelector(".hamburger-btn");
        return {
          overflow: el ? el.scrollWidth > el.clientWidth + 1 : null,
          navVisible: nav ? getComputedStyle(nav).display !== "none" : null,
          hamVisible: ham ? getComputedStyle(ham).display !== "none" : null,
        };
      });
      check(`[${name}] l'en-tête ne déborde pas`, bar.overflow === false, JSON.stringify(bar));
      if (name === "tablette") {
        check("[tablette] la navigation bascule en feuille (correction du débordement à 768px)",
          bar.navVisible === false && bar.hamVisible === true, JSON.stringify(bar));
      }
      if (name === "bureau") {
        check("[bureau] la navigation reste horizontale", bar.navVisible === true, JSON.stringify(bar));
      }

      for (const tab of TABS) {
        await page.evaluate(t => { try { switchTab(t); } catch (e) {} }, tab);
        await page.waitForTimeout(140);
        const over = await page.evaluate(() => {
          const el = document.getElementById("content");
          return el ? el.scrollWidth > el.clientWidth + 2 : false;
        });
        check(`[${name}] onglet « ${tab} » sans débordement`, !over, "");
      }
      await page.close();
    }
  }

  /* ======================================================================
     6. NON-RÉGRESSION
     ====================================================================== */
  current = "6. non-régression";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1600);

    for (const tab of TABS) {
      await page.evaluate(t => switchTab(t), tab);
      await page.waitForTimeout(150);
      const len = await page.evaluate(() => document.getElementById("content").textContent.trim().length);
      check(`onglet « ${tab} » rend toujours du contenu (${len} caractères)`, len > 20, String(len));
    }

    const applied = await page.evaluate(() => {
      const cs = el => el ? getComputedStyle(el) : null;
      const body = cs(document.body);
      const top = cs(document.querySelector(".topbar"));
      /* On mesure TOUS les boutons de l'écran plutôt qu'un seul : c'est le
         système qui doit tenir, pas un exemplaire choisi. */
      const btns = [...document.querySelectorAll(".btn")].map(b => ({
        small: b.classList.contains("small"), large: b.classList.contains("large"),
        radius: cs(b).borderRadius, minH: cs(b).minHeight,
      }));
      return {
        bodyBg: body.backgroundColor,
        topbarBg: top.backgroundColor,
        topbarRed: /linear-gradient/.test(top.backgroundImage),
        btnCount: btns.length,
        badRadius: btns.filter(b => b.radius !== "8px").length,
        badHeight: btns.filter(b => {
          const want = b.small ? "32px" : b.large ? "48px" : "40px";
          return b.minH !== want;
        }).length,
      };
    });
    eq("le fond de page est l'ivoire du système", applied.bodyBg, "rgb(251, 250, 248)");
    eq("l'en-tête est sur surface, plus en aplat rouge", applied.topbarBg, "rgb(255, 255, 255)");
    check("le dégradé rouge de l'en-tête a disparu", applied.topbarRed === false, String(applied.topbarRed));
    check(`les ${applied.btnCount} boutons de l'écran portent tous le rayon de contrôle`,
      applied.badRadius === 0, applied.badRadius + " hors système");
    check(`les ${applied.btnCount} boutons portent tous la hauteur prévue par leur taille`,
      applied.badHeight === 0, applied.badHeight + " hors système");

    const real = errs.filter(e => !/ERR_|favicon|Failed to load|net::/i.test(e));
    eq("aucune erreur JavaScript", real.slice(0, 3), []);
    await page.close();
  }

  /* ======================================================================
     7. DÉRIVE — le système ne doit jamais reculer
     ======================================================================
     La fondation est posée, mais les composants d'écran portent encore des
     valeurs en dur (c'est la migration de l'étape suivante). Ce garde-fou
     mesure l'état réel et interdit qu'il empire : les seuils ne peuvent que
     être abaissés, jamais relevés. */
  current = "7. dérive";
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const css = /<style>([\s\S]*?)<\/style>/.exec(src)[1];
    const root = /:root\{([\s\S]*?)\n  \}/.exec(css)[1];
    const body = css.replace(root, "");
    /* « En dur » = une valeur arbitraire. Sont exclus les cas où aucun token
       ne peut s'appliquer : un cercle (50 %), une absence (none), une valeur
       dérivée d'un token (calc(var(…))) ou un zéro. Un garde-fou qui compte
       ces cas-là punirait du code correct. */
    const STRUCTURAL = /^(none|inherit|initial|unset|0|50%|100%)$/;
    const hardcoded = (prop) => {
      const re = new RegExp(prop + "\\s*:\\s*([^;}]+)", "g");
      let m, n = 0;
      while ((m = re.exec(body)) !== null) {
        const v = m[1].trim().replace(/\s*!important$/, "");
        if (v.includes("var(")) continue;
        if (STRUCTURAL.test(v)) continue;
        n++;
      }
      return n;
    };

    /* Plafonds constatés au moment de la pose de la fondation.
       À DIMINUER au fil des migrations d'écrans — jamais à relever. */
    const LIMITS = {
      "tailles de texte en dur": { n: hardcoded("font-size"),     max: 398 },
      "graisses en dur":         { n: hardcoded("font-weight"),   max: 271 },
      "rayons en dur":           { n: hardcoded("border-radius"), max: 88 },
      "ombres en dur":           { n: hardcoded("box-shadow"),    max: 2 },
      "graisses 700 ou 800":     { n: (body.match(/font-weight:\s*[78]00/g) || []).length, max: 240 },
    };
    for (const [label, { n, max }] of Object.entries(LIMITS)) {
      check(`${label} : ${n} (plafond ${max})`, n <= max, `${n} > ${max} — le système recule`);
    }

    /* Ce qui ne doit JAMAIS réapparaître. */
    check("aucun #fff ou #FFFFFF en dur réintroduit dans un nouveau composant",
      (body.match(/#fff(f{3})?\b/gi) || []).length <= 63, "");
    check("aucune couleur nommée arbitraire (red, blue, green…)",
      (body.match(/:\s*(red|blue|green|orange|purple|pink)\s*[;!]/gi) || []).length === 0, "");
    check("le dégradé rouge de l'en-tête n'est pas revenu",
      !/\.topbar\{[^}]*linear-gradient/.test(body), "");
  }

  await browser.close();

  let pass = 0, fail = 0, last = "";
  results.forEach(r => {
    if (r.scenario !== last) { console.log("\n=== " + r.scenario + " ==="); last = r.scenario; }
    console.log((r.ok ? "PASS" : "FAIL") + " — " + r.label + (r.ok ? "" : "  [" + r.detail + "]"));
    r.ok ? pass++ : fail++;
  });
  console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
