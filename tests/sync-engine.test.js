/* ============================================================================
   REV-EM — tests de la couche de synchronisation
   ----------------------------------------------------------------------------
   Exécution :  node tests/sync-engine.test.js
   Aucune dépendance, aucun réseau, aucune base : les modules testés sont purs.

   Ce qui est réellement testé, de bout en bout :
       transport factice → adaptateur Brightspace RÉEL (source-adapters.js)
                         → normalisation RÉELLE (content-sources.js)
                         → moteur RÉEL (sync-engine.js)
                         → store mémoire, qui reproduit la contrainte
                           d'unicité (user_id, source, external_id) de la base.

   Ce que ces tests NE prouvent PAS : que l'API Brightspace répond comme le
   transport factice le simule. Cela ne peut être vérifié que contre un vrai
   tenant — voir BRIGHTSPACE_SETUP.md. L'idempotence côté base, elle, est
   prouvée séparément et réellement par supabase/tests/sync_idempotency_tests.sql.
   ============================================================================ */
"use strict";

require("../content-sources.js");
require("../sync-engine.js");
require("../source-adapters.js");

const CS = globalThis.LyonContentSources;
const LyonSync = globalThis.LyonSync;
const SA = globalThis.LyonSourceAdapters;
const RS = LyonSync.RUN_STATUS;

/* ------------------------------------------------------------- mini-harnais */

const results = [];
let currentScenario = "";

function check(label, ok, detail){
  results.push({ scenario: currentScenario, label, ok: !!ok, detail: detail || "" });
}
function eq(label, actual, expected){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? "" : "attendu " + JSON.stringify(expected) + ", obtenu " + JSON.stringify(actual));
}

async function scenario(name, fn){
  currentScenario = name;
  try{ await fn(); }
  catch(e){ check("le scénario s'exécute sans exception", false, String(e && e.stack || e)); }
}

/* ------------------------------------------------- tenant Brightspace factice */

/* Formes volontairement "brutes" (PascalCase D2L) : les normaliseurs réels
   sont donc réellement exercés, pas contournés. */
function course(id, name, extra){
  return Object.assign({ OrgUnit: { Id: id, Name: name, Code: "C" + id } }, extra || {});
}
function mod(id, title, topics, extra){
  return Object.assign({ Type: "module", Id: id, Title: title, Structure: topics || [] }, extra || {});
}
function topic(id, title, url){
  return { Id: id, Title: title, Url: url || ("/content/" + id + ".pdf"), TopicType: 1 };
}

/* Transport factice : joue le rôle de l'Edge Function brightspace-api.
   `faults` permet de simuler des pannes ciblées et reproductibles. */
function makeTransport(tenant, faults){
  faults = faults || {};
  const calls = { courses: 0, content: 0, byCourse: {} };
  const transport = async function(fn, body){
    if(body.op === "courses"){
      calls.courses++;
      if(faults.coursesFailTimes && calls.courses <= faults.coursesFailTimes){
        throw Object.assign(new Error("Réseau indisponible."), { code: "network" });
      }
      return { items: tenant.courses };
    }
    if(body.op === "content"){
      calls.content++;
      const id = String(body.orgUnitId);
      calls.byCourse[id] = (calls.byCourse[id] || 0) + 1;
      const f = faults.content && faults.content[id];
      if(f && calls.byCourse[id] <= (f.times === undefined ? Infinity : f.times)){
        throw Object.assign(new Error(f.message || "Réseau indisponible."), {
          code: f.code || "network",
          retryable: f.retryable,
        });
      }
      return { items: tenant.content[id] || [] };
    }
    throw new Error("op inconnue : " + body.op);
  };
  transport.calls = calls;
  return transport;
}

function baseTenant(){
  return {
    courses: [course(101, "Économie internationale"), course(202, "Stratégie")],
    content: {
      "101": [mod(1001, "Introduction", [topic(9001, "Plan du cours")]),
              mod(1002, "Marchés", [topic(9002, "Chapitre 2")])],
      "202": [mod(2001, "Cadre stratégique", [])],
    },
  };
}

