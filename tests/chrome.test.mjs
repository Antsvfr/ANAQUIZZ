/* ============================================================================
   REV-EM — chrome global : marque, navigation, menus, langue, compte,
   navigation mobile, bouton assistant
   ----------------------------------------------------------------------------
   Prérequis : dépôt servi sur http://localhost:9109
   Exécution  : NODE_PATH=/opt/node22/lib/node_modules node tests/chrome.test.mjs

   Ce test vérifie surtout ce qui pourrait CASSER : le sélecteur de langue a
   changé de place dans le DOM, la délégation de clic a changé de racine, et
   le bouton assistant a été restylé sans que sa logique de glissement ne
   bouge. Chacun de ces points est éprouvé, pas supposé.
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

const TABS = ["dashboard", "library", "fiches", "progress", "smart", "stats", "planning", "ai", "exams"];
const URL = "http://localhost:9109/index.html";

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  /* ======================================================================
     1. MARQUE
     ====================================================================== */
  current = "1. marque";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);

    const brand = await page.evaluate(() => {
      const b = document.querySelector(".brand");
      const name = document.querySelector(".brand-name");
      const mark = document.querySelector(".brand-mark svg");
      const cs = getComputedStyle(name);
      const r = b.getBoundingClientRect();
      const bars = [...mark.querySelectorAll("rect")].map(x => ({
        h: +x.getAttribute("height"), fill: x.getAttribute("fill"),
      }));
      return {
        name: name.textContent.trim(), font: cs.fontFamily.split(",")[0],
        size: cs.fontSize, weight: cs.fontWeight, color: cs.color,
        width: Math.round(r.width), height: Math.round(r.height),
        bars, title: document.title,
        oldNames: /Lyon Révision|EM Lyon Révision/.test(document.body.innerHTML),
      };
    });
    eq("le mot-symbole est REV-EM", brand.name, "REV-EM");
    eq("le titre du document porte le même nom", brand.title, "REV-EM");
    check("plus aucun ancien nom dans le chrome", brand.oldNames === false, "");
    check("le mot-symbole est en police de display", /Newsreader/.test(brand.font), brand.font);
    eq("graisse maîtrisée (pas d'extra-gras)", brand.weight, "600");
    eq("couleur d'encre, pas de rouge", brand.color, "rgb(22, 22, 26)");
    check(`présence sans encombrement : ${brand.width}×${brand.height}px`,
      brand.width >= 100 && brand.width <= 220 && brand.height <= 48, `${brand.width}×${brand.height}`);
    check("le signe est une graduation : quatre traits croissants",
      brand.bars.length === 4 && brand.bars.every((b, i) => i === 0 || b.h > brand.bars[i - 1].h),
      JSON.stringify(brand.bars.map(b => b.h)));
    check("seul le dernier trait porte le rouge",
      brand.bars.filter(b => /accent/.test(b.fill)).length === 1, JSON.stringify(brand.bars.map(b => b.fill)));

    /* La marque ramène à l'accueil. */
    await page.evaluate(() => switchTab("stats"));
    await page.waitForTimeout(200);
    await page.click(".brand");
    await page.waitForTimeout(300);
    eq("cliquer la marque ramène à l'accueil", await page.evaluate(() => state.tab), "dashboard");
    await page.close();
  }

  /* ======================================================================
     2. HIÉRARCHIE DU HEADER
     ====================================================================== */
  current = "2. hiérarchie";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);

    const h = await page.evaluate(() => {
      const top = getComputedStyle(document.querySelector(".topbar"));
      /* Une rubrique AU REPOS : surtout pas celle de la section courante,
         qui porte volontairement une graisse plus forte. */
      const link = getComputedStyle(
        document.querySelector(".mainnav-item:not(.active-group) > .mainnav-link"));
      const active = document.querySelector(".mainnav-item.active-group > .mainnav-link");
      const activeAfter = active ? getComputedStyle(active, "::after") : null;
      const lang = getComputedStyle(document.querySelector(".lang-btn"));
      const prof = getComputedStyle(document.querySelector(".profile-chip"));
      const reds = [...document.querySelectorAll(".topbar *")].filter(el => {
        const c = getComputedStyle(el);
        return /227, 28, 61/.test(c.color) || /227, 28, 61/.test(c.backgroundColor);
      }).length;
      return {
        topbarBg: top.backgroundColor, topbarGradient: top.backgroundImage,
        linkSize: link.fontSize, linkWeight: link.fontWeight, linkColor: link.color,
        activeWeight: active ? getComputedStyle(active).fontWeight : null,
        activeBar: activeAfter ? activeAfter.backgroundColor : null,
        activeBarHeight: activeAfter ? activeAfter.height : null,
        langSize: lang.fontSize, profColor: prof.color,
        redCount: reds,
      };
    });
    eq("en-tête sur surface", h.topbarBg, "rgb(255, 255, 255)");
    eq("aucun dégradé dans l'en-tête", h.topbarGradient, "none");
    eq("navigation principale : 14px", h.linkSize, "14px");
    eq("rubrique au repos : graisse moyenne", h.linkWeight, "500");
    eq("section courante : graisse renforcée", h.activeWeight, "600");
    eq("section courante : soulignement rouge", h.activeBar, "rgb(227, 28, 61)");
    eq("soulignement de 2px", h.activeBarHeight, "2px");
    check(`le rouge reste un accent : ${h.redCount} élément(s) rouge(s) dans l'en-tête`,
      h.redCount <= 3, String(h.redCount));
    await page.close();
  }

  /* ======================================================================
     3. MENUS DÉROULANTS
     ====================================================================== */
  current = "3. menus";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);

    const menus = ["library", "activities", "resources", "exams", "progress"];
    for (const m of menus) {
      await page.click(`[data-menu-toggle="${m}"]`);
      await page.waitForTimeout(220);
      const open = await page.evaluate(k => {
        const item = document.querySelector(`.mainnav-item[data-nav="${k}"]`);
        const menu = item.querySelector(".dropdown-menu");
        const cs = getComputedStyle(menu);
        const chev = item.querySelector(".nav-chevron");
        return {
          visible: cs.display !== "none",
          radius: cs.borderRadius,
          items: [...menu.querySelectorAll("button")].map(b => b.textContent.trim()),
          chevronRotated: chev ? getComputedStyle(chev).transform !== "none" : null,
        };
      }, m);
      check(`menu « ${m} » s'ouvre`, open.visible, "");
      eq(`menu « ${m} » au rayon de surface`, open.radius, "12px");
      check(`menu « ${m} » : chevron pivoté`, open.chevronRotated === true, "");
      const withEmoji = open.items.filter(t => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t));
      eq(`menu « ${m} » sans emoji`, withEmoji, []);
      await page.keyboard.press("Escape").catch(() => {});
      await page.evaluate(() => closeAllNavMenus());
      await page.waitForTimeout(120);
    }
    await page.close();
  }

  /* ======================================================================
     4. SÉLECTEUR DE LANGUE — il a changé de place : c'est le point à risque
     ====================================================================== */
  current = "4. langue";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);

    const place = await page.evaluate(() => ({
      dansNavPrincipale: !!document.querySelector("#mainnav [data-menu-toggle='lang']"),
      dansActionsSecondaires: !!document.querySelector(".topbar-right [data-menu-toggle='lang']"),
      codeFerme: document.getElementById("lang-trigger-code").textContent.trim(),
      police: getComputedStyle(document.getElementById("lang-trigger-code")).fontFamily.split(",")[0],
    }));
    check("le sélecteur a quitté la navigation principale", place.dansNavPrincipale === false, "");
    check("il rejoint les actions secondaires", place.dansActionsSecondaires === true, "");
    eq("fermé : le code de langue", place.codeFerme, "FR");
    check("code en chasse fixe", /Plex Mono/.test(place.police), place.police);

    await page.click("[data-menu-toggle='lang']");
    await page.waitForTimeout(250);
    const opened = await page.evaluate(() => {
      const menu = document.getElementById("menu-lang");
      return {
        visible: getComputedStyle(menu).display !== "none",
        entries: [...menu.querySelectorAll("[data-set-lang]")].map(b => ({
          code: b.dataset.setLang,
          drapeau: b.querySelector("span[aria-hidden]").textContent.trim(),
          nom: b.querySelector("[data-i18n]").textContent.trim(),
          courant: b.getAttribute("aria-current"),
        })),
      };
    });
    check("le menu s'ouvre", opened.visible, "");
    eq("cinq langues, drapeau + nom natif",
      opened.entries.map(e => e.drapeau + " " + e.nom),
      ["🇫🇷 Français", "🇬🇧 English", "🇪🇸 Español", "🇩🇪 Deutsch", "🇮🇹 Italiano"]);
    eq("la langue courante est marquée", opened.entries.find(e => e.code === "fr").courant, "true");

    /* Le changement de langue passait par une délégation sur #mainnav.
       Le sélecteur ayant déménagé, c'est LE comportement à vérifier. */
    await page.click("[data-set-lang='de']");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      code: document.getElementById("lang-trigger-code").textContent.trim(),
      langue: window.LyonI18n.getLang(),
      menuFerme: getComputedStyle(document.getElementById("menu-lang")).display === "none",
      navTraduite: document.querySelector(".mainnav-link").textContent.trim(),
      fabLabel: document.getElementById("ai-bubble").getAttribute("data-label"),
    }));
    eq("la langue change réellement", after.langue, "de");
    eq("le code fermé se met à jour", after.code, "DE");
    check("le menu se referme après le choix", after.menuFerme, "");
    check("la navigation est retraduite", after.navTraduite.length > 0 && after.navTraduite !== "Accueil", after.navTraduite);
    check("le libellé de l'assistant suit la langue", after.fabLabel === "Assistent", after.fabLabel);

    await page.click("[data-menu-toggle='lang']"); await page.waitForTimeout(200);
    await page.click("[data-set-lang='fr']"); await page.waitForTimeout(300);
    eq("retour au français", await page.evaluate(() => window.LyonI18n.getLang()), "fr");
    await page.close();
  }

  /* ======================================================================
     5. COMPTE
     ====================================================================== */
  current = "5. compte";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);
    const prof = await page.evaluate(() => {
      const chip = document.querySelector(".profile-chip");
      const av = document.getElementById("profile-avatar");
      const cs = getComputedStyle(av);
      return {
        label: document.getElementById("profile-label").textContent.trim(),
        avatarBg: cs.backgroundColor, avatarRouge: /227, 28, 61/.test(cs.backgroundColor),
        separe: !!document.querySelector(".topbar-divider"),
        dernier: document.querySelector(".topbar-right").lastElementChild.id,
      };
    });
    check("un libellé de compte est affiché", prof.label.length > 0, prof.label);
    check("l'avatar vide n'est plus un disque rouge", prof.avatarRouge === false, prof.avatarBg);
    check("le compte est séparé des actions secondaires par un filet", prof.separe, "");
    await page.click("#profile-chip-btn");
    await page.waitForTimeout(300);
    eq("le compte mène à Mon espace", await page.evaluate(() => state.tab), "myspace");
    await page.close();
  }

  /* ======================================================================
     6. NAVIGATION MOBILE ET TABLETTE
     ====================================================================== */
  current = "6. mobile";
  {
    for (const [w, h, name] of [[375, 812, "mobile"], [768, 1024, "tablette"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: true, isMobile: w < 500 });
      await page.goto(URL); await page.waitForTimeout(1400);

      const closed = await page.evaluate(() => ({
        navCachee: getComputedStyle(document.getElementById("mainnav")).display === "none",
        bouton: getComputedStyle(document.getElementById("hamburger-btn")).display !== "none",
        expanded: document.getElementById("hamburger-btn").getAttribute("aria-expanded"),
        langueVisible: getComputedStyle(document.querySelector(".topbar-lang")).display !== "none",
        debordement: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      check(`[${name}] la navigation est repliée`, closed.navCachee, "");
      check(`[${name}] le bouton de menu est proposé`, closed.bouton, "");
      eq(`[${name}] l'état du menu est annoncé`, closed.expanded, "false");
      check(`[${name}] le sélecteur de langue reste accessible`, closed.langueVisible, "");
      check(`[${name}] aucun débordement horizontal`, !closed.debordement, "");

      await page.click("#hamburger-btn");
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => {
        const nav = document.getElementById("mainnav");
        const r = nav.getBoundingClientRect();
        const links = [...nav.querySelectorAll(".mainnav-link")];
        return {
          ouverte: getComputedStyle(nav).display !== "none",
          pleineHauteur: Math.round(r.height) > window.innerHeight * 0.7,
          sousHeader: Math.round(r.top) >= 56,
          expanded: document.getElementById("hamburger-btn").getAttribute("aria-expanded"),
          croix: getComputedStyle(document.querySelector(".hamburger-btn .icon-close")).display !== "none",
          petitesCibles: links.filter(l => l.getBoundingClientRect().height < 44).length,
          nbEntrees: links.length,
        };
      });
      check(`[${name}] la feuille s'ouvre`, open.ouverte, "");
      check(`[${name}] elle occupe la hauteur de l'écran`, open.pleineHauteur, "");
      check(`[${name}] elle passe sous l'en-tête`, open.sousHeader, "");
      eq(`[${name}] l'état ouvert est annoncé`, open.expanded, "true");
      check(`[${name}] le bouton devient une croix`, open.croix, "");
      eq(`[${name}] toutes les entrées atteignent 44px (${open.nbEntrees} entrées)`, open.petitesCibles, 0);

      /* Une entrée ferme la feuille et navigue. */
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#mainnav [data-goto]")].find(b => b.dataset.goto === "planning");
        if (btn) btn.click();
      });
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({
        tab: state.tab,
        fermee: !document.body.classList.contains("mobile-nav-open"),
      }));
      eq(`[${name}] naviguer depuis la feuille fonctionne`, after.tab, "planning");
      check(`[${name}] et la referme`, after.fermee, "");
      await page.close();
    }
  }

  /* ======================================================================
     7. BOUTON ASSISTANT — restylé, toujours déplaçable
     ====================================================================== */
  current = "7. assistant";
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL); await page.waitForTimeout(1500);

    const fab = await page.evaluate(() => {
      const el = document.getElementById("ai-bubble");
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        bg: cs.backgroundColor, gradient: cs.backgroundImage,
        anim: cs.animationName, shadow: cs.boxShadow !== "none",
        ariaLabel: el.getAttribute("aria-label"),
        side: el.getAttribute("data-side"),
        icone: el.querySelector("svg") ? el.querySelectorAll("svg path").length : 0,
        cursor: cs.cursor,
      };
    });
    check(`taille discrète : ${fab.w}×${fab.h}px`, fab.w <= 52 && fab.h <= 52, `${fab.w}×${fab.h}`);
    eq("plus de dégradé", fab.gradient, "none");
    eq("plus d'animation perpétuelle", fab.anim, "none");
    check("disque d'encre, pas de rouge", !/227, 28, 61/.test(fab.bg), fab.bg);
    check("une ombre légère le détache du fond", fab.shadow, "");
    check("il reste annoncé aux lecteurs d'écran", (fab.ariaLabel || "").length > 5, fab.ariaLabel);
    check("icône tracée (pas d'emoji)", fab.icone >= 2, String(fab.icone));
    eq("il reste saisissable", fab.cursor, "grab");

    /* Le glissement : la logique n'a pas été touchée, mais elle doit être
       vérifiée puisque le style a changé. */
    const before = await page.evaluate(() => document.getElementById("ai-bubble").getBoundingClientRect().left);
    await page.mouse.move(1400, 850);
    await page.mouse.down();
    await page.mouse.move(200, 400, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = await page.evaluate(() => {
      const el = document.getElementById("ai-bubble");
      return { left: el.getBoundingClientRect().left, side: el.getAttribute("data-side"), state: state.aiBubble.side };
    });
    check("le bouton se déplace toujours", moved.left < before - 100, `${before} → ${moved.left}`);
    eq("il s'ancre au bord le plus proche", moved.side, "left");
    eq("et l'état le mémorise", moved.state, "left");

    /* Mémorisation après rechargement. */
    await page.reload(); await page.waitForTimeout(1500);
    eq("la position survit au rechargement", await page.evaluate(() => state.aiBubble.side), "left");
    await page.close();
  }

  /* ======================================================================
     8. TOUTES LES PAGES — cohérence et non-régression
     ====================================================================== */
  current = "8. toutes les pages";
  {
    for (const [w, h, name] of [[1440, 900, "bureau"], [768, 1024, "tablette"], [375, 812, "mobile"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errs = [];
      page.on("pageerror", e => errs.push(e.message));
      page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
      await page.goto(URL); await page.waitForTimeout(1500);

      for (const tab of TABS) {
        await page.evaluate(t => switchTab(t), tab);
        await page.waitForTimeout(160);
        const st = await page.evaluate(() => ({
          contenu: document.getElementById("content").textContent.trim().length,
          marque: document.querySelector(".brand-name").textContent.trim(),
          barreVisible: getComputedStyle(document.querySelector(".topbar")).display !== "none",
          debordement: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }));
        check(`[${name}] ${tab} : contenu rendu (${st.contenu})`, st.contenu > 20, String(st.contenu));
        eq(`[${name}] ${tab} : chrome identique`, [st.marque, st.barreVisible], ["REV-EM", true]);
        check(`[${name}] ${tab} : aucun débordement`, !st.debordement, "");
      }
      const real = errs.filter(e => !/ERR_|favicon|Failed to load|net::/i.test(e));
      eq(`[${name}] aucune erreur JavaScript`, real.slice(0, 2), []);
      await page.close();
    }
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
