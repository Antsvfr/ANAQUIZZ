/* ============================================================================
   REV-EM — persistance multi-appareils : le moteur contre une VRAIE base
   ----------------------------------------------------------------------------
   Ce qui est RÉEL ici :
     • PostgreSQL : les contraintes d'unicité, les clés étrangères, les
       contraintes CHECK, les triggers updated_at ;
     • les policies RLS, évaluées par PostgreSQL avec le rôle `authenticated`
       et un claim `sub` réel — c'est la vraie barrière de sécurité ;
     • le code de user-data.js, chargé tel quel, sans adaptation ;
     • le schéma : schema.sql + les cinq migrations, appliqués pour de bon.

   Ce qui est REMPLACÉ : le transport HTTP de PostgREST (traduit en SQL par
   tests/helpers/pgrest.js) et la vérification de signature du JWT, qui est le
   travail de Supabase Auth et non celui de REV-EM.

   Ce que ces tests NE prouvent PAS : qu'un vrai second APPAREIL retrouve les
   données (il faudrait deux navigateurs et un projet Supabase en ligne). Ce
   qu'ils prouvent, c'est que deux SESSIONS distinctes, avec deux identités
   Supabase distinctes, écrivent et lisent exactement ce qu'elles doivent —
   ce qui est la partie que le code de REV-EM contrôle.

   Prérequis : PostgreSQL démarré (`service postgresql start`) et le module
   `pg` installé (`npm install pg`). La base de test est construite par ce
   fichier, puis détruite.

   Lancer :  node tests/user-data.test.mjs
   ========================================================================== */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const DB = process.env.USERDATA_PG_DATABASE || "revem_userdata_test";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/* ------------------------------------------------------------------ harnais */
let pass = 0, fail = 0, current = "";
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
/* PostgreSQL normalise l'ordre des clés d'un `jsonb` : {front,back} revient
   {back,front}. C'est le même objet, et JSON.stringify est sensible à l'ordre.
   On compare donc sur une sérialisation à clés triées — on vérifie l'égalité
   des données, pas celle de leur écriture. */
const stable = (v) => JSON.stringify(v, (k, val) =>
  (val && typeof val === "object" && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, kk) => { o[kk] = val[kk]; return o; }, {})
    : val);
const eq = (label, actual, expected) =>
  check(label, stable(actual) === stable(expected), { attendu: expected, obtenu: actual });
async function scenario(name, fn) {
  current = name;
  console.log(`\n── ${name} ──`);
  try { await fn(); }
  catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

/* --------------------------------------------------- construction de la base */
/* `psql -c "insert … returning id"` imprime la ligne ET le tag de commande
   (« INSERT 0 1 ») : on ne garde que la première ligne, sinon l'identifiant
   récupéré n'est pas un uuid valide et TOUTES les requêtes suivantes échouent
   — sans que la cause soit visible ailleurs qu'ici. */
function psql(sql, db) {
  return execSync(
    `su postgres -c "psql -tAX -d ${db || DB} -c \\"${sql.replace(/"/g, '\\\\"')}\\""`,
    { encoding: "utf8" }).trim().split("\n")[0].trim();
}
function psqlFile(f) {
  execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=0 -d ${DB} -f ${ROOT}/${f}"`,
    { encoding: "utf8", stdio: "pipe" });
}

console.log("Construction de la base de test…");
execSync(`su postgres -c "dropdb --if-exists ${DB}; createdb ${DB}"`, { stdio: "pipe" });
[
  "supabase/tests/00_local_emulation.sql",
  "supabase/schema.sql",
  "supabase/migrations/001_brightspace.sql",
  "supabase/migrations/002_centralisation.sql",
  "supabase/migrations/003_sync_layer.sql",
  "supabase/migrations/004_oauth_hardening.sql",
  "supabase/migrations/005_user_sync.sql",
].forEach(psqlFile);