function setup(tenant, opts){
  opts = opts || {};
  const db = opts.db || { containers: [], items: [], seq: 0 };
  const runs = opts.runs || [];
  const transport = opts.transport || makeTransport(tenant, opts.faults);
  const adapter = SA.createBrightspaceAdapter({ transport: transport, contentSources: CS });
  const store = LyonSync.createMemoryStore({ db: db, userId: opts.userId || "A" });
  const journal = LyonSync.createMemoryJournal({ runs: runs, now: opts.now, staleAfterMs: opts.staleAfterMs });
  const engine = LyonSync.createEngine({
    adapter: adapter, store: store, journal: journal,
    sleep: async function(){},           // les réessais n'attendent pas en test
    now: opts.now,
  });
  return { db, runs, store, journal, engine, adapter, transport };
}

const containersOf = db => db.containers;
const itemsOf = db => db.items;

/* ============================================================================
   1. PREMIÈRE SYNCHRONISATION
   ============================================================================ */
async function t1(){
  await scenario("1. première synchronisation", async function(){
    const { db, runs, engine } = setup(baseTenant(), {});
    const rep = await engine.run();

    eq("statut de l'exécution", rep.status, RS.COMPLETED);
    eq("matières créées", rep.counts.containersCreated, 2);
    eq("chapitres créés", rep.counts.itemsCreated, 3);
    eq("aucune suppression", rep.counts.containersRemoved + rep.counts.itemsRemoved, 0);
    eq("lignes en base — matières", containersOf(db).length, 2);
    eq("lignes en base — chapitres", itemsOf(db).length, 3);

    /* Champs obligatoires de tout élément externe. */
    const c = containersOf(db)[0];
    check("chaque matière porte `source`", c.source === "brightspace", c.source);
    check("chaque matière porte `externalId`", String(c.externalId) === "101", c.externalId);
    check("chaque matière porte `userId`", c.userId === "A", c.userId);
    check("chaque matière porte `lastSyncedAt`", !!c.lastSyncedAt, c.lastSyncedAt);
    check("chaque matière porte un statut", c.syncStatus === "active", c.syncStatus);
    check("`sourceUpdatedAt` est présent (null si la source ne le fournit pas)",
      Object.prototype.hasOwnProperty.call(c, "sourceUpdatedAt"), JSON.stringify(c.sourceUpdatedAt));
    check("l'empreinte de contenu est conservée", !!(c.meta && c.meta.fingerprint), JSON.stringify(c.meta));

    const it = itemsOf(db)[0];
    check("chaque chapitre est rattaché à sa matière", !!it.containerId, it.containerId);
    check("les ressources du chapitre sont conservées", Array.isArray(it.resources) && it.resources.length === 1,
      JSON.stringify(it.resources && it.resources.length));

    /* Journal */
    eq("une seule exécution journalisée", runs.length, 1);
    eq("journal : statut final", runs[0].status, RS.COMPLETED);
    eq("journal : curseur effacé une fois terminé", runs[0].cursor, null);
    check("journal : compteurs enregistrés", runs[0].counts.containersCreated === 2, JSON.stringify(runs[0].counts));
  });
}

/* ============================================================================
   2. DEUXIÈME SYNCHRONISATION — rien de neuf
   ============================================================================ */
async function t2(){
  await scenario("2. deuxième synchronisation", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];
    await setup(tenant, { db, runs }).engine.run();
    const rep = await setup(tenant, { db, runs }).engine.run();

    eq("statut", rep.status, RS.COMPLETED);
    eq("aucune création", rep.counts.containersCreated + rep.counts.itemsCreated, 0);
    eq("aucune mise à jour", rep.counts.containersUpdated + rep.counts.itemsUpdated, 0);
    eq("aucune suppression", rep.counts.containersRemoved + rep.counts.itemsRemoved, 0);
    eq("tout est reconnu comme inchangé — matières", rep.counts.containersUnchanged, 2);
    eq("tout est reconnu comme inchangé — chapitres", rep.counts.itemsUnchanged, 3);
    eq("toujours 2 matières", containersOf(db).length, 2);
    eq("toujours 3 chapitres", itemsOf(db).length, 3);
    eq("deux exécutions journalisées", runs.length, 2);
  });
}

