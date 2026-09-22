/* ============================================================================
   REV-EM — registre des sources de contenu (ContentSource) et adaptateurs
   ----------------------------------------------------------------------------
   Fichier autonome, chargé comme content-sources.js / sync-engine.js.
   `window.LyonSourceAdapters` n'a AUCUNE dépendance au DOM, à l'état de
   l'application ni à Supabase.

       ContentSource
       ├── manual          (créé dans REV-EM)        — non synchronisable
       ├── pdf             (fichier importé)         — non synchronisable
       ├── brightspace     (LMS de l'établissement)  — synchronisable
       ├── moodle            À VENIR — NON DÉVELOPPÉ
       └── google-classroom  À VENIR — NON DÉVELOPPÉ

   Les deux dernières ne sont PAS implémentées : elles ne sont pas enregistrées,
   `get("moodle")` renvoie null, et rien dans l'interface ne les propose. Elles
   sont nommées ici uniquement pour que la forme de l'abstraction soit
   vérifiable — pas pour laisser croire qu'elles existent.

   AJOUTER UNE SOURCE, PLUS TARD — c'est tout ce qu'il y a à faire :

       LyonSourceAdapters.register(LyonSourceAdapters.defineAdapter({
         id: "moodle", label: "Moodle", syncable: true,
         listContainers: async (ctx)            => [ …NormalizedData… ],
         listItems:      async (ctx, container) => [ …NormalizedData… ],
       }));

   Ni sync-engine.js ni index.html ne changent d'une ligne : le moteur ne
   connaît que ce contrat, jamais un LMS en particulier.

   CONTRAT D'UN ADAPTATEUR
     id            identifiant stable, valeur de la colonne `source` en base
     label         nom affiché à l'utilisateur
     syncable      false = source locale (rien à aller chercher au dehors)
     capabilities  ce que la source sait faire, sans mentir
     listContainers(ctx)            -> NormalizedData[]  (matières)
     listItems(ctx, container)      -> NormalizedData[]  (chapitres)
     containerMeta(n) / itemMeta(n) -> métadonnées propres à la source (opt.)

   Un adaptateur NE DOIT PAS : écrire quoi que ce soit, toucher au DOM,
   supprimer des données, ni inventer un champ que la source n'a pas renvoyé.
   ============================================================================ */