/* Un mot de passe pour se connecter en TCP depuis Node. */
execSync(`su postgres -c "psql -q -d ${DB} -c \\"alter role postgres password 'itest_pw'\\""`, { stdio: "pipe" });

const USER_A = psql("insert into auth.users (email) values ('a@test.invalid') returning id");
const USER_B = psql("insert into auth.users (email) values ('b@test.invalid') returning id");

const pool = new Pool({
  host: "127.0.0.1", port: 5432, user: "postgres",
  password: "itest_pw", database: DB, max: 8,
});

/* Chaque requête dans sa propre transaction, avec le RÔLE SQL réel et le
   claim `sub` de l'utilisateur : c'est ce qui fait que les policies RLS
   s'appliquent vraiment, exactement comme en production. */
function runner(jwtSub) {
  return async function run(sql, params) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [jwtSub]);
      await client.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: jwtSub, role: "authenticated" })]);
      const res = await client.query(sql, params);
      await client.query("commit");
      return res.rows;
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      throw e;
    } finally { client.release(); }
  };
}
const asService = async (sql, params) => {
  const client = await pool.connect();
  try { return (await client.query(sql, params)).rows; } finally { client.release(); }
};

const { createPostgrestClient } = require("./helpers/pgrest.js");
const clientFor = (sub) => createPostgrestClient(runner(sub));

/* ------------------------------------------------------- le module sous test */
require("../user-data.js");
const UD = globalThis.LyonUserData;

/* ------------------------------------------------------------ jeu de données */
const DAY = "2026-09-24";
const TS  = "2026-09-24T09:00:00.000Z";

function snapshotA() {
  return {
    subjects: [
      { id: "subj_a1", name: "Analyse financière", semesterId: "s1", icon: "", color: "#E31C3D", description: "" },
      { id: "subj_a2", name: "Droit des affaires", semesterId: "s1", icon: "", color: "#2C5FA8", description: "" },
    ],
    chapters: [
      { id: "ch_a1", subjectId: "subj_a1", num: "1", title: "Bilan", desc: "d", content: "c",
        aiQuiz: [{ q: "?", opts: ["a", "b"], correct: 0 }], aiFlashcards: [{ front: "f", back: "b" }],
        aiReviewQuestions: ["pourquoi ?"], keyNotions: ["actif"], markedReviewed: true },
      { id: "ch_a2", subjectId: "subj_a2", num: "1", title: "Contrats", desc: "", content: "",
        aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [], keyNotions: [] },
      /* Chapitre orphelin : sa matière n'existe pas. Il ne doit PAS être
         poussé avec un rattachement inventé. */
      { id: "ch_orphelin", subjectId: "subj_inconnu", num: "9", title: "Orphelin", aiQuiz: [] },
    ],
    quizProgress:  { "chapter:ch_a1": { best: 80, attempts: 3 } },
    flashProgress: { "chapter:ch_a1": { best: 60, attempts: 2 } },
    qstats: {
      "uid-1": { seen: 4, correct: 1, wrong: 3, streak: 0, last: "ko", lastDate: DAY, history: [1, 0, 0, 0], theme: "Bilan" },
      "uid-2": { seen: 2, correct: 2, wrong: 0, streak: 2, last: "ok", lastDate: DAY, history: [1, 1], theme: "Flux" },
    },
    examHistory: [{ date: TS, dateKey: DAY, total: 10, correct: 7, pct: 70, scopeLabel: "Blanc" }],
    badges: { "premier-quiz": { earnedDate: DAY } },
    aiCards: { ch1: [{ front: "a", back: "b" }] },
    courseData: { "ev-1": { notes: "mes notes", favorite: true } },
    planning: {
      events: [{ id: "ev-1", summary: "Analyse financière", start: 1790000000000, end: 1790003600000 }],
      officialUrl: "https://ics.example.invalid/flux.ics",
      lastSyncAt: 1790000000000,
    },
    aiHistory: [{ q: "explique", a: "voici" }],
    documents: [{ id: "doc_a1", name: "Annales.pdf", type: "sujet", mime: "application/pdf",
                  subjectId: "subj_a1", addedAt: 1789000000000, dataUrl: "data:application/pdf;base64,AAAA" }],
    studyPlan: { id: "plan_a", goal: "Partiel", deadlineAt: 1791000000000, deadlineLabel: "Partiel",
                 subjectIds: ["subj_a1"], chapterIds: ["ch_a1"], availability: { mon: 2 },
                 days: [{ day: DAY, tasks: [{ chapterId: "ch_a1", kind: "quiz" }] }] },
    dash: {
      totalAnswered: 40, totalCorrect: 30, timeSpentSeconds: 3600,
      correctStreak: 3, bestCorrectStreak: 9, quizzesCompleted: 5, best90Achieved: true,
      recentAdds: [{ label: "Analyse financière", ts: 1789000000000 }],
      dailyStats: { [DAY]: { answered: 10, correct: 8 } },
      dailyTimeSeconds: { [DAY]: 900 },
      activityDates: [DAY],
      recentActivity: [{ type: "quiz", label: "Bilan", pct: 80, score: 8, total: 10, ts: TS, date: DAY }],
      recentChapters: [{ chapterId: "ch_a1", type: "quiz", ts: 1790000000000 }],
    },
    prefs: { aiBubbleSide: "right", aiBubbleY: 240, aiModelChoice: "small" },
  };
}