/* ============================================================================
   3. DOUBLONS — dix synchronisations, une seule copie
   ============================================================================ */
async function t3(){
  await scenario("3. doublons (10 synchronisations)", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];
    for(let i = 0; i < 10; i++){
      await setup(tenant, { db, runs }).engine.run();
    }
    eq("après 10 synchronisations : 2 matières", containersOf(db).length, 2);
    eq("après 10 synchronisations : 3 chapitres", itemsOf(db).length, 3);

    const ids = containersOf(db).map(c => String(c.externalId)).sort();
    eq("aucun external_id en double", ids, ["101", "202"]);
    eq("dix exécutions journalisées", runs.length, 10);

    /* Idempotence stricte : le même identifiant local est réutilisé. */
    const first = containersOf(db).map(c => c.id).sort();
    await setup(tenant, { db, runs }).engine.run();
    eq("les identifiants locaux ne changent pas", containersOf(db).map(c => c.id).sort(), first);
  });
}

/* ============================================================================
   4. MODIFICATION CÔTÉ SOURCE
   ============================================================================ */
async function t4(){
  await scenario("4. modification", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];
    await setup(tenant, { db, runs }).engine.run();

    /* On simule du contenu pédagogique produit DANS REV-EM : il ne doit jamais
       être écrasé par une resynchronisation. */
    const chap = itemsOf(db).find(i => String(i.externalId) === "1001");
    chap.aiQuiz = [{ q: "question générée" }];
    chap.progress = 42;

    tenant.courses[0].OrgUnit.Name = "Économie internationale (2026)";
    tenant.content["101"][0].Title = "Introduction — révisée";

    const rep = await setup(tenant, { db, runs }).engine.run();

    eq("statut", rep.status, RS.COMPLETED);
    eq("1 matière mise à jour", rep.counts.containersUpdated, 1);
    eq("1 chapitre mis à jour", rep.counts.itemsUpdated, 1);
    eq("aucune création", rep.counts.containersCreated + rep.counts.itemsCreated, 0);
    eq("toujours 2 matières", containersOf(db).length, 2);

    const c = containersOf(db).find(x => String(x.externalId) === "101");
    eq("le nom de la matière suit la source", c.name, "Économie internationale (2026)");
    const c2 = itemsOf(db).find(i => String(i.externalId) === "1001");
    eq("le titre du chapitre suit la source", c2.title, "Introduction — révisée");
    eq("le quiz généré dans REV-EM est intact", c2.aiQuiz, [{ q: "question générée" }]);
    eq("la progression de l'élève est intacte", c2.progress, 42);
    check("last_synced_at est rafraîchi", !!c2.lastSyncedAt, c2.lastSyncedAt);
  });
}

/* ============================================================================
   5. SUPPRESSION CÔTÉ SOURCE — marquée, jamais effacée — puis retour
   ============================================================================ */
async function t5(){
  await scenario("5. suppression puis réapparition", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];
    await setup(tenant, { db, runs }).engine.run();

    const removedCourse = tenant.courses.pop();           // 202 disparaît
    const rep = await setup(tenant, { db, runs }).engine.run();

    eq("statut", rep.status, RS.COMPLETED);
    eq("1 matière signalée disparue", rep.counts.containersRemoved, 1);
    eq("la ligne n'est PAS supprimée", containersOf(db).length, 2);
    const gone = containersOf(db).find(c => String(c.externalId) === "202");
    eq("elle est marquée `removed`", gone.syncStatus, "removed");
    const goneItems = itemsOf(db).filter(i => i.containerId === gone.id);
    eq("ses chapitres existent toujours", goneItems.length, 1);

    /* Une source qui ne renvoie plus rien ne doit pas re-signaler
       indéfiniment la même disparition. */
    const rep2 = await setup(tenant, { db, runs }).engine.run();
    eq("la disparition n'est pas re-signalée", rep2.counts.containersRemoved, 0);

    /* Retour du cours : réactivation, pas duplication. */
    tenant.courses.push(removedCourse);
    const rep3 = await setup(tenant, { db, runs }).engine.run();
    eq("1 matière réactivée", rep3.counts.containersRestored, 1);
    eq("aucune duplication", containersOf(db).length, 2);
    eq("statut revenu à actif",
      containersOf(db).find(c => String(c.externalId) === "202").syncStatus, "active");
  });
}