(function(global){
  "use strict";

  /* Sources envisagées, délibérément NON développées. Sert à répondre
     honnêtement « pas encore » plutôt qu'à faire semblant. */
  const PLANNED = ["moodle", "google-classroom"];

  function defineAdapter(spec){
    if(!spec || typeof spec !== "object") throw new Error("defineAdapter : spécification manquante.");
    if(!spec.id || typeof spec.id !== "string") throw new Error("defineAdapter : `id` obligatoire.");
    if(!spec.label || typeof spec.label !== "string") throw new Error("defineAdapter : `label` obligatoire (" + spec.id + ").");
    if(typeof spec.syncable !== "boolean") throw new Error("defineAdapter : `syncable` obligatoire (" + spec.id + ").");

    if(spec.syncable){
      if(typeof spec.listContainers !== "function") throw new Error("defineAdapter : `listContainers` obligatoire pour une source synchronisable (" + spec.id + ").");
      if(typeof spec.listItems !== "function") throw new Error("defineAdapter : `listItems` obligatoire pour une source synchronisable (" + spec.id + ").");
    }

    const adapter = {
      id: spec.id,
      label: spec.label,
      syncable: spec.syncable,
      /* Ce que la source sait faire. `write: false` partout aujourd'hui : on ne
         demande jamais de permission d'écriture à un LMS dont on n'a besoin
         que de lire. */
      capabilities: Object.assign({
        containers: !!spec.syncable,
        items: !!spec.syncable,
        resources: false,
        partial: !!spec.syncable,
        resume: !!spec.syncable,
        write: false,
        delete: false,
      }, spec.capabilities || {}),
      listContainers: spec.listContainers || null,
      listItems: spec.listItems || null,
      containerMeta: spec.containerMeta || null,
      itemMeta: spec.itemMeta || null,
      describe: spec.describe || null,
    };
    return adapter;
  }

  /* ------------------------------------------------------------- le registre */

  const registry = Object.create(null);

  function register(adapter){
    if(!adapter || !adapter.id) throw new Error("register : adaptateur invalide.");
    registry[adapter.id] = adapter;
    return adapter;
  }
  function unregister(id){ delete registry[id]; }
  function get(id){ return registry[id] || null; }
  function has(id){ return !!registry[id]; }
  function list(){ return Object.keys(registry).map(k => registry[k]); }
  function listSyncable(){ return list().filter(a => a.syncable); }

  /* Libellé d'une source pour l'interface. Une source inconnue (donnée ancienne,
     source retirée) retourne son identifiant brut plutôt que de faire
     disparaître l'information. */
  function labelOf(id){
    const a = get(id);
    if(a) return a.label;
    if(PLANNED.indexOf(id) !== -1) return id + " (non disponible)";
    return id || "";
  }

  /* --------------------------------------------------- sources locales */
  /* Elles n'ont rien à aller chercher au dehors : `syncable: false`. Elles
     existent dans le registre pour que l'interface puisse nommer la provenance
     d'une matière de façon uniforme, sans une cascade de `if (source === …)`. */

  const manual = defineAdapter({
    id: "manual",
    label: "Créé dans REV-EM",
    syncable: false,
    describe: function(){ return "Matières et chapitres que tu as créés toi-même."; },
  });

  const pdf = defineAdapter({
    id: "pdf",
    label: "Fichier importé",
    syncable: false,
    capabilities: { resources: true },
    describe: function(){ return "Cours importés depuis un PDF ou un document."; },
  });

  /* ------------------------------------------------------------- Brightspace */

  /* `transport` est injecté : le moteur et l'adaptateur restent testables sans
     réseau, et l'appel réel (Edge Function authentifiée) reste dans index.html.
     La normalisation, elle, n'est pas réécrite ici : elle vit déjà dans
     content-sources.js, seul endroit qui connaît la forme des réponses D2L. */
  function createBrightspaceAdapter(opts){
    opts = opts || {};
    const transport = opts.transport;
    const CS = opts.contentSources || global.LyonContentSources;
    if(typeof transport !== "function") throw new Error("createBrightspaceAdapter : `transport` obligatoire.");
    if(!CS) throw new Error("createBrightspaceAdapter : content-sources.js non chargé.");

    return defineAdapter({
      id: "brightspace",
      label: "Brightspace",
      syncable: true,
      capabilities: { resources: true, partial: true, resume: true, write: false, delete: false },
      describe: function(){ return "Cours de l'établissement, importés automatiquement."; },

      listContainers: async function(){
        const raw = await transport("brightspace-api", { op: "courses" });
        return ((raw && raw.items) || []).map(CS.normalizeBrightspaceCourse).filter(Boolean);
      },

      listItems: async function(ctx, container){
        const tree = await transport("brightspace-api", { op: "content", orgUnitId: container.externalId });
        return CS.normalizeBrightspaceContentTree(((tree && tree.items) || []), {
          courseExternalId: container.externalId,
        });
      },

      /* Ce que la source dit d'elle-même et qui n'a pas de colonne dédiée :
         conservé en `source_meta` plutôt que perdu (§7 : ne jamais détruire la
         structure d'origine sans raison). */
      containerMeta: function(n){ return { code: n.code || null }; },
      itemMeta: function(n){
        return {
          parentExternalId: n.parentExternalId || null,
          courseExternalId: n.courseExternalId || null,
        };
      },
    });
  }

  register(manual);
  register(pdf);
  /* brightspace n'est PAS enregistré ici : il lui faut un transport
     authentifié, que seule l'application peut fournir (index.html appelle
     registerBrightspace() une fois la session Supabase établie). */

  function registerBrightspace(opts){
    return register(createBrightspaceAdapter(opts));
  }

  global.LyonSourceAdapters = {
    PLANNED,
    defineAdapter,
    register, unregister, get, has, list, listSyncable, labelOf,
    createBrightspaceAdapter, registerBrightspace,
    // exposés pour les tests
    adapters: registry,
  };

})(typeof window !== "undefined" ? window : globalThis);