const QUESTION_BY_UID = {
  "uid-1": { id: 0, uid: "uid-1", q: "Que représente le bilan ?", theme: "Bilan" },
  "uid-2": { id: 1, uid: "uid-2", q: "Qu'est-ce qu'un flux ?", theme: "Flux" },
};

const cloudFor = (sub, snap) => UD.createCloud({
  client: clientFor(sub), userId: sub, debounceMs: 0, snapshot: () => snap,
});

try {
  /* ======================================================================
     1. ÉCRITURE COMPLÈTE — TOUT ARRIVE EN BASE
     ====================================================================== */
  await scenario("1. l'espace personnel part en entier vers Supabase", async () => {
    const snap = snapshotA();
    const res = await cloudFor(USER_A, snap).pushAll(snap);
    eq("aucun domaine en erreur", res.errors.map(e => e.domain + " : " + e.error), []);

    const count = async (t) => Number((await asService(`select count(*) from public.${t} where user_id = $1`, [USER_A]))[0].count);
    eq("2 matières", await count("subjects"), 2);
    eq("2 chapitres (l'orphelin n'est pas inventé)", await count("chapters"), 2);
    eq("2 lignes de progression (quiz + flashcards)", await count("progress"), 2);
    eq("2 statistiques de question", await count("question_stats"), 2);
    eq("1 examen", await count("exam_history"), 1);
    eq("1 réussite", await count("badges"), 1);
    eq("1 lot de flashcards IA", await count("ai_cards"), 1);
    eq("1 note de cours", await count("course_notes"), 1);
    eq("1 événement d'emploi du temps", await count("planning_events"), 1);
    eq("1 historique IA", await count("ai_history"), 1);
    eq("1 ligne de préférences", await count("preferences"), 1);
    eq("1 document (métadonnées)", await count("documents"), 1);
    eq("1 plan de révision", await count("study_plans"), 1);
    eq("1 ligne de compteurs", await count("user_stats"), 1);
    eq("1 jour de statistiques", await count("daily_stats"), 1);
    eq("1 activité", await count("activities"), 1);
    eq("1 chapitre récemment ouvert", await count("chapter_visits"), 1);

    /* Le rattachement du chapitre est une VRAIE clé étrangère, résolue. */
    const fk = await asService(
      `select c.title, s.local_id from public.chapters c join public.subjects s on s.id = c.subject_id
        where c.user_id = $1 order by c.title`, [USER_A]);
    eq("chaque chapitre pointe vers la bonne matière",
      fk.map(r => r.title + "→" + r.local_id), ["Bilan→subj_a1", "Contrats→subj_a2"]);

    /* Le binaire du document n'est JAMAIS parti. */
    const cols = await asService(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='documents'`, []);
    const names = cols.map(c => c.column_name);
    /* `has_local_content` est un BOOLÉEN qui dit où est le fichier : ce n'est
       pas une colonne de contenu, c'est ce qui permet de ne pas en avoir. */
    check("aucune colonne de contenu binaire sur documents",
      !names.some(n => /^(data_url|content|blob|binary|file_data)$/.test(n)), names);
  });

  /* ======================================================================
     2. RELECTURE — L'ESPACE REVIENT IDENTIQUE
     ====================================================================== */
  await scenario("2. une autre session du même compte retrouve tout", async () => {
    /* Un appareil vierge : aucun cache local. */
    const { snapshot: got, errors } = await cloudFor(USER_A, {}).pullAll({});
    eq("aucun domaine en erreur", errors.map(e => e.domain), []);

    eq("les matières", got.subjects.map(s => s.id + ":" + s.name).sort(),
      ["subj_a1:Analyse financière", "subj_a2:Droit des affaires"]);
    eq("les chapitres, rattachés à leur matière locale",
      got.chapters.map(c => c.id + "→" + c.subjectId).sort(), ["ch_a1→subj_a1", "ch_a2→subj_a2"]);
    const bilan = got.chapters.find(c => c.id === "ch_a1");
    eq("le quiz IA du chapitre", bilan.aiQuiz, [{ q: "?", opts: ["a", "b"], correct: 0 }]);
    eq("ses flashcards IA", bilan.aiFlashcards, [{ front: "f", back: "b" }]);
    eq("ses questions de révision", bilan.aiReviewQuestions, ["pourquoi ?"]);
    eq("ses notions clés", bilan.keyNotions, ["actif"]);
    check("son état « révisé »", bilan.markedReviewed === true, bilan.markedReviewed);

    eq("la progression quiz", got.quizProgress, { "chapter:ch_a1": { best: 80, attempts: 3 } });
    eq("la progression flashcards", got.flashProgress, { "chapter:ch_a1": { best: 60, attempts: 2 } });
    eq("la maîtrise par question", Object.keys(got.qstats).sort(), ["uid-1", "uid-2"]);
    eq("le détail d'une question", got.qstats["uid-1"].history, [1, 0, 0, 0]);
    eq("l'historique d'examens", got.examHistory.map(e => e.pct), [70]);
    eq("les réussites", got.badges, { "premier-quiz": { earnedDate: DAY } });
    eq("les flashcards IA du programme", got.aiCards, { ch1: [{ front: "a", back: "b" }] });
    eq("les notes de cours", got.courseData["ev-1"].notes, "mes notes");
    eq("l'emploi du temps", got.planningEvents.map(e => e.summary), ["Analyse financière"]);
    eq("l'URL du flux", got.planningOfficialUrl, "https://ics.example.invalid/flux.ics");
    eq("la date du dernier import", got.planningLastSyncAt, 1790000000000);
    eq("l'historique IA", got.aiHistory, [{ q: "explique", a: "voici" }]);
    eq("les préférences", got.prefs, { aiBubbleSide: "right", aiBubbleY: 240, aiModelChoice: "small" });
    eq("le plan de révision", got.studyPlan.goal, "Partiel");
    eq("ses jours", got.studyPlan.days.length, 1);

    eq("les compteurs", [got.userStats.totalAnswered, got.userStats.totalCorrect,
                         got.userStats.timeSpentSeconds, got.userStats.bestCorrectStreak,
                         got.userStats.quizzesCompleted, got.userStats.best90Achieved],
                        [40, 30, 3600, 9, 5, true]);
    eq("les statistiques du jour", got.dailyStats[DAY], { answered: 10, correct: 8 });
    eq("le temps du jour", got.dailyTimeSeconds[DAY], 900);
    eq("les jours actifs", got.activityDates, [DAY]);
    eq("le journal d'activité", got.recentActivity.map(a => a.type + ":" + a.pct), ["quiz:80"]);
    eq("les chapitres récemment ouverts", got.recentChapters.map(c => c.chapterId), ["ch_a1"]);

    /* Le document est listé, et son absence de contenu est DITE. */
    eq("le document est retrouvé", got.documents.map(d => d.name), ["Annales.pdf"]);
    check("et son contenu manquant est signalé, pas masqué",
      got.documents[0].contentMissing === true, got.documents[0]);
    eq("il reste rattaché à sa matière", got.documents[0].subjectId, "subj_a1");
  });

  /* ======================================================================
     2 bis. LE CONTENU LOCAL D'UN DOCUMENT N'EST JAMAIS ÉCRASÉ
     ====================================================================== */
  await scenario("2 bis. se connecter n'efface pas ses propres fichiers", async () => {
    const local = { documents: [{ id: "doc_a1", name: "Annales.pdf", dataUrl: "data:application/pdf;base64,AAAA" }] };
    const { snapshot: got } = await cloudFor(USER_A, {}).pullAll(local);
    eq("le binaire présent sur l'appareil est conservé",
      got.documents[0].dataUrl, "data:application/pdf;base64,AAAA");
    check("et rien n'est signalé comme manquant",
      got.documents[0].contentMissing === undefined, got.documents[0]);
  });

  /* ======================================================================
     3. IDEMPOTENCE — DIX ÉCRITURES, UNE COPIE
     ====================================================================== */
  await scenario("3. pousser dix fois ne duplique rien", async () => {
    const snap = snapshotA();
    for (let i = 0; i < 9; i++) await cloudFor(USER_A, snap).pushAll(snap);
    const n = async (t) => Number((await asService(`select count(*) from public.${t} where user_id=$1`, [USER_A]))[0].count);
    eq("matières", await n("subjects"), 2);
    eq("chapitres", await n("chapters"), 2);
    eq("progression", await n("progress"), 2);
    eq("statistiques de question", await n("question_stats"), 2);
    eq("examens", await n("exam_history"), 1);
    eq("activités", await n("activities"), 1);
    eq("jours", await n("daily_stats"), 1);
    eq("documents", await n("documents"), 1);
    eq("événements", await n("planning_events"), 1);
  });

  /* ======================================================================
     4. ISOLATION — UTILISATEUR A ≠ UTILISATEUR B
     ====================================================================== */
  await scenario("4. B ne voit rien de A, et réciproquement", async () => {
    const empty = await cloudFor(USER_B, {}).pullAll({});
    eq("B ne lit aucune matière de A", empty.snapshot.subjects, []);
    eq("B ne lit aucun chapitre de A", empty.snapshot.chapters, []);
    eq("B ne lit aucune progression de A", empty.snapshot.quizProgress, {});
    eq("B ne lit aucune statistique de A", empty.snapshot.qstats, {});
    eq("B ne lit aucun examen de A", empty.snapshot.examHistory, []);
    eq("B ne lit aucun document de A", empty.snapshot.documents, []);
    eq("B n'hérite d'aucun compteur de A", empty.snapshot.userStats.totalAnswered, 0);
    eq("ni d'aucun jour actif", empty.snapshot.activityDates, []);
    eq("ni du plan de révision de A", empty.snapshot.studyPlan, null);

    /* B crée son propre espace. */
    const snapB = {
      subjects: [{ id: "subj_b1", name: "Marketing", semesterId: "s1" }],
      chapters: [{ id: "ch_b1", subjectId: "subj_b1", num: "1", title: "Segmentation", aiQuiz: [] }],
      dash: { totalAnswered: 7, dailyStats: {}, dailyTimeSeconds: {}, activityDates: [], recentActivity: [], recentChapters: [] },
    };
    await cloudFor(USER_B, snapB).pushAll(snapB);

    const backA = await cloudFor(USER_A, {}).pullAll({});
    eq("A ne voit pas la matière de B", backA.snapshot.subjects.map(s => s.name).sort(),
      ["Analyse financière", "Droit des affaires"]);
    eq("les compteurs de A n'ont pas bougé", backA.snapshot.userStats.totalAnswered, 40);

    const backB = await cloudFor(USER_B, {}).pullAll({});
    eq("B retrouve la sienne", backB.snapshot.subjects.map(s => s.name), ["Marketing"]);
    eq("et son chapitre", backB.snapshot.chapters.map(c => c.title), ["Segmentation"]);
  });

  /* ======================================================================
     5. RLS — UN user_id FALSIFIÉ NE PASSE PAS
     ====================================================================== */
  await scenario("5. falsifier user_id depuis le navigateur échoue", async () => {
    const cA = clientFor(USER_A);

    const ins = await cA.from("subjects")
      .upsert([{ user_id: USER_B, local_id: "vol", name: "Volée", source: "manual" }], { onConflict: "user_id,local_id" })
      .select();
    check("A ne peut pas écrire une matière au nom de B", !!ins.error, ins.error || ins.data);

    const insStats = await cA.from("user_stats")
      .upsert([{ user_id: USER_B, total_answered: 9999 }], { onConflict: "user_id" }).select();
    check("ni gonfler les compteurs de B", !!insStats.error, insStats.error || insStats.data);

    /* Lire en demandant explicitement les lignes de B ne renvoie rien : la
       policy filtre côté base, le filtre du client n'y est pour rien. */
    const read = await cA.from("subjects").select("*").eq("user_id", USER_B);
    eq("lire les matières de B renvoie zéro ligne", (read.data || []).length, 0);

    const del = await cA.from("subjects").delete().eq("user_id", USER_B).select();
    eq("supprimer celles de B n'en supprime aucune", (del.data || []).length, 0);

    const stillB = Number((await asService("select count(*) from public.subjects where user_id=$1", [USER_B]))[0].count);
    eq("B a toujours sa matière", stillB, 1);
  });

  /* ======================================================================
     6. SUPPRESSIONS — CE QUI DISPARAÎT, ET CE QUI NE DOIT PAS
     ====================================================================== */
  await scenario("6. supprimer ici supprime là-bas, sans casser ailleurs", async () => {
    const snap = snapshotA();
    const cloud = cloudFor(USER_A, snap);
    await cloud.pullAll({});                       // l'appareil apprend les clés existantes

    snap.subjects = snap.subjects.filter(s => s.id !== "subj_a2");
    snap.chapters = snap.chapters.filter(c => c.id !== "ch_a2");
    cloud.push(["subjects", "chapters"]);
    await cloud.flush();

    const left = await asService("select local_id from public.subjects where user_id=$1 order by local_id", [USER_A]);
    eq("la matière supprimée a disparu de la base", left.map(r => r.local_id), ["subj_a1"]);
    const chs = await asService("select local_id from public.chapters where user_id=$1 order by local_id", [USER_A]);
    eq("son chapitre aussi", chs.map(r => r.local_id), ["ch_a1"]);

    /* Une matière créée AILLEURS après notre dernier pull ne doit jamais être
       supprimée par un appareil qui en ignore l'existence. */
    await asService(
      `insert into public.subjects (user_id, local_id, name, source) values ($1,'subj_autre','Créée ailleurs','manual')`,
      [USER_A]);
    cloud.push("subjects");
    await cloud.flush();
    const after = await asService("select local_id from public.subjects where user_id=$1 order by local_id", [USER_A]);
    eq("la matière d'un autre appareil survit", after.map(r => r.local_id), ["subj_a1", "subj_autre"]);

    /* Un journal ne perd jamais une ligne passée. */
    snap.examHistory = [];
    cloud.push("examHistory");
    await cloud.flush();
    const exams = Number((await asService("select count(*) from public.exam_history where user_id=$1", [USER_A]))[0].count);
    eq("l'historique d'examens n'est jamais amputé", exams, 1);
  });

  /* ======================================================================
     7. CONFLITS — UN COMPTEUR NE REDESCEND PAS
     ====================================================================== */
  await scenario("7. un appareil en retard ne fait pas reculer les compteurs", async () => {
    const enRetard = {
      dash: {
        totalAnswered: 12, totalCorrect: 9, timeSpentSeconds: 600,
        correctStreak: 1, bestCorrectStreak: 2, quizzesCompleted: 1, best90Achieved: false,
        dailyStats: { [DAY]: { answered: 2, correct: 1 } },
        dailyTimeSeconds: { [DAY]: 60 },
        activityDates: [DAY], recentActivity: [], recentChapters: [],
      },
    };
    const cloud = cloudFor(USER_A, enRetard);
    cloud.push(["userStats", "dailyStats"]);
    await cloud.flush();

    const s = (await asService("select * from public.user_stats where user_id=$1", [USER_A]))[0];
    eq("questions répondues : le maximum est conservé", Number(s.total_answered), 40);
    eq("bonnes réponses aussi", Number(s.total_correct), 30);
    eq("temps passé aussi", Number(s.time_spent_seconds), 3600);
    eq("meilleure série aussi", Number(s.best_correct_streak), 9);
    eq("quiz terminés aussi", Number(s.quizzes_completed), 5);
    check("« 90 % atteint » ne se reperd pas", s.best90_achieved === true, s.best90_achieved);
    /* La série EN COURS, elle, n'est pas monotone : elle suit la dernière
       écriture, et c'est le comportement voulu. */
    eq("la série en cours suit le dernier appareil", Number(s.correct_streak), 1);

    const d = (await asService("select * from public.daily_stats where user_id=$1 and day=$2", [USER_A, DAY]))[0];
    eq("la journée garde son maximum de réponses", Number(d.answered), 10);
    eq("et son maximum de temps", Number(d.time_seconds), 900);
  });

  /* ======================================================================
     8. RECONSTRUCTION DES ERREURS RÉCENTES
     ====================================================================== */
  await scenario("8. les erreurs récentes sont reconstruites, pas inventées", async () => {
    const { snapshot: got } = await cloudFor(USER_A, {}).pullAll({});
    const wrong = UD.rebuildWrongQuestions(got.qstats, QUESTION_BY_UID);
    eq("seule la question dont la dernière réponse est fausse est listée", Object.keys(wrong), ["0"]);
    eq("le nombre d'échecs consécutifs est exact", wrong[0].wrongCount, 3);
    eq("le thème est celui de la question", wrong[0].theme, "Bilan");
    eq("le libellé vient du programme", wrong[0].q, "Que représente le bilan ?");
    eq("la date du dernier échec est reprise", wrong[0].lastWrong, DAY);

    eq("sans le programme, rien n'est inventé", UD.rebuildWrongQuestions(got.qstats, null), {});
    eq("une question inconnue du programme est ignorée",
      UD.rebuildWrongQuestions({ "uid-inconnu": { last: "ko", history: [0] } }, QUESTION_BY_UID), {});
  });

  /* ======================================================================
     9. RÉSISTANCE — UNE PANNE NE FAIT PAS PERDRE L'ÉCRITURE
     ====================================================================== */
  await scenario("9. une panne réseau ne perd pas la modification", async () => {
    let allow = false;
    const brokenClient = {
      from(table) {
        if (!allow) {
          const boom = { error: { message: "réseau indisponible" }, data: null };
          const b = { select: () => b, upsert: () => b, delete: () => b, eq: () => b, in: () => b,
                      then: (r) => Promise.resolve(boom).then(r) };
          return b;
        }
        return clientFor(USER_A).from(table);
      },
    };
    const snap = snapshotA();
    const cloud = UD.createCloud({ client: brokenClient, userId: USER_A, debounceMs: 0, snapshot: () => snap });

    cloud.push("subjects");
    const first = await cloud.flush();
    check("l'écriture échoue proprement, sans exception", first.ok === false, first);
    eq("et le domaine reste en attente", first.pending, ["subjects"]);

    allow = true;
    const second = await cloud.flush();
    check("la tentative suivante passe", second.ok === true, second);
    eq("plus rien en attente", second.pending, []);
  });

  /* ======================================================================
     10. AUCUNE INVENTION DE DONNÉE
     ====================================================================== */
  await scenario("10. ce qui est absent reste absent", async () => {
    const vide = {
      subjects: [], chapters: [], quizProgress: {}, flashProgress: {}, qstats: {},
      examHistory: [], badges: {}, aiCards: {}, courseData: {}, documents: [],
      planning: { events: [], officialUrl: "", lastSyncAt: null },
      aiHistory: [], studyPlan: null,
      dash: { dailyStats: {}, dailyTimeSeconds: {}, activityDates: [], recentActivity: [], recentChapters: [] },
      prefs: {},
    };
    const c = cloudFor(USER_B, vide);
    /* B avait une matière : on la laisse, on ne pousse que les préférences. */
    c.push("prefs");
    await c.flush();
    const p = (await asService("select * from public.preferences where user_id=$1", [USER_B]))[0];
    eq("aucun côté de bulle inventé", p.ai_bubble_side, null);
    eq("aucun modèle IA inventé", p.ai_model_choice, null);
    eq("aucune URL de flux inventée", p.planning_official_url, null);
    eq("aucune date de synchronisation inventée", p.planning_last_sync_at, null);

    /* Une activité sans pourcentage ne doit pas en recevoir un. */
    const snapAct = { dash: { recentActivity: [{ type: "oral", ts: "2026-09-25T10:00:00.000Z", date: "2026-09-25" }],
                              dailyStats: {}, dailyTimeSeconds: {}, activityDates: [], recentChapters: [] } };
    const c2 = cloudFor(USER_B, snapAct);
    c2.push("activities");
    await c2.flush();
    const a = (await asService("select * from public.activities where user_id=$1 and type='oral'", [USER_B]))[0];
    check("une activité sans score n'en reçoit pas", a && a.pct === null && a.score === null, a);
  });

  /* ======================================================================
     11. LES CONTENUS IMPORTÉS D'UN LMS NE SONT PAS ÉCRASÉS
     ====================================================================== */
  await scenario("11. une matière importée n'est pas réécrite par le cache local", async () => {
    await asService(
      `insert into public.subjects (user_id, name, source, external_id, external_type, sync_status)
       values ($1, 'Éco importée', 'brightspace', 'D2L-101', 'course', 'active')`, [USER_A]);

    const cloud = cloudFor(USER_A, snapshotA());
    const pulled = await cloud.pullAll({});
    check("elle est bien LUE par l'appareil",
      pulled.snapshot.subjects.some(s => s.name === "Éco importée" && s.source === "brightspace"),
      pulled.snapshot.subjects.map(s => s.name));

    /* On repousse l'instantané local, qui ne la contient pas sous cette forme. */
    const snap = snapshotA();
    const c2 = cloudFor(USER_A, snap);
    await c2.pullAll({});
    c2.push("subjects");
    await c2.flush();

    const row = (await asService(
      `select external_id, sync_status, source from public.subjects
        where user_id=$1 and source='brightspace'`, [USER_A]))[0];
    check("son rattachement à la source est intact",
      row && row.external_id === "D2L-101" && row.sync_status === "active", row);
    const n = Number((await asService(
      "select count(*) from public.subjects where user_id=$1 and source='brightspace'", [USER_A]))[0].count);
    eq("et elle n'a pas été dupliquée", n, 1);
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception hors scénario : ${(e && e.stack) || e}`);
} finally {
  await pool.end();
  try { execSync(`su postgres -c "dropdb --if-exists ${DB}"`, { stdio: "pipe" }); } catch (_) {}
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