/* ============================================================================
   6. UTILISATEURS A ET B — aucune fuite entre comptes
   ============================================================================ */
async function t6(){
  await scenario("6. utilisateurs A et B", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };   // même "base" pour les deux
    const runsA = [], runsB = [];

    const a = setup(tenant, { db, runs: runsA, userId: "A" });
    const b = setup(tenant, { db, runs: runsB, userId: "B" });
    await a.engine.run();
    await b.engine.run();

    eq("chaque compte a ses propres lignes", containersOf(db).length, 4);
    eq("A ne voit que les siennes", (await a.store.listContainers("brightspace")).length, 2);
    eq("B ne voit que les siennes", (await b.store.listContainers("brightspace")).length, 2);

    const aIds = (await a.store.listContainers("brightspace")).map(c => c.id);
    const bIds = (await b.store.listContainers("brightspace")).map(c => c.id);
    eq("aucune ligne partagée", aIds.filter(id => bIds.indexOf(id) !== -1), []);

    /* A ne peut pas modifier ni supprimer une ligne de B, même en connaissant
       son identifiant (même règle que les policies RLS côté base). */
    const bRow = containersOf(db).find(c => c.userId === "B");
    const upd = await a.store.updateContainer(bRow.id, { name: "piraté" });
    eq("A ne peut pas modifier une ligne de B", upd, null);
    eq("la ligne de B est intacte", bRow.name, "Économie internationale");
    const del = await a.store.markContainerRemoved(bRow.id);
    eq("A ne peut pas marquer supprimée une ligne de B", del, null);
    eq("le statut de B est intact", bRow.syncStatus, "active");

    /* Une resynchronisation de B ne touche pas les lignes de A. */
    await b.engine.run();
    eq("toujours 4 lignes après resynchronisation de B", containersOf(db).length, 4);
  });
}

/* ============================================================================
   7. INTERRUPTION (annulation en cours d'exécution)
   ============================================================================ */
async function t7(){
  await scenario("7. interruption", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];
    const { engine } = setup(tenant, { db, runs });

    const signal = { aborted: false };
    const rep = await engine.run({
      signal: signal,
      /* On annule juste avant le deuxième cours : l'interruption tombe au
         milieu d'un travail réel, pas avant ou après. */
      onProgress: function(p){ if(p.stage === "container" && p.index === 1) signal.aborted = true; },
    });

    eq("statut", rep.status, RS.CANCELLED);
    eq("le premier cours a bien été importé", rep.counts.itemsCreated, 2);
    check("le second n'a pas été traité", rep.counts.itemsCreated < 3, rep.counts.itemsCreated);
    eq("journal : statut cancelled", runs[0].status, RS.CANCELLED);
    check("journal : le curseur est conservé",
      !!runs[0].cursor && runs[0].cursor.doneKeys.length === 1, JSON.stringify(runs[0].cursor));
    eq("le curseur retient le cours déjà traité", runs[0].cursor.doneKeys, ["101"]);
    check("rien n'a été supprimé", itemsOf(db).length === 2 && containersOf(db).length === 2,
      containersOf(db).length + "/" + itemsOf(db).length);
  });
}

/* ============================================================================
   8. REPRISE APRÈS INTERRUPTION
   ============================================================================ */
