/* ============================================================================
   REV-EM — moteur de synchronisation générique
   ----------------------------------------------------------------------------
   Fichier autonome, chargé comme content-sources.js / smart-revision.js /
   statistics.js / planning.js. `window.LyonSync` n'a AUCUNE dépendance au DOM,
   à l'état de l'application, au réseau, à Supabase ni à WebLLM.

   Ce module ne connaît PAS Brightspace. Il ne connaît que trois contrats :

       ExternalSource                    (le LMS, hors de notre portée)
             |
             v
       SourceAdapter    .listContainers() / .listItems()   → source-adapters.js
             |
             v
       NormalizedData   { source, externalId, fingerprint, … }
             |
             v
       SyncEngine       ce fichier : diff, retry, curseur, journal
             |
             v
       Store            .createContainer() / .updateItem() / …
             |
             v
       Supabase         createSupabaseStore() / createSupabaseJournal()
             |
             v
       REV-EM           l'état local est réhydraté depuis Supabase

   Ajouter Moodle ou Google Classroom un jour = écrire un adaptateur
   (deux fonctions) et l'enregistrer. Aucune ligne de ce fichier ne bouge, et
   aucune ligne d'index.html non plus.

   CE QUE LE MOTEUR GARANTIT
     • Idempotence : synchroniser dix fois le même cours laisse UNE copie.
       Deux barrières indépendantes — le diff par external_id, et l'upsert sur
       la contrainte unique (user_id, source, external_id) côté base.
     • Aucune suppression : un contenu disparu de la source est MARQUÉ
       `removed`, jamais effacé. Les fiches, quiz, flashcards et statistiques
       produits dans REV-EM appartiennent à l'élève, pas à la source.
     • Aucune écriture hors des champs venant de la source : une
       resynchronisation ne peut pas détruire le travail de l'élève.
     • Reprise : le curseur est écrit après CHAQUE conteneur traité. Une
       interruption ne fait jamais tout recommencer.
     • Journal : started / completed / partial / failed / cancelled.

   CE QUE LE MOTEUR NE FAIT PAS
     • aucun appel réseau lui-même (c'est l'adaptateur) ;
     • aucun rendu, aucun toast, aucun accès au DOM ;
     • aucune suppression de données, jamais ;
     • il ne lève pas d'exception depuis run() : il retourne toujours un
       rapport, y compris en cas d'échec — l'appelant affiche, il ne devine pas.
   ============================================================================ */
