/* ============================================================================
   ÉTAPE 5 — VÉRIFICATION DE LA BIBLIOTHÈQUE DE COMPOSANTS
   ----------------------------------------------------------------------------
   Ces vérifications sont faites dans un vrai navigateur, sur les styles réels
   de l'application (components.html injecte le <style> de index.html), et aux
   trois largeurs du système : 1440 (bureau), 768 (tablette), 375 (mobile).

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/components.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:9109";
const GALLERY = BASE + "/components.html";
const APP = BASE + "/index.html";

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });

/* Contraste WCAG — même calcul que tests/design-system.test.mjs. */
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const parse = s => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

const VIEWPORTS = [
  { name: "bureau",   width: 1440, height: 900 },
  { name: "tablette", width: 768,  height: 1024 },
  { name: "mobile",   width: 375,  height: 812 },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. LA GALERIE REND LES VRAIS STYLES DE L'APPLICATION
     ====================================================================== */
  current = "1. source unique";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])", { timeout: 15000 });

    const src = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        /* Si les tokens de index.html sont là, le <style> a bien été injecté. */
        accent: cs.getPropertyValue("--accent").trim(),
        radiusMd: cs.getPropertyValue("--radius-md").trim(),
        fontUi: cs.getPropertyValue("--font-ui").trim().split(",")[0],
        /* Et la galerie n'a pas sa propre définition de composant. */
        ownRules: [...document.querySelectorAll("style")]
          .filter(s => s.parentNode === document.head && !s.textContent.includes("--accent"))
          .map(s => s.textContent).join("")
          .match(/\.(btn|card|block--|badge|status|modal|toast|input|select|textarea|menu|empty|callout)[^{]*\{/g) || [],
        sections: [...document.querySelectorAll(".gal-sec")].map(s => s.id),
      };
    });
    eq("les tokens de l'application sont présents", src.accent, "#E31C3D");
    eq("le rayon de surface vient de l'application", src.radiusMd, "12px");
    eq("la famille d'interface vient de l'application", src.fontUi, '"Public Sans"');
    eq("la galerie ne redéfinit aucun composant", src.ownRules, []);
    eq("les 12 catégories sont présentes", src.sections.length, 12);
    eq("aucune erreur JavaScript dans la galerie", errors, []);
    await page.close();
  }

  /* ======================================================================
     2. HIÉRARCHIE DES ACTIONS — CINQ NIVEAUX DISTINCTS
     ====================================================================== */
  current = "2. actions";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    const a = await page.evaluate(() => {
      const g = sel => {
        const el = document.querySelector("#gal-actions " + sel);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          bg: cs.backgroundColor, color: cs.color, border: cs.borderColor,
          borderWidth: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
          weight: cs.fontWeight, size: cs.fontSize,
          height: Math.round(r.height), padding: cs.paddingLeft,
        };
      };
      return {
        primary: g(".btn--primary"),
        secondary: g(".btn--secondary"),
        tertiary: g(".btn--tertiary"),
        link: g(".link"),
        destructive: g(".btn--destructive"),
        small: g(".btn--primary.small"),
        large: g(".btn--primary.large"),
        disabled: g(".btn--primary[disabled]"),
        loadingLabel: getComputedStyle(
          document.querySelector("#gal-actions .btn--primary.is-loading")).color,
      };
    });

    eq("PRIMARY porte le rouge emlyon", a.primary.bg, "rgb(227, 28, 61)");
    eq("PRIMARY écrit en blanc", a.primary.color, "rgb(255, 255, 255)");
    eq("SECONDARY est sur surface blanche", a.secondary.bg, "rgb(255, 255, 255)");
    check("SECONDARY porte un filet visible", a.secondary.borderWidth === "1px", a.secondary);
    eq("TERTIARY n'a pas d'aplat", a.tertiary.bg, "rgba(0, 0, 0, 0)");
    eq("LINK n'a pas d'aplat", a.link.bg, "rgba(0, 0, 0, 0)");
    eq("DESTRUCTIVE écrit en rouge d'erreur", a.destructive.color, "rgb(179, 38, 30)");
    eq("DESTRUCTIVE n'est pas un aplat rouge au repos", a.destructive.bg, "rgba(0, 0, 0, 0)");

    check("les cinq niveaux sont visuellement distincts",
      new Set([a.primary.bg + a.primary.color, a.secondary.bg + a.secondary.border,
               a.tertiary.bg + a.tertiary.color, a.link.bg + a.link.color,
               a.destructive.bg + a.destructive.color]).size === 5,
      a);

    eq("trois tailles : 32 / 40 / 48", [a.small.height, a.primary.height, a.large.height], [32, 40, 48]);
    check("un bouton désactivé n'est plus rouge",
      a.disabled.bg !== "rgb(227, 28, 61)", a.disabled.bg);
    eq("un bouton en chargement masque son libellé", a.loadingLabel, "rgba(0, 0, 0, 0)");

    /* Contraste des deux niveaux qui portent du texte sur aplat. */
    check("PRIMARY : contraste AA",
      ratio(parse(a.primary.color), parse(a.primary.bg)) >= 4.5,
      ratio(parse(a.primary.color), parse(a.primary.bg)).toFixed(2));
    check("SECONDARY : contraste AA",
      ratio(parse(a.secondary.color), parse(a.secondary.bg)) >= 4.5,
      ratio(parse(a.secondary.color), parse(a.secondary.bg)).toFixed(2));
    check("DESTRUCTIVE : contraste AA",
      ratio(parse(a.destructive.color), [255, 255, 255]) >= 4.5,
      ratio(parse(a.destructive.color), [255, 255, 255]).toFixed(2));
    await page.close();
  }

  /* ======================================================================
     3. SURFACES — QUATRE CATÉGORIES, ET PAS DE CARTE IMBRIQUÉE
     ====================================================================== */
  current = "3. surfaces";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    const s = await page.evaluate(() => {
      const box = el => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor, border: cs.borderTopWidth,
          shadow: cs.boxShadow, radius: cs.borderTopLeftRadius, padding: cs.paddingTop,
        };
      };
      const nested = document.querySelectorAll("#gal-surfaces .block--feature .block--feature");
      return {
        feature: box(document.querySelector("#gal-surfaces .block--feature")),
        info:    box(document.querySelector("#gal-surfaces .block--info")),
        action:  box(document.querySelector("#gal-surfaces .block--action")),
        nested2: box(nested[0]),
        nested3: box(nested[1]),
        /* Le chiffre clé du système n'est PAS une carte : sinon la page se
           remplit de petites boîtes, ce que l'audit reprochait. */
        stat: box(document.querySelector("#gal-mesures .stat")),
      };
    });

    check("FEATURE : surface blanche, filet, ombre légère",
      s.feature.bg === "rgb(255, 255, 255)" && s.feature.border === "1px" && s.feature.shadow !== "none",
      s.feature);
    check("INFORMATION : aucune boîte",
      s.info.bg === "rgba(0, 0, 0, 0)" && s.info.border === "0px" && s.info.shadow === "none",
      s.info);
    check("ACTION : aplat creusé, sans ombre",
      s.action.bg === "rgb(244, 242, 238)" && s.action.shadow === "none",
      s.action);
    eq("carte de niveau 2 : plus d'ombre", s.nested2.shadow, "none");
    check("carte de niveau 3 : plus de boîte du tout",
      s.nested3.bg === "rgba(0, 0, 0, 0)" && s.nested3.border === "0px" && s.nested3.padding === "0px",
      s.nested3);
    check("un chiffre clé n'est pas une petite carte",
      s.stat.bg === "rgba(0, 0, 0, 0)" && s.stat.border === "0px" && s.stat.shadow === "none",
      s.stat);
    await page.close();
  }

  /* ======================================================================
     4. CHAMPS — UNE SEULE FAMILLE, ERREUR JAMAIS PORTÉE PAR LA COULEUR SEULE
     ====================================================================== */
  current = "4. champs";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    const f = await page.evaluate(() => {
      const g = sel => {
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        return { radius: cs.borderTopLeftRadius, border: cs.borderTopColor,
                 height: Math.round(el.getBoundingClientRect().height), font: cs.fontSize };
      };
      const invalid = document.querySelector("#g-5");
      return {
        input: g("#g-1"), select: g("#g-2"), textarea: g("#g-4"),
        disabledBg: getComputedStyle(document.querySelector("#g-6")).backgroundColor,
        invalidBorder: getComputedStyle(invalid).borderTopColor,
        invalidAria: invalid.getAttribute("aria-invalid"),
        /* L'erreur est ÉCRITE, pas seulement colorée. */
        errorText: (document.querySelector("#g-5-err") || {}).textContent || "",
        labelledFields: [...document.querySelectorAll("#gal-champs .field")]
          .filter(fl => fl.querySelector(".field-label") && fl.querySelector("input,select,textarea")).length,
        totalFields: document.querySelectorAll("#gal-champs .field").length,
      };
    });

    eq("champ, liste et zone de texte partagent le rayon de contrôle",
      [f.input.radius, f.select.radius, f.textarea.radius], ["8px", "8px", "8px"]);
    eq("champ et liste partagent la même hauteur", [f.input.height, f.select.height], [40, 40]);
    eq("un champ désactivé se lit comme désactivé", f.disabledBg, "rgb(244, 242, 238)");
    eq("un champ invalide porte la bordure d'erreur", f.invalidBorder, "rgb(179, 38, 30)");
    eq("un champ invalide le dit aux lecteurs d'écran", f.invalidAria, "true");
    check("l'erreur est écrite, pas seulement colorée", f.errorText.length > 20, f.errorText);
    eq("chaque champ a un libellé", f.labelledFields, f.totalFields);

    /* Les champs historiques de l'assistant IA rejoignent la même famille. */
    const app = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await app.goto(APP); await app.waitForTimeout(1500);
    /* Le formulaire « Nouvelle matière » est le plus dense en champs .ai-select :
       il mélange <input> et <select>, ce qui est précisément le cas à vérifier. */
    await app.evaluate(() => {
      libGoto("subjectForm", { editingSubjectId: null });
      switchTab("library");
    });
    await app.waitForTimeout(600);
    const ai = await app.evaluate(() => {
      const one = el => {
        const cs = getComputedStyle(el);
        return {
          radius: cs.borderTopLeftRadius, width: cs.borderTopWidth,
          font: cs.fontFamily.split(",")[0], size: cs.fontSize,
          height: Math.round(el.getBoundingClientRect().height),
          chevron: cs.backgroundImage !== "none",
        };
      };
      return {
        input: one(document.querySelector("input.ai-select")),
        select: one(document.querySelector("select.ai-select")),
        labelWeight: getComputedStyle(document.querySelector(".ai-field label")).fontWeight,
        labelTransform: getComputedStyle(document.querySelector(".ai-field label")).textTransform,
      };
    });
    eq("les champs IA suivent le rayon de contrôle",
      [ai.input.radius, ai.select.radius], ["8px", "8px"]);
    eq("les champs IA suivent le filet du système",
      [ai.input.width, ai.select.width], ["1px", "1px"]);
    eq("les champs IA suivent la famille d'interface",
      [ai.input.font, ai.select.font], ['"Public Sans"', '"Public Sans"']);
    eq("les champs IA partagent la hauteur de contrôle",
      [ai.input.height, ai.select.height], [40, 40]);
    /* Le chevron ne doit apparaître que sur un vrai <select>. */
    eq("un <input> ne porte pas de chevron de liste déroulante", ai.input.chevron, false);
    eq("un <select> porte le chevron", ai.select.chevron, true);
    eq("le libellé IA n'est plus une capitale grasse à 800",
      [ai.labelWeight, ai.labelTransform], ["500", "none"]);
    await app.close();
    await page.close();
  }

  /* ======================================================================
     5. MODALE ET CONFIRMATION — ACCESSIBILITÉ RÉELLE
     ====================================================================== */
  current = "5. confirmation";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    await page.click("#gal-open-confirm");
    await page.waitForSelector(".modal-backdrop .modal--confirm");

    const m = await page.evaluate(() => {
      const modal = document.querySelector(".modal--confirm");
      const back = document.querySelector(".modal-backdrop");
      const yes = modal.querySelector('[data-ds-confirm="yes"]');
      return {
        role: modal.getAttribute("role"),
        modalAttr: modal.getAttribute("aria-modal"),
        labelled: !!document.getElementById(modal.getAttribute("aria-labelledby")),
        title: modal.querySelector(".modal-title").textContent,
        /* Le focus part sur l'action la MOINS risquée. */
        focusIsCancel: document.activeElement === modal.querySelector('[data-ds-confirm="no"]'),
        destructiveButton: yes.className,
        backdrop: getComputedStyle(back).backgroundColor,
        shadow: getComputedStyle(modal).boxShadow !== "none",
        radius: getComputedStyle(modal).borderTopLeftRadius,
      };
    });
    eq("la confirmation est un alertdialog", m.role, "alertdialog");
    eq("la confirmation est modale", m.modalAttr, "true");
    check("la confirmation est nommée par son titre", m.labelled, m);
    check("le titre nomme la conséquence, pas « Êtes-vous sûr ? »",
      /supprimer/i.test(m.title) && !/sûr/i.test(m.title), m.title);
    check("le focus part sur l'action la moins risquée", m.focusIsCancel, m);
    check("l'action de confirmation est destructive", /btn--destructive/.test(m.destructiveButton), m.destructiveButton);
    check("le fond assombrit sans flouter", /rgba\(22, 22, 26/.test(m.backdrop), m.backdrop);
    eq("la modale porte le rayon de survol de page", m.radius, "16px");

    /* Le focus ne sort pas de la modale. */
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    const trapped = await page.evaluate(() =>
      !!document.querySelector(".modal-backdrop")?.contains(document.activeElement));
    check("le focus clavier reste piégé dans la modale", trapped, trapped);

    /* Échap annule, et renvoie bien « non ». */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => ({
      gone: !document.querySelector(".modal-backdrop"),
      toast: (document.getElementById("app-toast") || {}).textContent || "",
    }));
    check("Échap ferme la confirmation", closed.gone, closed);
    check("Échap répond « non »", /rien n'a été supprimé/i.test(closed.toast), closed.toast);

    /* Clic sur le fond : même réponse. */
    await page.click("#gal-open-confirm");
    await page.waitForSelector(".modal-backdrop");
    await page.mouse.click(20, 20);
    await page.waitForTimeout(300);
    check("un clic sur le fond ferme la confirmation",
      await page.evaluate(() => !document.querySelector(".modal-backdrop")), "");

    /* Et la réponse positive fait bien ce qu'elle annonce. */
    await page.click("#gal-open-confirm");
    await page.waitForSelector(".modal-backdrop");
    await page.click('[data-ds-confirm="yes"]');
    await page.waitForTimeout(300);
    const yes = await page.evaluate(() => (document.getElementById("app-toast") || {}).textContent || "");
    check("la réponse positive est bien transmise", /paquet supprimé/i.test(yes), yes);
    await page.close();
  }

  /* ======================================================================
     5 bis. LA CONFIRMATION EST BRANCHÉE DANS L'APPLICATION
     ----------------------------------------------------------------------
     La suppression d'une matière passait par window.confirm(). Elle passe
     désormais par le composant — et rien n'est supprimé si l'on refuse.
     ====================================================================== */
  current = "5 bis. confirmation dans l'application";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const nativeDialogs = [];
    page.on("dialog", d => { nativeDialogs.push(d.message()); d.dismiss(); });
    await page.goto(APP);
    await page.waitForTimeout(1500);

    /* Une matière de test, puis on ouvre sa fiche. */
    const before = await page.evaluate(() => {
      state.userSubjects.push({ id: "test-ds", name: "Matière de test",
                                semesterId: (SEMESTERS[0] || {}).id, icon: "", color: "" });
      saveUserSubjects();
      libGoto("subjectDetail", { subjectId: "test-ds" });
      switchTab("library");
      return state.userSubjects.length;
    });
    await page.waitForTimeout(500);

    await page.click("#lib-delete-subject-btn");
    await page.waitForSelector(".modal-backdrop .modal--confirm", { timeout: 5000 });
    const dlg = await page.evaluate(() => ({
      title: document.querySelector(".modal-title").textContent,
      body: document.querySelector(".ds-confirm-body").textContent,
      confirmLabel: document.querySelector('[data-ds-confirm="yes"]').textContent,
    }));
    check("la suppression d'une matière ouvre le composant, pas confirm()",
      /Matière de test/.test(dlg.title), dlg.title);
    check("le bouton nomme l'action, pas « OK »",
      /supprimer la matière/i.test(dlg.confirmLabel), dlg.confirmLabel);
    check("le corps annonce la conséquence", dlg.body.length > 30, dlg.body);

    /* Refuser ne supprime rien. */
    await page.click('[data-ds-confirm="no"]');
    await page.waitForTimeout(300);
    const afterNo = await page.evaluate(() => state.userSubjects.length);
    eq("refuser ne supprime rien", afterNo, before);

    /* Accepter supprime. */
    await page.click("#lib-delete-subject-btn");
    await page.waitForSelector(".modal-backdrop .modal--confirm");
    await page.click('[data-ds-confirm="yes"]');
    await page.waitForTimeout(400);
    const afterYes = await page.evaluate(() =>
      state.userSubjects.filter(s => s.id === "test-ds").length);
    eq("accepter supprime bien la matière", afterYes, 0);
    eq("aucune boîte de dialogue native n'a été ouverte", nativeDialogs, []);
    await page.close();
  }

  /* ======================================================================
     6. TOAST — APPARAÎT, SE LIT, DISPARAÎT
     ====================================================================== */
  current = "6. toast";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    await page.click("#gal-toast-ok");
    await page.waitForTimeout(400);
    const t = await page.evaluate(() => {
      const el = document.getElementById("app-toast");
      const cs = getComputedStyle(el);
      return {
        shown: el.classList.contains("show"), opacity: cs.opacity,
        role: el.getAttribute("role"), live: el.getAttribute("aria-live"),
        bg: cs.backgroundColor, color: cs.color, tone: el.className,
        radius: cs.borderTopLeftRadius,
      };
    });
    check("le toast est visible", t.shown && t.opacity === "1", t);
    eq("le toast est annoncé", [t.role, t.live], ["status", "polite"]);
    eq("le toast porte le ton demandé", /toast--success/.test(t.tone), true);
    check("le toast n'est plus une pastille : rayon de contrôle", t.radius === "8px", t.radius);
    check("toast : contraste AA",
      ratio(parse(t.color), parse(t.bg)) >= 4.5,
      ratio(parse(t.color), parse(t.bg)).toFixed(2));

    /* Le ton change quand on redemande un autre ton. */
    await page.click("#gal-toast-ko");
    await page.waitForTimeout(300);
    const t2 = await page.evaluate(() => document.getElementById("app-toast").className);
    check("le ton précédent ne reste pas collé",
      /toast--error/.test(t2) && !/toast--success/.test(t2), t2);

    /* Non-régression : le toast de l'application marche toujours. */
    const app = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await app.goto(APP); await app.waitForTimeout(1500);
    const appToast = await app.evaluate(() => {
      if (typeof showToast !== "function") return null;
      showToast("Test");
      const el = document.getElementById("app-toast");
      return { cls: el.className, text: el.textContent };
    });
    check("showToast() de l'application fonctionne toujours",
      appToast && /toast/.test(appToast.cls) && /app-toast/.test(appToast.cls) && appToast.text === "Test",
      appToast);
    await app.close();
    await page.close();
  }

  /* ======================================================================
     7. FOCUS CLAVIER VISIBLE SUR TOUS LES COMPOSANTS INTERACTIFS
     ====================================================================== */
  current = "7. focus";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");

    const focusables = [".btn--primary", ".btn--secondary", ".btn--tertiary",
                        ".link", ".btn--destructive"];
    for (const sel of focusables) {
      const ok = await page.evaluate(s => {
        const el = document.querySelector("#gal-actions " + s);
        el.focus();
        const cs = getComputedStyle(el);
        return { outline: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
      }, sel);
      check(`focus visible sur ${sel}`,
        ok.outline !== "none" && parseFloat(ok.width) >= 2, ok);
    }
    await page.focus("#g-1");
    /* La bordure du champ est en transition : lire tout de suite renverrait
       encore la valeur de départ. */
    await page.waitForTimeout(300);
    const fieldFocus = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#g-1"));
      return { outline: cs.outlineStyle, width: cs.outlineWidth, border: cs.borderTopColor };
    });
    check("focus visible sur un champ",
      fieldFocus.outline !== "none" || fieldFocus.border === "rgb(227, 28, 61)", fieldFocus);
    await page.close();
  }

  /* ======================================================================
     8. TOUS LES COMPOSANTS, AUX TROIS LARGEURS
     ====================================================================== */
  for (const vp of VIEWPORTS) {
    current = `8. ${vp.name}`;
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const secs = [...document.querySelectorAll(".gal-sec")].map(s => ({
        id: s.id,
        height: Math.round(s.getBoundingClientRect().height),
      }));
      /* Aucun composant ne dépasse de la page. */
      const over = [...document.querySelectorAll(".gal-wrap *")]
        .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(el => el.className || el.tagName).slice(0, 6);
      return {
        secs,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowing: over,
        /* Un bouton doit rester atteignable au doigt. */
        actionBar: (() => {
          const bar = document.querySelector("#gal-surfaces .block--action");
          return { dir: getComputedStyle(bar).flexDirection,
                   right: Math.round(bar.getBoundingClientRect().right) };
        })(),
        statRow: getComputedStyle(document.querySelector("#gal-mesures .stat-row")).gap,
      };
    });

    for (const s of r.secs) check(`[${vp.name}] ${s.id} : rendu`, s.height > 40, s);
    check(`[${vp.name}] aucun débordement horizontal de page`, !r.pageOverflow, r.pageOverflow);
    eq(`[${vp.name}] aucun composant ne déborde`, r.overflowing, []);
    if (vp.width <= 640) {
      eq(`[${vp.name}] la barre d'actions s'empile`, r.actionBar.dir, "column");
    } else {
      eq(`[${vp.name}] la barre d'actions reste en ligne`, r.actionBar.dir, "row");
    }
    eq(`[${vp.name}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ======================================================================
     9. CIBLES TACTILES SUR POINTEUR GROSSIER
     ====================================================================== */
  current = "9. tactile";
  {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto(GALLERY);
    await page.waitForSelector("#gal:not([hidden])");
    await page.waitForTimeout(300);

    const small = await page.evaluate(() =>
      [...document.querySelectorAll(".btn, .btn-text, .menu-item, .choice")]
        .filter(el => el.offsetParent !== null)
        .map(el => ({ c: el.className, h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h < 44));
    eq("aucune cible tactile sous 44px", small, []);

    /* En compact, la modale et sa barre d'actions restent utilisables. */
    await page.click("#gal-open-confirm");
    await page.waitForSelector(".modal-backdrop");
    const mob = await page.evaluate(() => {
      const modal = document.querySelector(".modal--confirm");
      const foot = modal.querySelector(".modal-foot");
      const r = modal.getBoundingClientRect();
      return {
        dir: getComputedStyle(foot).flexDirection,
        fits: r.width <= document.documentElement.clientWidth,
        inView: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      };
    });
    eq("[mobile] la confirmation empile ses actions", mob.dir, "column-reverse");
    check("[mobile] la confirmation tient dans l'écran", mob.fits && mob.inView, mob);
    await ctx.close();
  }

  /* ======================================================================
     10. NON-RÉGRESSION DE L'APPLICATION — LES ÉCRANS RENDENT TOUJOURS
     ====================================================================== */
  current = "10. non-régression";
  {
    const TABS = ["dashboard", "library", "fiches", "progress", "smart",
                  "stats", "planning", "ai", "exams"];
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(APP);
      await page.waitForTimeout(1500);
      for (const tab of TABS) {
        await page.evaluate(t => {
          const b = document.querySelector(`[data-goto="${t}"]`);
          if (b) b.click();
        }, tab);
        await page.waitForTimeout(350);
        const st = await page.evaluate(() => ({
          len: (document.getElementById("view") || document.body).innerText.trim().length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }));
        check(`[${vp.name}] ${tab} : contenu rendu`, st.len > 40, st.len);
        check(`[${vp.name}] ${tab} : aucun débordement`, !st.overflow, st.overflow);
      }
      eq(`[${vp.name}] application : aucune erreur JavaScript`, errors, []);
      await page.close();
    }
  }
} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${e.message}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
