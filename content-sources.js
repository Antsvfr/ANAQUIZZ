/* ============================================================================
   REV-EM — couche "sources de contenu" (normalisation + diff, sans UI)
   ------------------------------------------------------------------------
   Fichier autonome, chargé comme smart-revision.js/statistics.js/planning.js
   (voir index.html) : window.LyonContentSources n'a AUCUNE dépendance au DOM,
   à l'état de l'application, à Supabase, au réseau ni à WebLLM/WebGPU.

   RÔLE — deux choses, et seulement ces deux-là :

     1. NORMALISER  la réponse brute d'une source externe (Brightspace
        aujourd'hui, Moodle/Google Classroom plus tard) vers le modèle
        interne REV-EM déjà utilisé par la bibliothèque
        (state.userSubjects / state.userChapters).

     2. DIFFÉRENCIER une collection locale et une collection distante pour
        produire un plan d'application (à créer / à mettre à jour / inchangé
        / disparu) — SANS jamais l'appliquer : c'est le pont dans index.html
        qui écrit, ce module ne fait que décider.

   CE QUE CE MODULE NE FAIT PAS :
     - aucun appel réseau (c'est l'Edge Function brightspace-sync) ;
     - aucune écriture (ni localStorage, ni Supabase) ;
     - aucune génération de contenu pédagogique (pipeline existant) ;
     - aucune suppression : une ressource disparue de la source est
       MARQUÉE removed, jamais effacée (voir §13 du cahier des charges —
       les fiches/quiz/flashcards/statistiques déjà produits sont la
       propriété de l'élève, pas de la source).

   ⚠️ NOMS DE CHAMPS BRIGHTSPACE — la documentation D2L
   (docs.valence.desire2learn.com, community.d2l.com) était inaccessible
   depuis l'environnement de développement (proxy réseau). Les normaliseurs
   ci-dessous sont donc volontairement DÉFENSIFS : chaque champ est cherché
   parmi plusieurs orthographes plausibles (pick()), et tout champ absent
   vaut null plutôt que de faire échouer l'import. À confronter à la
   réponse réelle du tenant avant mise en production — voir
   normalizeBrightspaceCourse/Module/Topic.
   ============================================================================ */
