/* ============================================================================
   REV-EM — le moteur du Command Center
   ----------------------------------------------------------------------------
   Exécution :  node tests/command-center.test.js
   Aucune dépendance, aucun réseau, aucun navigateur : le moteur est pur.

   Ce qui est testé ici : la normalisation, les six façons de reconnaître un
   texte, le classement, le regroupement, et le registre de sources.
   Ce qui est testé AILLEURS (tests/command-ui.test.mjs, au navigateur) : le
   raccourci clavier, le panneau, la navigation au clavier, les cinq langues.
   ============================================================================ */
"use strict";

require("../command-center.js");
const LC = globalThis.LyonCommand;

let pass = 0, fail = 0, current = "";
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
function scenario(name, fn){
  current = name; console.log(`\n── ${name} ──`);
  try{ fn(); }catch(e){ check(`« ${name} » s'exécute sans exception`, false, String(e && e.stack || e)); }
}

/* ══════════════════════════════════════════════════════════════════════════
   1. NORMALISATION
   ══════════════════════════════════════════════════════════════════════════ */
scenario("1. normalisation", () => {
  eq("les accents disparaissent", LC.normalize("Dérivation"), "derivation");
  eq("les majuscules aussi", LC.normalize("MATHÉMATIQUES"), "mathematiques");
  eq("la ponctuation devient une coupure", LC.normalize("Quiz : Dérivation"), "quiz derivation");
  eq("l'apostrophe typographique aussi", LC.normalize("L'étude d’un marché"), "l etude d un marche");
  eq("les espaces sont réduits", LC.normalize("  a   b  "), "a b");
  eq("une valeur absente ne casse rien", LC.normalize(null), "");
  eq("les chiffres sont conservés", LC.normalize("Chapitre 12"), "chapitre 12");
});