async function t8(){
  await scenario("8. reprise", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const runs = [];

    const first = setup(tenant, { db, runs });
    const signal = { aborted: false };
    await first.engine.run({
      signal: signal,
      onProgress: function(p){ if(p.stage === "container" && p.index === 1) signal.aborted = true; },
    });

    const second = setup(tenant, { db, runs });
    const rep = await second.engine.run();

    check("l'exécution est reconnue comme une reprise", rep.resumed === true, String(rep.resumed));
    eq("le cours déjà traité est ignoré", rep.counts.skipped, 1);
    eq("le cours restant est importé", rep.counts.itemsCreated, 1);
    eq("statut final", rep.status, RS.COMPLETED);
    eq("aucun doublon après reprise — matières", containersOf(db).length, 2);
    eq("aucun doublon après reprise — chapitres", itemsOf(db).length, 3);
    eq("le cours ignoré n'a pas été re-téléchargé", second.transport.calls.byCourse["101"], undefined);
    eq("deux exécutions journalisées", runs.length, 2);
    eq("journal : la reprise se termine proprement", runs[1].status, RS.COMPLETED);

    /* Une fois terminée, il n'y a plus rien à reprendre. */
    const third = setup(tenant, { db, runs });
    const rep3 = await third.engine.run();
    eq("la synchronisation suivante ne se croit pas en reprise", rep3.resumed, false);
    eq("et ne saute rien", rep3.counts.skipped, 0);
  });
}

/* ============================================================================
   9. ERREUR RÉSEAU — réessai, import partiel, échec franc
   ============================================================================ */
async function t9(){
  await scenario("9. erreur réseau", async function(){
    /* (a) panne passagère sur un cours : le réessai la rattrape. */
    {
      const tenant = baseTenant();
      const db = { containers: [], items: [], seq: 0 };
      const runs = [];
      const { engine } = setup(tenant, { db, runs, faults: { content: { "202": { times: 1 } } } });
      const rep = await engine.run({ retryAttempts: 3, retryDelayMs: 1 });
      eq("(a) panne passagère : statut", rep.status, RS.COMPLETED);
      eq("(a) un réessai a eu lieu", rep.counts.retries, 1);
      eq("(a) tous les chapitres sont là", itemsOf(db).length, 3);
    }

    /* (b) panne persistante sur un cours : import PARTIEL, le reste passe. */
    {
      const tenant = baseTenant();
      const db = { containers: [], items: [], seq: 0 };
      const runs = [];
      const { engine } = setup(tenant, { db, runs, faults: { content: { "202": {} } } });
      const rep = await engine.run({ retryAttempts: 2, retryDelayMs: 1 });
      eq("(b) statut partiel", rep.status, RS.PARTIAL);
      eq("(b) 1 cours signalé indisponible", rep.counts.unavailable, 1);
      eq("(b) le cours accessible est bien importé", rep.counts.itemsCreated, 2);
      eq("(b) la matière inaccessible n'est pas supprimée", containersOf(db).length, 2);
      eq("(b) elle est marquée `unavailable`",
        containersOf(db).find(c => String(c.externalId) === "202").syncStatus, "unavailable");
      eq("(b) journal : statut partial", runs[0].status, RS.PARTIAL);
      check("(b) le curseur ne retient PAS le cours échoué (il sera réessayé)",
        runs[0].cursor && runs[0].cursor.doneKeys.indexOf("202") === -1,
        JSON.stringify(runs[0].cursor));

      /* Le cours redevient accessible : la synchronisation suivante le rattrape. */
      const ok = setup(tenant, { db, runs });
      const rep2 = await ok.engine.run();
      eq("(b) reprise : le cours est enfin importé", rep2.counts.itemsCreated, 1);
      eq("(b) reprise : statut", rep2.status, RS.COMPLETED);
      eq("(b) reprise : aucun doublon", itemsOf(db).length, 3);
    }

    /* (c) panne sur l'appel initial : échec franc, journalisé, sans dégât. */
    {
      const tenant = baseTenant();
      const db = { containers: [], items: [], seq: 0 };
      const runs = [];
      const { engine } = setup(tenant, { db, runs, faults: { coursesFailTimes: 99 } });
      const rep = await engine.run({ retryAttempts: 2, retryDelayMs: 1 });
      eq("(c) statut", rep.status, RS.FAILED);
      check("(c) le message d'erreur est transmis", /réseau|Réseau/i.test(String(rep.error)), rep.error);
      eq("(c) rien n'a été écrit", containersOf(db).length, 0);
      eq("(c) journal : statut failed", runs[0].status, RS.FAILED);
      check("(c) journal : l'erreur est consignée", !!runs[0].error, runs[0].error);
      eq("(c) 1 réessai avant abandon", rep.counts.retries, 1);
    }

    /* (d) une erreur non réessayable ne perd pas de temps en réessais. */
    {
      const tenant = baseTenant();
      const db = { containers: [], items: [], seq: 0 };
      const runs = [];
      const { engine, transport } = setup(tenant, {
        db, runs,
        faults: { content: { "101": { code: "forbidden", retryable: false, message: "Accès refusé." } } },
      });
      const rep = await engine.run({ retryAttempts: 3, retryDelayMs: 1 });
      eq("(d) aucun réessai sur une erreur d'autorisation", rep.counts.retries, 0);
      eq("(d) un seul appel a été tenté", transport.calls.byCourse["101"], 1);
      eq("(d) statut partiel", rep.status, RS.PARTIAL);
    }
  });
}