(function(global){
  "use strict";

  /* États d'une exécution, identiques côté SQL (sync_runs.status,
     contrainte CHECK — voir la migration 003). */
  const RUN_STATUS = {
    STARTED:   "started",
    COMPLETED: "completed",
    PARTIAL:   "partial",
    FAILED:    "failed",
    CANCELLED: "cancelled",
  };

  /* États d'un élément synchronisé, identiques à LyonContentSources.SYNC_STATUS
     et aux contraintes CHECK sur subjects.sync_status / chapters.sync_status. */
  const ITEM_STATUS = {
    ACTIVE:      "active",
    MODIFIED:    "modified",
    REMOVED:     "removed",
    UNAVAILABLE: "unavailable",
  };

  const CANCELLED_CODE = "sync/cancelled";

  /* ---------------------------------------------------------------- erreurs */

  function makeError(code, message, extra){
    const e = new Error(message || code);
    e.code = code;
    if(extra) Object.keys(extra).forEach(k => { e[k] = extra[k]; });
    return e;
  }

  function isCancellation(e){
    return !!e && e.code === CANCELLED_CODE;
  }

  /* Une erreur vaut-elle la peine d'être retentée ?
     Par défaut : ce que l'appelant a explicitement marqué `retryable`, les
     coupures réseau, et les codes HTTP qui signifient "réessaie plus tard".
     Jamais une erreur d'autorisation ou de validation : la réessayer ne ferait
     que perdre du temps et masquer le vrai problème. */
  function defaultIsRetryable(e){
    if(!e || isCancellation(e)) return false;
    if(e.retryable === true) return true;
    if(e.retryable === false) return false;
    const code = String(e.code || "").toLowerCase();
    if(code === "network" || code === "timeout" || code === "fetch_failed"
       || code === "econnreset" || code === "etimedout") return true;
    const status = Number(e.status || e.statusCode || 0);
    if(status === 408 || status === 429 || status >= 500) return true;
    // fetch() rejette avec un TypeError quand la connexion est coupée.
    return e.name === "TypeError" && /fetch|network|réseau/i.test(String(e.message || ""));
  }

  function defaultSleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* Réessai avec attente exponentielle (500ms, 1s, 2s…).
     `sleep` est injectable : les tests n'attendent rien réellement.
     `checkpoint` est appelé avant chaque tentative pour qu'une annulation
     interrompe la boucle au lieu d'attendre la fin des réessais. */
  async function withRetry(fn, opts){
    opts = opts || {};
    const attempts = Math.max(1, opts.attempts === undefined ? 3 : opts.attempts);
    const base = opts.baseDelayMs === undefined ? 500 : opts.baseDelayMs;
    const sleep = opts.sleep || defaultSleep;
    const retryable = opts.isRetryable || defaultIsRetryable;
    const onRetry = opts.onRetry || function(){};
    let last = null;

    for(let attempt = 1; attempt <= attempts; attempt++){
      if(opts.checkpoint) opts.checkpoint();
      try{
        return await fn(attempt);
      }catch(e){
        last = e;
        if(isCancellation(e)) throw e;
        if(attempt >= attempts || !retryable(e)) throw e;
        onRetry(e, attempt);
        await sleep(base * Math.pow(2, attempt - 1));
      }
    }
    throw last;
  }

  /* ---------------------------------------------------------------- compteurs */

  function emptyCounts(){
    return {
      containersCreated: 0, containersUpdated: 0, containersRestored: 0,
      containersRemoved: 0, containersUnchanged: 0,
      itemsCreated: 0, itemsUpdated: 0, itemsRestored: 0,
      itemsRemoved: 0, itemsUnchanged: 0,
      unavailable: 0, skipped: 0, retries: 0,
    };
  }

  /* --------------------------------------------------------------- le moteur */

  /* deps :
       adapter  (obligatoire) — voir source-adapters.js
       store    (obligatoire) — createSupabaseStore() ou createMemoryStore()
       journal  (optionnel)   — createSupabaseJournal() ou createMemoryJournal()
       diff     (optionnel)   — LyonContentSources.diffCollections par défaut
       now, sleep             — injectables pour les tests */
  function createEngine(deps){
    deps = deps || {};
    const adapter = deps.adapter;
    const store   = deps.store;
    const journal = deps.journal || createNullJournal();
    const diff    = deps.diff
      || (global.LyonContentSources && global.LyonContentSources.diffCollections);
    const now     = deps.now || function(){ return new Date(); };
    const sleep   = deps.sleep || defaultSleep;

    if(!adapter)                  throw new Error("LyonSync.createEngine : adaptateur manquant.");
    if(!adapter.id)               throw new Error("LyonSync.createEngine : l'adaptateur n'a pas d'id.");
    if(!store)                    throw new Error("LyonSync.createEngine : store manquant.");
    if(typeof diff !== "function") throw new Error("LyonSync.createEngine : diffCollections indisponible (content-sources.js chargé ?).");

    const source = adapter.id;

    async function run(options){
      options = options || {};
      const onProgress = options.onProgress || function(){};
      const counts = emptyCounts();
      const retryOpts = {
        attempts:    options.retryAttempts === undefined ? 3 : options.retryAttempts,
        baseDelayMs: options.retryDelayMs  === undefined ? 500 : options.retryDelayMs,
        sleep: sleep,
        isRetryable: options.isRetryable || defaultIsRetryable,
        onRetry: function(){ counts.retries++; },
      };

      let cursor  = { containersDone: false, doneKeys: [] };
      let runId   = null;
      let resumed = false;
      let partial = false;

      /* Annulation : on accepte un AbortSignal (.aborted booléen) comme un
         simple objet { aborted: true }, ou une fonction isCancelled(). */
      function cancelled(){
        if(typeof options.isCancelled === "function" && options.isCancelled()) return true;
        const s = options.signal;
        if(!s) return false;
        return typeof s.aborted === "function" ? !!s.aborted() : !!s.aborted;
      }
      function checkpoint(){
        if(cancelled()) throw makeError(CANCELLED_CODE, "Synchronisation annulée.");
      }
      const retry = Object.assign({ checkpoint: checkpoint }, retryOpts);

      function emit(stage, extra){
        try{
          onProgress(Object.assign({ stage: stage, source: source, counts: Object.assign({}, counts) }, extra || {}));
        }catch(e){ /* un rendu qui échoue ne doit jamais casser la synchro */ }
      }

      function report(status, error){
        return {
          status: status,
          ok: status === RUN_STATUS.COMPLETED,
          source: source,
          runId: runId,
          resumed: resumed,
          counts: Object.assign({}, counts),
          cursor: { containersDone: cursor.containersDone, doneKeys: cursor.doneKeys.slice() },
          error: error ? String(error.message || error) : null,
          errorCode: error ? (error.code || null) : null,
        };
      }

      /* Le journal ne doit jamais faire échouer la synchronisation : une
         écriture de télémétrie qui rate est moins grave que l'import perdu. */
      async function safeJournal(fnName, a, b){
        if(!journal || typeof journal[fnName] !== "function") return null;
        try{ return await journal[fnName](a, b); }catch(e){ return null; }
      }

      async function saveCursor(){
        await safeJournal("progress", runId, { cursor: cursor, counts: counts });
      }

      /* Payloads : UNIQUEMENT des champs qui viennent de la source.
         C'est ce qui garantit qu'une resynchronisation ne touche ni la fiche,
         ni le quiz, ni les flashcards, ni la progression. */
      function containerPayload(remote){
        return {
          source: source,
          externalId: String(remote.externalId),
          externalType: remote.externalType || null,
          name: remote.name || remote.title || "",
          description: remote.description || null,
          sourceUpdatedAt: remote.sourceUpdatedAt || null,
          syncStatus: ITEM_STATUS.ACTIVE,
          lastSyncedAt: now().toISOString(),
          meta: Object.assign(
            { fingerprint: remote.fingerprint || null },
            typeof adapter.containerMeta === "function" ? (adapter.containerMeta(remote) || {}) : {}
          ),
        };
      }

      function itemPayload(remote, containerId, position){
        return {
          containerId: containerId,
          source: source,
          externalId: String(remote.externalId),
          externalType: remote.externalType || null,
          title: remote.title || remote.name || "",
          description: remote.description || null,
          order: remote.order === undefined ? null : remote.order,
          position: position,
          resources: Array.isArray(remote.resources) ? remote.resources : [],
          sourceUpdatedAt: remote.sourceUpdatedAt || null,
          syncStatus: ITEM_STATUS.ACTIVE,
          lastSyncedAt: now().toISOString(),
          meta: Object.assign(
            { fingerprint: remote.fingerprint || null },
            typeof adapter.itemMeta === "function" ? (adapter.itemMeta(remote) || {}) : {}
          ),
        };
      }

      try{
        /* ---- reprise d'une exécution interrompue ------------------------- */
        if(options.resume !== false){
          const prev = await safeJournal("findResumable", source);
          if(prev){
            if(prev.status === RUN_STATUS.STARTED && !prev.stale && options.force !== true){
              /* Une autre exécution est réellement en cours (autre onglet,
                 autre appareil) : on ne lance pas un second import concurrent. */
              return report(RUN_STATUS.FAILED, makeError(
                "already_running",
                "Une synchronisation est déjà en cours pour ce compte."
              ));
            }
            if(prev.cursor && Array.isArray(prev.cursor.doneKeys)){
              cursor = {
                containersDone: !!prev.cursor.containersDone,
                doneKeys: prev.cursor.doneKeys.slice(),
              };
              resumed = cursor.doneKeys.length > 0 || cursor.containersDone;
            }
            /* Exécution interrompue et périmée : on la reprend telle quelle
               plutôt que d'en ouvrir une seconde (l'index unique l'interdit
               de toute façon). Une exécution annulée, elle, est close : on en
               ouvre une nouvelle en repartant de son curseur. */
            if(prev.status === RUN_STATUS.STARTED) runId = prev.id;
          }
        }

        if(runId === null || runId === undefined){
          const started = await safeJournal("start", { source: source, cursor: resumed ? cursor : null });
          runId = started && started.id !== undefined ? started.id : (started || null);
        }

        emit("started", { resumed: resumed });
        checkpoint();

        /* ---- 1. conteneurs (matières) ----------------------------------- */
        const remoteContainers = await withRetry(
          function(){ return adapter.listContainers({ source: source, signal: options.signal }); },
          retry
        );
        checkpoint();

        const localContainers = await store.listContainers(source);
        const plan = diff(localContainers, remoteContainers, { source: source });

        const localIdByKey = {};
        (localContainers || []).forEach(function(c){
          if(c && c.externalId !== null && c.externalId !== undefined) localIdByKey[String(c.externalId)] = c.id;
        });

        for(let i = 0; i < plan.created.length; i++){
          checkpoint();
          const it = plan.created[i];
          const created = await store.createContainer(containerPayload(it.remote));
          if(created && created.id !== undefined && created.id !== null) localIdByKey[it.key] = created.id;
          counts.containersCreated++;
        }
        for(let i = 0; i < plan.updated.length; i++){
          checkpoint();
          const it = plan.updated[i];
          await store.updateContainer(it.local.id, containerPayload(it.remote));
          counts.containersUpdated++;
        }
        for(let i = 0; i < plan.restored.length; i++){
          checkpoint();
          const it = plan.restored[i];
          await store.updateContainer(it.local.id, containerPayload(it.remote));
          counts.containersRestored++;
        }
        /* Disparu de la source : MARQUÉ, jamais supprimé. */
        for(let i = 0; i < plan.removed.length; i++){
          checkpoint();
          await store.markContainerRemoved(plan.removed[i].local.id);
          counts.containersRemoved++;
        }
        counts.containersUnchanged = plan.unchanged.length;

        cursor.containersDone = true;
        await saveCursor();
        emit("containers", { total: remoteContainers.length });

        /* ---- 2. éléments (chapitres), conteneur par conteneur ------------ */
        const doneKeys = {};
        cursor.doneKeys.forEach(function(k){ doneKeys[k] = true; });

        for(let i = 0; i < remoteContainers.length; i++){
          const container = remoteContainers[i];
          const key = String(container.externalId);

          emit("container", {
            index: i, total: remoteContainers.length,
            label: container.name || container.title || "", key: key,
            skipped: !!doneKeys[key],
          });

          /* Déjà traité lors d'une exécution interrompue : on ne le refait pas.
             C'est tout l'intérêt du curseur. */
          if(doneKeys[key]){ counts.skipped++; continue; }
          checkpoint();

          const containerId = localIdByKey[key];
          if(containerId === undefined || containerId === null){
            /* Le conteneur n'a pas pu être créé (refus d'écriture, conflit) :
               on le signale comme partiel au lieu de faire comme si de rien. */
            counts.unavailable++; partial = true;
            continue;
          }

          let remoteItems;
          try{
            remoteItems = await withRetry(
              function(){ return adapter.listItems({ source: source, signal: options.signal }, container); },
              retry
            );
          }catch(e){
            if(isCancellation(e)) throw e;
            /* Un conteneur inaccessible ne fait pas échouer tout l'import :
               il est marqué `unavailable` et la synchronisation continue.
               Il n'entre PAS dans le curseur : la prochaine exécution
               réessaiera. */
            counts.unavailable++; partial = true;
            if(typeof store.markContainerUnavailable === "function"){
              try{ await store.markContainerUnavailable(containerId); }catch(e2){}
            }
            await saveCursor();
            continue;
          }

          const localItems = await store.listItems(source, containerId);
          const iplan = diff(localItems, remoteItems, { source: source });

          let position = (localItems || []).length;
          for(let j = 0; j < iplan.created.length; j++){
            checkpoint();
            position++;
            await store.createItem(itemPayload(iplan.created[j].remote, containerId, position));
            counts.itemsCreated++;
          }
          for(let j = 0; j < iplan.updated.length; j++){
            checkpoint();
            const it = iplan.updated[j];
            await store.updateItem(it.local.id, itemPayload(it.remote, containerId, null));
            counts.itemsUpdated++;
          }
          for(let j = 0; j < iplan.restored.length; j++){
            checkpoint();
            const it = iplan.restored[j];
            await store.updateItem(it.local.id, itemPayload(it.remote, containerId, null));
            counts.itemsRestored++;
          }
          for(let j = 0; j < iplan.removed.length; j++){
            checkpoint();
            await store.markItemRemoved(iplan.removed[j].local.id);
            counts.itemsRemoved++;
          }
          counts.itemsUnchanged += iplan.unchanged.length;

          doneKeys[key] = true;
          cursor.doneKeys = Object.keys(doneKeys);
          await saveCursor();
        }

        const status = partial ? RUN_STATUS.PARTIAL : RUN_STATUS.COMPLETED;
        await safeJournal("finish", runId, {
          status: status, counts: counts,
          /* Une exécution complète n'a plus rien à reprendre : on efface le
             curseur pour que la suivante reparte de zéro. Une exécution
             partielle le garde. */
          cursor: partial ? cursor : null,
        });
        emit("finished", { status: status });
        return report(status);

      }catch(e){
        if(isCancellation(e)){
          await safeJournal("finish", runId, { status: RUN_STATUS.CANCELLED, counts: counts, cursor: cursor });
          emit("finished", { status: RUN_STATUS.CANCELLED });
          return report(RUN_STATUS.CANCELLED, e);
        }
        await safeJournal("finish", runId, {
          status: RUN_STATUS.FAILED, counts: counts, cursor: cursor,
          error: String(e && e.message || e).slice(0, 500),
        });
        emit("finished", { status: RUN_STATUS.FAILED });
        return report(RUN_STATUS.FAILED, e);
      }
    }

    return { run: run, source: source, adapter: adapter, store: store, journal: journal };
  }

  /* ============================================================================
     STORE — mémoire (tests, et base de toute source locale future)
     ============================================================================
     Reproduit fidèlement le comportement de la base, y compris l'unicité
     (user_id, source, external_id) : sans cela, un test d'idempotence passerait
     en mémoire et échouerait en production. */
  function createMemoryStore(opts){
    opts = opts || {};
    const db = opts.db || { containers: [], items: [], seq: 0 };
    const userId = opts.userId || "user";

    function nextId(prefix){ db.seq += 1; return prefix + db.seq; }
    function mine(r){ return r.userId === userId; }
    function toLocal(r){
      return {
        id: r.id, source: r.source, externalId: r.externalId,
        syncStatus: r.syncStatus,
        fingerprint: (r.meta || {}).fingerprint,
        sourceUpdatedAt: r.sourceUpdatedAt || null,
      };
    }

    return {
      db: db, userId: userId,

      async listContainers(source){
        return db.containers.filter(c => mine(c) && c.source === source).map(toLocal);
      },
      async createContainer(p){
        /* upsert : même contrainte que l'index unique en base. */
        const existing = db.containers.find(c => mine(c) && c.source === p.source && c.externalId === p.externalId);
        if(existing){ Object.assign(existing, p); return { id: existing.id }; }
        const row = Object.assign({ id: nextId("c"), userId: userId }, p);
        db.containers.push(row);
        return { id: row.id };
      },
      async updateContainer(id, p){
        const row = db.containers.find(c => c.id === id && mine(c));
        if(!row) return null;
        /* Ne jamais réécrire l'identité ni le contenu pédagogique local. */
        Object.assign(row, p, { id: row.id, userId: row.userId });
        return { id: row.id };
      },
      async markContainerRemoved(id){
        const row = db.containers.find(c => c.id === id && mine(c));
        if(row) row.syncStatus = ITEM_STATUS.REMOVED;
        return row ? { id: row.id } : null;
      },
      async markContainerUnavailable(id){
        const row = db.containers.find(c => c.id === id && mine(c));
        if(row) row.syncStatus = ITEM_STATUS.UNAVAILABLE;
        return row ? { id: row.id } : null;
      },

      async listItems(source, containerId){
        return db.items.filter(i => mine(i) && i.source === source && i.containerId === containerId).map(toLocal);
      },
      async createItem(p){
        const existing = db.items.find(i => mine(i) && i.source === p.source && i.externalId === p.externalId);
        if(existing){ Object.assign(existing, p); return { id: existing.id }; }
        const row = Object.assign({ id: nextId("i"), userId: userId }, p);
        db.items.push(row);
        return { id: row.id };
      },
      async updateItem(id, p){
        const row = db.items.find(i => i.id === id && mine(i));
        if(!row) return null;
        Object.assign(row, p, { id: row.id, userId: row.userId, containerId: row.containerId });
        return { id: row.id };
      },
      async markItemRemoved(id){
        const row = db.items.find(i => i.id === id && mine(i));
        if(row) row.syncStatus = ITEM_STATUS.REMOVED;
        return row ? { id: row.id } : null;
      },
    };
  }

  /* ============================================================================
     STORE — Supabase
     ============================================================================
     Générique : il ne sait pas ce qu'est Brightspace. Les tables et colonnes
     sont paramétrables ; par défaut ce sont celles déjà en place
     (subjects / chapters), qui portent depuis la migration 001 les colonnes de
     provenance et depuis la 003 `source_updated_at`.

     L'écriture de création passe par un UPSERT sur
     (user_id, source, external_id) : c'est la garantie structurelle
     d'idempotence — même si deux onglets synchronisent en même temps, la base
     ne peut pas contenir deux copies du même cours. */
  function createSupabaseStore(client, userId, opts){
    opts = opts || {};
    if(!client) throw new Error("LyonSync.createSupabaseStore : client Supabase manquant.");
    if(!userId) throw new Error("LyonSync.createSupabaseStore : userId manquant.");

    const T_CONTAINERS = opts.containersTable  || "subjects";
    const T_ITEMS      = opts.itemsTable       || "chapters";
    const PARENT_COL   = opts.itemParentColumn || "subject_id";
    const CONFLICT     = "user_id,source,external_id";
    const containerDefaults = opts.containerDefaults || {};
    const itemDefaults      = opts.itemDefaults || {};
    const SELECT_LOCAL = "id,external_id,source,sync_status,source_meta,source_updated_at";

    /* Une erreur de base transitoire mérite un réessai ; une erreur de
       droits ou de validation, non. On ne devine pas : on se fonde sur le
       code SQLSTATE quand il est là. */
    function isTransient(error){
      const code = String((error && error.code) || "");
      return code === "40001"   // serialization_failure
          || code === "40P01"   // deadlock_detected
          || code === "57014"   // query_canceled
          || code === "08006" || code === "08003"; // connection failure
    }
    function fail(error, what){
      throw makeError("store", what + " : " + ((error && error.message) || "erreur inconnue"), {
        retryable: isTransient(error),
        details: (error && error.details) || null,
      });
    }
    function toLocal(r){
      return {
        id: r.id, source: r.source, externalId: r.external_id,
        syncStatus: r.sync_status,
        fingerprint: (r.source_meta || {}).fingerprint,
        sourceUpdatedAt: r.source_updated_at || null,
      };
    }
    function pad2(n){ return (n < 10 ? "0" : "") + n; }

    function containerRow(p){
      return Object.assign({}, containerDefaults, {
        user_id: userId,
        name: p.name,
        description: p.description,
        source: p.source,
        external_id: p.externalId,
        external_type: p.externalType,
        sync_status: p.syncStatus,
        last_synced_at: p.lastSyncedAt,
        source_updated_at: p.sourceUpdatedAt,
        source_meta: p.meta,
      });
    }
    /* Mise à jour : l'identité (user_id, source, external_id) n'est jamais
       réécrite, et aucune colonne de contenu REV-EM n'apparaît ici. */
    function containerPatch(p){
      return {
        name: p.name, description: p.description,
        sync_status: p.syncStatus, last_synced_at: p.lastSyncedAt,
        source_updated_at: p.sourceUpdatedAt, source_meta: p.meta,
      };
    }
    function itemRow(p){
      const row = Object.assign({}, itemDefaults, {
        user_id: userId,
        title: p.title,
        description: p.description,
        source: p.source,
        external_id: p.externalId,
        external_type: p.externalType,
        sync_status: p.syncStatus,
        last_synced_at: p.lastSyncedAt,
        source_updated_at: p.sourceUpdatedAt,
        sort_order: p.order,
        resources: p.resources,
        source_meta: p.meta,
      });
      row[PARENT_COL] = p.containerId;
      if(p.position !== null && p.position !== undefined) row.num = pad2(p.position);
      return row;
    }
    function itemPatch(p){
      return {
        title: p.title, description: p.description,
        sync_status: p.syncStatus, last_synced_at: p.lastSyncedAt,
        source_updated_at: p.sourceUpdatedAt,
        sort_order: p.order, resources: p.resources, source_meta: p.meta,
      };
    }

    return {
      async listContainers(source){
        const res = await client.from(T_CONTAINERS).select(SELECT_LOCAL).eq("source", source);
        if(res.error) fail(res.error, "lecture des matières");
        return (res.data || []).map(toLocal);
      },
      async createContainer(p){
        const res = await client.from(T_CONTAINERS)
          .upsert(containerRow(p), { onConflict: CONFLICT })
          .select("id").maybeSingle();
        if(res.error) fail(res.error, "création d'une matière");
        return res.data ? { id: res.data.id } : null;
      },
      async updateContainer(id, p){
        const res = await client.from(T_CONTAINERS).update(containerPatch(p)).eq("id", id);
        if(res.error) fail(res.error, "mise à jour d'une matière");
        return { id: id };
      },
      async markContainerRemoved(id){
        const res = await client.from(T_CONTAINERS)
          .update({ sync_status: ITEM_STATUS.REMOVED }).eq("id", id);
        if(res.error) fail(res.error, "marquage d'une matière disparue");
        return { id: id };
      },
      async markContainerUnavailable(id){
        const res = await client.from(T_CONTAINERS)
          .update({ sync_status: ITEM_STATUS.UNAVAILABLE }).eq("id", id);
        if(res.error) fail(res.error, "marquage d'une matière indisponible");
        return { id: id };
      },

      async listItems(source, containerId){
        const res = await client.from(T_ITEMS).select(SELECT_LOCAL)
          .eq("source", source).eq(PARENT_COL, containerId);
        if(res.error) fail(res.error, "lecture des chapitres");
        return (res.data || []).map(toLocal);
      },
      async createItem(p){
        const res = await client.from(T_ITEMS)
          .upsert(itemRow(p), { onConflict: CONFLICT })
          .select("id").maybeSingle();
        if(res.error) fail(res.error, "création d'un chapitre");
        return res.data ? { id: res.data.id } : null;
      },
      async updateItem(id, p){
        const res = await client.from(T_ITEMS).update(itemPatch(p)).eq("id", id);
        if(res.error) fail(res.error, "mise à jour d'un chapitre");
        return { id: id };
      },
      async markItemRemoved(id){
        const res = await client.from(T_ITEMS)
          .update({ sync_status: ITEM_STATUS.REMOVED }).eq("id", id);
        if(res.error) fail(res.error, "marquage d'un chapitre disparu");
        return { id: id };
      },
    };
  }

  /* ============================================================================
     JOURNAL — started / completed / partial / failed / cancelled
     ============================================================================ */

  /* Journal vide : le moteur fonctionne sans journalisation (utile pour une
     source purement locale). Aucune branche conditionnelle dans le moteur. */
  function createNullJournal(){
    return {
      async findResumable(){ return null; },
      async start(){ return { id: null }; },
      async progress(){ return null; },
      async finish(){ return null; },
    };
  }

  /* Compteur PARTAGÉ par toutes les instances : deux journaux successifs
     peuvent écrire dans le même tableau `runs` (exactement ce que fait une
     reprise, qui ouvre un nouveau journal sur l'historique existant). Un
     compteur par instance produirait deux lignes portant le même id, et
     `finish()` clôturerait la mauvaise. */
  let memoryRunSeq = 0;

  function createMemoryJournal(opts){
    opts = opts || {};
    const runs = opts.runs || [];
    const staleAfterMs = opts.staleAfterMs === undefined ? 15 * 60 * 1000 : opts.staleAfterMs;
    const now = opts.now || function(){ return new Date(); };

    return {
      runs: runs,
      async findResumable(source){
        /* SEULE la dernière exécution compte. Une exécution annulée que
           d'autres ont suivie est de l'histoire ancienne : la reprendre
           ferait sauter des cours déjà repris depuis. */
        /* À horodatage égal (deux exécutions dans la même milliseconde, ce que
           les tests provoquent), c'est l'ordre d'insertion qui tranche — un
           tri par date seule y serait arbitraire. */
        let last = null;
        runs.forEach(function(r){
          if(r.source === source && (!last || r.startedAt >= last.startedAt)) last = r;
        });
        const r = last && (last.status === RUN_STATUS.STARTED || last.status === RUN_STATUS.CANCELLED)
          ? last : null;
        if(!r) return null;
        return {
          id: r.id, status: r.status, cursor: r.cursor || null,
          startedAt: r.startedAt,
          stale: (now().getTime() - r.startedAt) > staleAfterMs,
        };
      },
      async start(p){
        memoryRunSeq += 1;
        const row = {
          id: "run" + memoryRunSeq, source: p.source, status: RUN_STATUS.STARTED,
          startedAt: now().getTime(), finishedAt: null,
          cursor: p.cursor || null, counts: {}, error: null,
        };
        runs.push(row);
        return { id: row.id };
      },
      async progress(id, p){
        const row = runs.find(r => r.id === id);
        if(!row) return null;
        row.cursor = p.cursor ? JSON.parse(JSON.stringify(p.cursor)) : row.cursor;
        row.counts = Object.assign({}, p.counts);
        return { id: id };
      },
      async finish(id, p){
        const row = runs.find(r => r.id === id);
        if(!row) return null;
        row.status = p.status;
        row.counts = Object.assign({}, p.counts);
        row.cursor = p.cursor ? JSON.parse(JSON.stringify(p.cursor)) : null;
        row.error = p.error || null;
        row.finishedAt = now().getTime();
        return { id: id };
      },
    };
  }

  /* Journal Supabase : table sync_runs (migration 001, statuts alignés par la
     migration 003). Le client n'a pas de droit de suppression sur cette table —
     l'historique des synchronisations ne peut pas être effacé depuis le
     navigateur. */
  function createSupabaseJournal(client, userId, opts){
    opts = opts || {};
    if(!client) throw new Error("LyonSync.createSupabaseJournal : client Supabase manquant.");
    if(!userId) throw new Error("LyonSync.createSupabaseJournal : userId manquant.");
    const TABLE = opts.table || "sync_runs";
    /* Au-delà de ce délai, une exécution restée "started" est considérée comme
       abandonnée (onglet fermé, appareil éteint) et peut être reprise. En
       deçà, on suppose qu'elle tourne vraiment ailleurs et on ne lance pas un
       second import concurrent. */
    const staleAfterMs = opts.staleAfterMs === undefined ? 15 * 60 * 1000 : opts.staleAfterMs;

    return {
      async findResumable(source){
        /* On lit la DERNIÈRE exécution, quel que soit son statut, et on ne la
           reprend que si elle est restée ouverte ou a été annulée. Filtrer
           directement sur ces deux statuts ferait ressortir une vieille
           exécution annulée qu'une synchronisation complète a déjà remplacée :
           la reprendre ferait sauter des cours. */
        const res = await client.from(TABLE)
          .select("id,status,cursor,started_at")
          .eq("source", source)
          .order("started_at", { ascending: false })
          .limit(1);
        if(res.error || !res.data || !res.data.length) return null;
        const r = res.data[0];
        if(r.status !== RUN_STATUS.STARTED && r.status !== RUN_STATUS.CANCELLED) return null;
        const startedAt = r.started_at ? Date.parse(r.started_at) : 0;
        return {
          id: r.id, status: r.status, cursor: r.cursor || null, startedAt: startedAt,
          stale: !startedAt || (Date.now() - startedAt) > staleAfterMs,
        };
      },
      async start(p){
        const res = await client.from(TABLE).insert({
          user_id: userId, source: p.source,
          status: RUN_STATUS.STARTED, cursor: p.cursor || null,
        }).select("id").maybeSingle();
        if(res.error){
          throw makeError("journal", "Impossible d'ouvrir le journal de synchronisation.", { retryable: false });
        }
        return { id: res.data ? res.data.id : null };
      },
      async progress(id, p){
        if(!id) return null;
        await client.from(TABLE).update({ cursor: p.cursor || null, counts: p.counts || {} }).eq("id", id);
        return { id: id };
      },
      async finish(id, p){
        if(!id) return null;
        await client.from(TABLE).update({
          status: p.status,
          counts: p.counts || {},
          cursor: p.cursor || null,
          finished_at: new Date().toISOString(),
          error_summary: p.error || null,
        }).eq("id", id);
        return { id: id };
      },
    };
  }

  global.LyonSync = {
    RUN_STATUS, ITEM_STATUS,
    createEngine,
    createMemoryStore, createSupabaseStore,
    createNullJournal, createMemoryJournal, createSupabaseJournal,
    // exposés pour les tests et la réutilisation
    withRetry, isCancellation, defaultIsRetryable, makeError, emptyCounts,
    CANCELLED_CODE,
  };

})(typeof window !== "undefined" ? window : globalThis);