/* ══════════════════════════════════════════════════════════════════════════
   2. LES SIX FAÇONS DE RECONNAÎTRE UN TEXTE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("2. reconnaissance d'un texte", () => {
  const s = (q, t) => LC.scoreText(LC.normalize(q), t);

  check("égalité : le score est maximal", s("maths", "Maths") === 1, s("maths", "Maths"));
  check("début du texte", s("math", "Mathématiques") > 0.85, s("math", "Mathématiques"));
  check("début d'un mot", s("deriv", "Chapitre : Dérivation") > 0.8, s("deriv", "Chapitre : Dérivation"));
  check("milieu d'un mot", s("rivation", "Dérivation") > 0.65, s("rivation", "Dérivation"));
  check("lettres dans l'ordre", s("drvtn", "Dérivation") > 0.3, s("drvtn", "Dérivation"));
  check("faute de frappe (inversion)", s("mathemtiqeus", "Mathématiques") > 0.3, s("mathemtiqeus", "Mathématiques"));
  check("lettre manquante", s("drivation", "Dérivation") > 0.3, s("drivation", "Dérivation"));
  check("lettre en trop", s("deriivation", "Dérivation") > 0.3, s("deriivation", "Dérivation"));
  eq("aucun rapport : zéro", s("zzzzzz", "Dérivation"), 0);
  eq("requête vide : zéro", s("", "Dérivation"), 0);

  /* L'ORDRE est ce qui compte vraiment : une approximation ne doit jamais
     passer devant une correspondance plus sûre. */
  const exact  = s("derivation", "Dérivation");
  const prefix = s("deriv", "Dérivation");
  const infix  = s("rivat", "Dérivation");
  const subseq = s("drvtn", "Dérivation");
  const typo   = s("drivation", "Dérivation");
  check("exact > préfixe > milieu > approximations",
    exact > prefix && prefix > infix && infix > subseq && infix > typo,
    { exact, prefix, infix, subseq, typo });

  /* Accents : dans les deux sens, sans que personne ait à les taper. */
  check("sans accent trouve avec accent", s("eleve", "Élève") === 1, s("eleve", "Élève"));
  check("avec accent trouve sans accent", s("élève", "Eleve") === 1, s("élève", "Eleve"));

  /* Requête en plusieurs mots. */
  check("deux mots retrouvés séparément", s("quiz deriv", "Quiz : Dérivation") > 0.65,
    s("quiz deriv", "Quiz : Dérivation"));

  /* Un mot court ne tolère aucune faute : sinon « bac » trouverait « sac ». */
  eq("un mot de trois lettres ne tolère pas de faute", s("bac", "sac"), 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   3. DISTANCE D'ÉDITION
   ══════════════════════════════════════════════════════════════════════════ */
scenario("3. distance d'édition", () => {
  eq("identiques", LC.editDistance("abc", "abc", 3), 0);
  eq("une substitution", LC.editDistance("abc", "abd", 3), 1);
  eq("une insertion", LC.editDistance("abc", "abcd", 3), 1);
  eq("une suppression", LC.editDistance("abcd", "abc", 3), 1);
  /* Une inversion de doigts compte pour UNE faute, pas deux. */
  eq("une transposition", LC.editDistance("abcd", "abdc", 3), 1);
  check("au-delà du budget, on s'arrête", LC.editDistance("abcdefgh", "zzzzzzzz", 2) > 2, "");
  eq("budget d'un mot court", LC.budget(3), 0);
  eq("budget d'un mot moyen", LC.budget(5), 1);
  eq("budget d'un mot long", LC.budget(9), 2);
});

/* ══════════════════════════════════════════════════════════════════════════
   4. LE SCORE D'UN ITEM — LE TITRE PRIME
   ══════════════════════════════════════════════════════════════════════════ */
scenario("4. pondération des champs", () => {
  const item = { title: "Dérivation", subtitle: "Analyse", meta: "12 questions", keywords: ["calcul"] };
  eq("le champ retenu est le titre", LC.scoreItem("derivation", item).field, "title");
  eq("un mot-clé est reconnu", LC.scoreItem("calcul", item).field, "keywords");
  eq("le sous-titre aussi", LC.scoreItem("analyse", item).field, "subtitle");
  eq("la métadonnée aussi", LC.scoreItem("questions", item).field, "meta");

  const parTitre = LC.scoreItem("analyse", { title: "Analyse" }).score;
  const parSousTitre = LC.scoreItem("analyse", { title: "Autre", subtitle: "Analyse" }).score;
  check("à texte égal, le titre l'emporte sur le sous-titre",
    parTitre > parSousTitre, { parTitre, parSousTitre });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. LE REGISTRE — AJOUTER UNE SOURCE NE TOUCHE PAS AU MOTEUR
   ══════════════════════════════════════════════════════════════════════════ */
scenario("5. registre de sources", () => {
  LC.clearSources();
  eq("on démarre sans source", LC.listSources(), []);

  LC.registerSource({ id: "a", category: "A", order: 10, collect: () => [{ title: "Alpha" }] });
  LC.registerSource({ id: "b", category: "B", order: 20, collect: () => [{ title: "Beta" }] });
  eq("deux sources enregistrées", LC.listSources().map(s => s.id), ["a", "b"]);

  /* Ré-enregistrer le même id REMPLACE : au rechargement d'un écran, on ne
     veut pas deux fois les mêmes résultats. */
  LC.registerSource({ id: "a", category: "A", order: 10, collect: () => [{ title: "Alpha bis" }] });
  eq("ré-enregistrer remplace, ça ne duplique pas", LC.listSources().length, 2);
  eq("et c'est bien la nouvelle version", LC.search("alpha").flat[0].item.title, "Alpha bis");

  let leve = false;
  try{ LC.registerSource({ id: "c" }); }catch(e){ leve = true; }
  check("une source sans collect() est refusée", leve, leve);

  /* Une source qui tombe ne doit pas emporter les autres. */
  LC.registerSource({ id: "boom", category: "X", order: 5, collect: () => { throw new Error("panne"); } });
  const r = LC.search("alpha");
  check("une source en panne n'emporte pas la recherche",
    r.flat.some(f => f.item.title === "Alpha bis"), r.flat.map(f => f.item.title));
  LC.clearSources();
});

/* ══════════════════════════════════════════════════════════════════════════
   6. RECHERCHE, CLASSEMENT, REGROUPEMENT
   ══════════════════════════════════════════════════════════════════════════ */
scenario("6. recherche et classement", () => {
  LC.clearSources();
  LC.registerSource({
    id: "pages", category: "pages", order: 10,
    collect: () => [
      { title: "Paramètres", suggested: true },
      { title: "Mes statistiques", suggested: true },
    ],
  });
  LC.registerSource({
    id: "chapters", category: "chapters", order: 20,
    collect: () => [
      { title: "Dérivation", subtitle: "Mathématiques" },
      { title: "Intégration", subtitle: "Mathématiques" },
      { title: "Statistique descriptive", subtitle: "Mathématiques" },
    ],
  });
  LC.registerSource({
    id: "content", category: "content", order: 30,
    collect: () => [
      { title: "Quiz : Dérivation", keywords: ["mathematiques"] },
      { title: "Flashcards : Dérivation", keywords: ["mathematiques"] },
    ],
  });

  /* L'exemple exact de la demande : une matière ramène ses chapitres ET
     leurs contenus. */
  const maths = LC.search("maths");
  check("« maths » trouve quelque chose", maths.total > 0, maths.total);
  const titresMaths = maths.flat.map(f => f.item.title);
  check("il ramène les chapitres de la matière",
    titresMaths.includes("Dérivation") && titresMaths.includes("Intégration"), titresMaths);
  check("et leurs contenus",
    titresMaths.includes("Quiz : Dérivation") && titresMaths.includes("Flashcards : Dérivation"), titresMaths);

  /* Le groupe qui contient le meilleur résultat passe devant. */
  const deriv = LC.search("dérivation");
  eq("le groupe le plus pertinent est en tête", deriv.groups[0].category, "chapters");
  eq("et le meilleur résultat est le premier", deriv.flat[0].item.title, "Dérivation");

  /* « stat » : la page ET le chapitre, chacun dans son groupe. */
  const stat = LC.search("stat");
  const cats = [...new Set(stat.flat.map(f => f.group))];
  check("un même mot peut toucher plusieurs catégories", cats.length >= 2, cats);
  check("chaque résultat annonce sa catégorie",
    stat.flat.every(f => typeof f.group === "string" && f.group.length > 0), stat.flat);

  /* Requête vide : seulement ce que les sources proposent par défaut. */
  const vide = LC.search("");
  check("requête vide : on propose, on ne déverse pas", vide.isEmpty, vide);
  eq("et seulement les entrées marquées comme suggestions",
    vide.flat.map(f => f.item.title), ["Paramètres", "Mes statistiques"]);

  /* Rien ne correspond : zéro résultat, pas un résultat au hasard. */
  const rien = LC.search("zzzzzzzz");
  eq("aucune correspondance : aucun résultat", rien.total, 0);
  eq("et aucun groupe vide n'est renvoyé", rien.groups.length, 0);

  /* Les plafonds sont respectés. */
  const cap = LC.search("mathematiques", { perGroup: 2 });
  check("le plafond par groupe est tenu",
    cap.groups.every(g => g.results.length <= 2), cap.groups.map(g => g.results.length));
  check("et ce qui dépasse est compté",
    cap.groups.some(g => g.truncated > 0), cap.groups.map(g => g.truncated));

  /* La liste à plat suit exactement l'ordre d'affichage : c'est elle que ↑↓
     parcourt, donc elle ne doit pas pouvoir diverger des groupes. */
  const plat = [];
  deriv.groups.forEach(g => g.results.forEach(r => plat.push(r.item.title)));
  eq("la liste à plat suit l'ordre des groupes", deriv.flat.map(f => f.item.title), plat);

  LC.clearSources();
});

/* ══════════════════════════════════════════════════════════════════════════
   7. LE COUP DE POUCE EST BORNÉ
   ══════════════════════════════════════════════════════════════════════════ */
scenario("7. un boost ne renverse pas une correspondance exacte", () => {
  LC.clearSources();
  LC.registerSource({
    id: "s", category: "s", order: 10,
    collect: () => [
      { title: "Dérivation", boost: 0 },
      { title: "Dérivées partielles et applications", boost: 99 },
    ],
  });
  const r = LC.search("dérivation");
  eq("le résultat exact reste premier malgré un boost démesuré",
    r.flat[0].item.title, "Dérivation");
  check("et le score reste borné à 1", r.flat.every(f => f.score <= 1), r.flat.map(f => f.score));
  LC.clearSources();
});

/* ══════════════════════════════════════════════════════════════════════════
   8. VOLUMÉTRIE — LA TOLÉRANCE AUX FAUTES RESTE ABORDABLE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("8. performance sur un corpus réaliste", () => {
  LC.clearSources();
  const gros = [];
  for(let i = 0; i < 1200; i++){
    gros.push({ title: "Chapitre " + i + " — notions et applications",
                subtitle: "Matière " + (i % 40), keywords: ["quiz", "flashcards"] });
  }
  LC.registerSource({ id: "gros", category: "g", order: 10, limit: 8, collect: () => gros });

  const t0 = Date.now();
  for(let k = 0; k < 20; k++) LC.search("aplications");   // faute volontaire
  const ms = (Date.now() - t0) / 20;
  check(`une recherche approximative sur 1200 items prend ${ms.toFixed(1)} ms`, ms < 60, ms);

  const r = LC.search("aplications");
  check("et elle trouve quand même", r.total > 0, r.total);
  LC.clearSources();
});

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