/* ============================================================================
   10. CONCURRENCE — pas deux synchronisations en même temps
   ============================================================================ */
async function t10(){
  await scenario("10. exécution concurrente", async function(){
    const tenant = baseTenant();
    const db = { containers: [], items: [], seq: 0 };
    const now = function(){ return new Date(1000000); };

    /* Une exécution ouverte il y a un instant : une seconde doit être refusée. */
    const runs = [{ id: "run0", source: "brightspace", status: RS.STARTED,
                    startedAt: 1000000 - 1000, cursor: null, counts: {} }];
    const rep = await setup(tenant, { db, runs, now }).engine.run();
    eq("une seconde synchronisation est refusée", rep.status, RS.FAILED);
    eq("le motif est explicite", rep.errorCode, "already_running");
    eq("rien n'a été écrit", containersOf(db).length, 0);
    eq("aucune exécution supplémentaire n'est journalisée", runs.length, 1);

    /* La même exécution, restée ouverte trop longtemps (onglet fermé), est
       considérée comme abandonnée et reprise. */
    runs[0].startedAt = 1000000 - (60 * 60 * 1000);
    const rep2 = await setup(tenant, { db, runs, now }).engine.run();
    eq("une exécution abandonnée est reprise, pas bloquée", rep2.status, RS.COMPLETED);
    eq("elle réutilise la même ligne de journal", runs.length, 1);
    eq("et importe bien le contenu", containersOf(db).length, 2);
  });
}

/* ============================================================================
   11. CONTRAT D'ADAPTATEUR — l'abstraction tient sans Brightspace
   ============================================================================ */