(function(global){
  "use strict";

  const SOURCES = { MANUAL: "manual", PDF: "pdf", BRIGHTSPACE: "brightspace" };

  /* Statuts de synchronisation (identiques côté SQL — voir la migration
     Brightspace : contrainte CHECK sur subjects.sync_status/chapters.sync_status). */
  const SYNC_STATUS = {
    ACTIVE: "active",           // présent des deux côtés, à jour
    MODIFIED: "modified",       // présent des deux côtés, la source a changé
    REMOVED: "removed",         // a disparu de la source (JAMAIS supprimé chez nous)
    UNAVAILABLE: "unavailable", // existe encore mais inaccessible (permissions, erreur)
  };

  const EXTERNAL_TYPE = { COURSE: "org-unit", MODULE: "module", TOPIC: "topic" };

  /* Types de ressource retenus. "course_text" = contenu pédagogique dont on a
     pu extraire du texte exploitable (il alimentera fiche/quiz/flashcards) ;
     les autres restent des ressources consultables, jamais inventées. */
  const RESOURCE_KIND = {
    FILE: "file", PAGE: "page", LINK: "link", VIDEO: "video", OTHER: "other",
  };

  /* ---------- utilitaires ---------- */

  /* Lit la première clé présente parmi plusieurs orthographes possibles.
     Brightspace renvoie du PascalCase ; d'autres LMS (et certaines versions)
     du camelCase. Plutôt que de parier, on accepte les deux. */
  function pick(obj, keys, fallback){
    if(!obj) return fallback === undefined ? null : fallback;
    for(let i = 0; i < keys.length; i++){
      const v = obj[keys[i]];
      if(v !== undefined && v !== null && v !== "") return v;
    }
    return fallback === undefined ? null : fallback;
  }

  function asString(v){
    if(v === null || v === undefined) return null;
    return String(v);
  }

  function cleanText(v){
    if(v === null || v === undefined) return "";
    return String(v).replace(/\s+/g, " ").trim();
  }

  /* Convertit une date Brightspace (ISO 8601) en timestamp, ou null.
     Ne devine jamais une date absente. */
  function toTimestamp(v){
    if(!v) return null;
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  /* Empreinte de contenu : sert UNIQUEMENT à détecter qu'un élément a changé
     côté source. Volontairement limitée aux champs qui viennent de la source
     (jamais au contenu généré par REV-EM, qui ne doit pas déclencher de
     "modifié" côté Brightspace). Hash stable, indépendant de l'ordre des
     clés — deux exécutions sur la même donnée donnent la même empreinte. */
  function fingerprint(fields){
    const parts = Object.keys(fields).sort().map(k => k + "=" + (fields[k] === null || fields[k] === undefined ? "" : String(fields[k])));
    const str = parts.join("|");
    // djb2 — suffisant pour de la détection de changement (pas de la crypto).
    let h = 5381;
    for(let i = 0; i < str.length; i++){ h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; }
    return h.toString(36);
  }

  /* ---------- normalisation Brightspace ---------- */

  /* Un cours Brightspace (org unit d'une inscription) → une MATIÈRE REV-EM.
     `entry` accepte aussi bien l'objet d'inscription complet
     ({OrgUnit:{…}, Access:{…}}) que l'org unit seule. */
  function normalizeBrightspaceCourse(entry){
    if(!entry) return null;
    const ou = entry.OrgUnit || entry.orgUnit || entry;
    const externalId = asString(pick(ou, ["Id", "id", "OrgUnitId", "orgUnitId"]));
    if(!externalId) return null; // sans identité externe, pas de déduplication possible

    const name = cleanText(pick(ou, ["Name", "name", "Title", "title"], ""));
    const code = cleanText(pick(ou, ["Code", "code", "CourseCode", "courseCode"], ""));
    const startDate = toTimestamp(pick(entry, ["StartDate", "startDate"]) || pick(ou, ["StartDate", "startDate"]));
    const endDate = toTimestamp(pick(entry, ["EndDate", "endDate"]) || pick(ou, ["EndDate", "endDate"]));

    return {
      source: SOURCES.BRIGHTSPACE,
      externalId,
      externalType: EXTERNAL_TYPE.COURSE,
      name: name || code || ("Cours " + externalId),
      code: code || null,
      description: cleanText(pick(ou, ["Description", "description"], "")) || null,
      startDate, endDate,
      fingerprint: fingerprint({ name, code, startDate, endDate }),
    };
  }

  /* Un module Brightspace → un CHAPITRE REV-EM.
     `parentExternalId` permet de conserver la hiérarchie réelle (module
     imbriqué) sans l'aplatir : REV-EM n'a qu'un niveau de chapitre, on garde
     donc le parent en métadonnée plutôt que de perdre l'information (§7 :
     "ne détruis jamais la structure Brightspace originale sans raison"). */
  function normalizeBrightspaceModule(mod, opts){
    if(!mod) return null;
    opts = opts || {};
    const externalId = asString(pick(mod, ["Id", "id", "ModuleId", "moduleId"]));
    if(!externalId) return null;

    const title = cleanText(pick(mod, ["Title", "title", "Name", "name"], ""));
    const shortTitle = cleanText(pick(mod, ["ShortTitle", "shortTitle"], ""));
    const description = extractDescription(mod);
    const order = numberOrNull(pick(mod, ["SortOrder", "sortOrder", "Order", "order"]));

    return {
      source: SOURCES.BRIGHTSPACE,
      externalId,
      externalType: EXTERNAL_TYPE.MODULE,
      courseExternalId: opts.courseExternalId ? asString(opts.courseExternalId) : null,
      parentExternalId: opts.parentExternalId ? asString(opts.parentExternalId) : null,
      title: title || shortTitle || ("Module " + externalId),
      description: description || null,
      order,
      startDate: toTimestamp(pick(mod, ["ModuleStartDate", "StartDate", "startDate"])),
      endDate: toTimestamp(pick(mod, ["ModuleEndDate", "EndDate", "endDate"])),
      resources: [],
      fingerprint: fingerprint({ title, shortTitle, description, order }),
    };
  }

  /* Un topic Brightspace → une RESSOURCE rattachée à un chapitre.
     Ne télécharge rien : décrit seulement ce qui est accessible. Le
     téléchargement/extraction éventuel est la responsabilité de l'appelant
     (Edge Function pour le texte, IndexedDB pour le binaire côté appareil). */
  function normalizeBrightspaceTopic(topic, opts){
    if(!topic) return null;
    opts = opts || {};
    const externalId = asString(pick(topic, ["Id", "id", "TopicId", "topicId"]));
    if(!externalId) return null;

    const title = cleanText(pick(topic, ["Title", "title", "Name", "name"], ""));
    const url = pick(topic, ["Url", "url", "Location", "location"]);
    const order = numberOrNull(pick(topic, ["SortOrder", "sortOrder", "Order", "order"]));
    const rawType = pick(topic, ["TopicType", "topicType", "Type", "type"]);
    const kind = classifyTopic(rawType, url);

    return {
      source: SOURCES.BRIGHTSPACE,
      externalId,
      externalType: EXTERNAL_TYPE.TOPIC,
      moduleExternalId: opts.moduleExternalId ? asString(opts.moduleExternalId) : null,
      title: title || ("Ressource " + externalId),
      kind,
      url: url ? String(url) : null,
      mimeType: pick(topic, ["MimeType", "mimeType"]) || null,
      description: extractDescription(topic) || null,
      order,
      /* accessible : renseigné par l'appelant après tentative réelle d'accès.
         null = pas encore tenté. On n'affirme JAMAIS qu'une ressource est
         accessible sans l'avoir vérifié (§8). */
      accessible: null,
      fingerprint: fingerprint({ title, url, kind, order }),
    };
  }

  function numberOrNull(v){
    if(v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  /* Brightspace expose la description tantôt en texte, tantôt en objet
     {Html, Text}. On préfère le texte ; le HTML est nettoyé grossièrement
     (le nettoyage fin reste côté appelant, qui dispose de stripHtml()). */
  function extractDescription(obj){
    const d = pick(obj, ["Description", "description"]);
    if(!d) return "";
    if(typeof d === "string") return cleanText(d);
    const text = pick(d, ["Text", "text"]);
    if(text) return cleanText(text);
    const html = pick(d, ["Html", "html"]);
    if(html) return cleanText(String(html).replace(/<[^>]+>/g, " "));
    return "";
  }

  /* Classe un topic en type de ressource. Se fonde sur le type déclaré par
     Brightspace quand il existe, sinon sur l'extension de l'URL. Ne devine
     jamais au-delà : un type inconnu reste OTHER plutôt qu'une supposition. */
  function classifyTopic(rawType, url){
    const t = rawType === null || rawType === undefined ? "" : String(rawType).toLowerCase();
    if(t.indexOf("link") !== -1 || t === "3") return RESOURCE_KIND.LINK;
    if(t.indexOf("file") !== -1 || t === "1") {
      const ext = fileExtension(url);
      if(ext === "mp4" || ext === "mov" || ext === "avi" || ext === "webm") return RESOURCE_KIND.VIDEO;
      return RESOURCE_KIND.FILE;
    }
    if(t.indexOf("html") !== -1 || t.indexOf("page") !== -1) return RESOURCE_KIND.PAGE;

    const ext = fileExtension(url);
    if(!ext) return url && /^https?:\/\//i.test(String(url)) ? RESOURCE_KIND.LINK : RESOURCE_KIND.OTHER;
    if(ext === "pdf" || ext === "doc" || ext === "docx" || ext === "ppt" || ext === "pptx" || ext === "txt" || ext === "md") return RESOURCE_KIND.FILE;
    if(ext === "mp4" || ext === "mov" || ext === "avi" || ext === "webm") return RESOURCE_KIND.VIDEO;
    if(ext === "html" || ext === "htm") return RESOURCE_KIND.PAGE;
    return RESOURCE_KIND.OTHER;
  }

  function fileExtension(url){
    if(!url) return null;
    const m = String(url).split("?")[0].split("#")[0].match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : null;
  }

  /* Normalise une arborescence complète de contenu (root → modules → topics)
     en une liste PLATE de chapitres normalisés, chacun portant ses ressources.
     Accepte la forme récursive de Brightspace (un module contient Structure[]
     mêlant sous-modules et topics). Profondeur bornée pour ne jamais boucler
     sur une structure cyclique inattendue. */
  function normalizeBrightspaceContentTree(nodes, opts){
    opts = opts || {};
    const maxDepth = typeof opts.maxDepth === "number" ? opts.maxDepth : 6;
    const out = [];

    function walk(list, parentExternalId, depth){
      if(!Array.isArray(list) || depth > maxDepth) return;
      list.forEach(node => {
        if(!node) return;
        const isModule = looksLikeModule(node);
        if(isModule){
          const mod = normalizeBrightspaceModule(node, {
            courseExternalId: opts.courseExternalId,
            parentExternalId,
          });
          if(!mod) return;
          const children = pick(node, ["Structure", "structure", "Modules", "Topics"], []) || [];
          const topics = [];
          const subModules = [];
          (Array.isArray(children) ? children : []).forEach(child => {
            if(looksLikeModule(child)) subModules.push(child);
            else topics.push(child);
          });
          mod.resources = topics
            .map(tp => normalizeBrightspaceTopic(tp, { moduleExternalId: mod.externalId }))
            .filter(Boolean)
            .sort(byOrder);
          out.push(mod);
          if(subModules.length) walk(subModules, mod.externalId, depth + 1);
        } else {
          /* Topic rattaché directement à la racine du cours : on ne le perd pas,
             il ira dans un chapitre "racine" créé par l'appelant si besoin. */
          const tp = normalizeBrightspaceTopic(node, { moduleExternalId: parentExternalId });
          if(tp) out.orphanTopics = (out.orphanTopics || []).concat([tp]);
        }
      });
    }

    walk(nodes, null, 0);
    out.sort(byOrder);
    return out;
  }

  function looksLikeModule(node){
    if(!node) return false;
    const type = String(pick(node, ["Type", "type"], "")).toLowerCase();
    if(type === "module" || type === "0") return true;
    if(node.Structure || node.structure || node.Modules) return true;
    const topicType = pick(node, ["TopicType", "topicType"]);
    return topicType === null && (node.Title || node.title) && !(node.Url || node.url);
  }

  function byOrder(a, b){
    const ao = a && a.order !== null && a.order !== undefined ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = b && b.order !== null && b.order !== undefined ? b.order : Number.MAX_SAFE_INTEGER;
    if(ao !== bo) return ao - bo;
    return String(a && a.title || "").localeCompare(String(b && b.title || ""));
  }

  /* ---------- diff / plan d'application ---------- */

  /* Compare une collection LOCALE (déjà en base/état, portant source +
     externalId + fingerprint) à une collection DISTANTE fraîchement
     normalisée, et retourne un PLAN — sans rien appliquer.

       created   : présents à distance, absents en local          → à créer
       updated   : présents des deux côtés, empreinte différente   → à mettre à jour
       unchanged : présents des deux côtés, empreinte identique    → ne rien faire
       removed   : présents en local, absents à distance           → à MARQUER removed
       restored  : marqués removed en local, réapparus à distance  → à réactiver

     `removed` ne contient JAMAIS d'ordre de suppression : l'appelant doit se
     contenter de passer sync_status à "removed" (§13). */
  function diffCollections(localItems, remoteItems, opts){
    opts = opts || {};
    const source = opts.source || SOURCES.BRIGHTSPACE;
    const keyOf = opts.keyOf || (it => it && it.externalId != null ? String(it.externalId) : null);

    const localByKey = new Map();
    (localItems || []).forEach(it => {
      if(!it) return;
      if(it.source && it.source !== source) return; // ne touche jamais aux éléments d'une autre source
      const k = keyOf(it);
      if(k) localByKey.set(k, it);
    });

    const created = [], updated = [], unchanged = [], restored = [];
    const seen = new Set();

    (remoteItems || []).forEach(remote => {
      if(!remote) return;
      const k = keyOf(remote);
      if(!k) return;
      seen.add(k);
      const local = localByKey.get(k);
      if(!local){ created.push({ key: k, remote }); return; }
      const wasRemoved = local.syncStatus === SYNC_STATUS.REMOVED;
      const changed = String(local.fingerprint || "") !== String(remote.fingerprint || "");
      if(wasRemoved) restored.push({ key: k, local, remote, changed });
      else if(changed) updated.push({ key: k, local, remote });
      else unchanged.push({ key: k, local, remote });
    });

    const removed = [];
    localByKey.forEach((local, k) => {
      if(seen.has(k)) return;
      if(local.syncStatus === SYNC_STATUS.REMOVED) return; // déjà marqué, on ne re-signale pas
      removed.push({ key: k, local });
    });

    return {
      created, updated, unchanged, removed, restored,
      counts: {
        created: created.length, updated: updated.length,
        unchanged: unchanged.length, removed: removed.length, restored: restored.length,
      },
      hasChanges: created.length > 0 || updated.length > 0 || removed.length > 0 || restored.length > 0,
    };
  }

  /* Construit le patch à appliquer à un élément local existant à partir de
     sa version distante : UNIQUEMENT les champs qui appartiennent à la
     source. Ne touche jamais au contenu produit par REV-EM (fiche, quiz,
     flashcards, notes, progression) — c'est la garantie que la
     resynchronisation d'un cours ne détruit pas le travail de l'élève. */
  function buildUpdatePatch(remote, fields){
    const allowed = fields || ["title", "name", "description", "order", "url", "kind", "mimeType", "startDate", "endDate", "code"];
    const patch = {};
    allowed.forEach(f => {
      if(Object.prototype.hasOwnProperty.call(remote, f) && remote[f] !== undefined) patch[f] = remote[f];
    });
    patch.fingerprint = remote.fingerprint || null;
    patch.syncStatus = SYNC_STATUS.ACTIVE;
    return patch;
  }

  global.LyonContentSources = {
    SOURCES, SYNC_STATUS, EXTERNAL_TYPE, RESOURCE_KIND,
    normalizeBrightspaceCourse,
    normalizeBrightspaceModule,
    normalizeBrightspaceTopic,
    normalizeBrightspaceContentTree,
    diffCollections,
    buildUpdatePatch,
    // exposés pour les tests et la réutilisation par une future source
    fingerprint, classifyTopic, pick,
  };

})(typeof window !== "undefined" ? window : globalThis);