async function t11(){
  await scenario("11. abstraction des sources", async function(){
    eq("les sources locales sont enregistrées", SA.list().map(a => a.id).sort(), ["manual", "pdf"]);
    eq("aucune source locale n'est synchronisable", SA.listSyncable().length, 0);
    eq("Moodle n'est PAS implémenté", SA.get("moodle"), null);
    eq("Google Classroom n'est PAS implémenté", SA.get("google-classroom"), null);
    check("les sources prévues sont nommées mais pas disponibles",
      SA.PLANNED.indexOf("moodle") !== -1 && SA.labelOf("moodle").indexOf("non disponible") !== -1,
      SA.labelOf("moodle"));

    /* Un adaptateur incomplet est refusé à la définition, pas à l'exécution. */
    let refused = false;
    try{ SA.defineAdapter({ id: "x", label: "X", syncable: true }); }catch(e){ refused = true; }
    check("un adaptateur synchronisable sans listContainers est refusé", refused);

    /* Une source totalement étrangère à Brightspace fonctionne avec le même
       moteur, sans qu'une ligne du moteur ne change : c'est tout l'objet de
       l'abstraction. */
    const fake = SA.defineAdapter({
      id: "source-test", label: "Source de test", syncable: true,
      listContainers: async function(){
        return [{ source: "source-test", externalId: "z1", name: "Conteneur Z", fingerprint: "f1" }];
      },
      listItems: async function(){
        return [{ source: "source-test", externalId: "z1-a", title: "Élément A", fingerprint: "g1" }];
      },
    });
    const db = { containers: [], items: [], seq: 0 };
    const engine = LyonSync.createEngine({
      adapter: fake,
      store: LyonSync.createMemoryStore({ db: db, userId: "A" }),
      journal: LyonSync.createMemoryJournal({}),
    });
    const rep = await engine.run();
    eq("une source quelconque se synchronise avec le même moteur", rep.status, RS.COMPLETED);
    eq("son contenu est stocké sous SON identifiant de source", db.containers[0].source, "source-test");
    eq("et une deuxième passe ne crée pas de doublon",
      (await engine.run(), db.containers.length), 1);

    /* Sans journal du tout (source locale), le moteur fonctionne quand même. */
    const engineNoJournal = LyonSync.createEngine({
      adapter: fake,
      store: LyonSync.createMemoryStore({ db: { containers: [], items: [], seq: 0 }, userId: "A" }),
    });
    const repNJ = await engineNoJournal.run();
    eq("le moteur fonctionne sans journal", repNJ.status, RS.COMPLETED);
  });
}

/* ============================================================================
   12. NORMALISATION — les champs exigés sont réellement produits
   ============================================================================ */
async function t12(){
  await scenario("12. normalisation et source_updated_at", async function(){
    const withDate = CS.normalizeBrightspaceCourse({
      OrgUnit: { Id: 55, Name: "Avec date", LastModifiedDate: "2026-03-01T10:00:00Z" },
    });
    eq("source_updated_at est lu quand la source le fournit",
      withDate.sourceUpdatedAt, "2026-03-01T10:00:00.000Z");

    const without = CS.normalizeBrightspaceCourse({ OrgUnit: { Id: 56, Name: "Sans date" } });
    eq("il vaut null quand la source ne le fournit pas — jamais une date inventée",
      without.sourceUpdatedAt, null);

    /* L'empreinte ne dépend pas de cette date : un LMS qui la touche sans
       changer le contenu ne doit pas déclencher de fausse mise à jour. */
    const a = CS.normalizeBrightspaceCourse({ OrgUnit: { Id: 57, Name: "N", LastModifiedDate: "2026-01-01T00:00:00Z" } });
    const b = CS.normalizeBrightspaceCourse({ OrgUnit: { Id: 57, Name: "N", LastModifiedDate: "2026-09-09T00:00:00Z" } });
    eq("l'empreinte ignore la date de modification", a.fingerprint, b.fingerprint);

    const c1 = CS.normalizeBrightspaceCourse({ OrgUnit: { Id: 58, Name: "Un" } });
    const c2 = CS.normalizeBrightspaceCourse({ OrgUnit: { Id: 58, Name: "Deux" } });
    check("mais elle change quand le contenu change", c1.fingerprint !== c2.fingerprint,
      c1.fingerprint + " / " + c2.fingerprint);
  });
}

/* ------------------------------------------------------------------ exécution */

(async function(){
  await t1(); await t2(); await t3(); await t4(); await t5(); await t6();
  await t7(); await t8(); await t9(); await t10(); await t11(); await t12();

  let pass = 0, fail = 0, lastScenario = "";
  results.forEach(function(r){
    if(r.scenario !== lastScenario){ console.log("\n=== " + r.scenario + " ==="); lastScenario = r.scenario; }
    console.log((r.ok ? "PASS" : "FAIL") + " — " + r.label + (r.ok ? "" : "  [" + r.detail + "]"));
    r.ok ? pass++ : fail++;
  });
  console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
