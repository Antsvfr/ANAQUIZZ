/* ============================================================================
   REV-EM — persistance des données utilisateur dans Supabase
   ----------------------------------------------------------------------------
   Fichier autonome, chargé comme sync-engine.js / statistics.js / planning.js.
   `window.LyonUserData` n'a AUCUNE dépendance au DOM, à `render()`, à `state`,
   ni à WebLLM. Il ne connaît que deux choses : un client Supabase, et un
   INSTANTANÉ — un objet plat décrivant les données de l'élève.

   À NE PAS CONFONDRE AVEC sync-engine.js. Celui-là importe du contenu VENU DE
   L'EXTÉRIEUR (un LMS) vers Supabase. Celui-ci fait voyager les données que
   l'élève PRODUIT dans REV-EM entre ses appareils. Deux problèmes différents,
   deux moteurs séparés.

       Appareil A                          Appareil B
           │                                   │
       lsSet(...)                          connexion
           │                                   │
       push(domaine) ──► Supabase ◄────── pullAll()
                        (auth.uid())           │
                                          instantané → state → interface

   ----------------------------------------------------------------------------
   CE QUI EST LA SOURCE DE VÉRITÉ
   ----------------------------------------------------------------------------
   Supabase. Le `localStorage` reste utilisé, mais comme CACHE : il donne un
   premier affichage instantané et permet de continuer à travailler hors ligne.
   Il n'est jamais la référence pour un compte connecté.

   Pour un invité (pas de compte, ou Supabase non configuré), rien ne change :
   ce module n'est simplement jamais appelé, et `localStorage` reste la seule
   persistance. C'est un état normal et pleinement supporté du produit.

   ----------------------------------------------------------------------------
   STRATÉGIE DE CONFLIT (exigée explicitement)
   ----------------------------------------------------------------------------
   Deux appareils peuvent modifier la même donnée. Trois régimes, choisis selon
   la NATURE de la donnée et non par commodité :

   1. LIGNE PAR LIGNE, dernier écrivain gagnant, arbitré par `updated_at`.
      Pour tout ce qui est une collection d'objets indépendants : matières,
      chapitres, notes de cours, événements, documents, statistiques par
      question, progression par chapitre. Modifier le chapitre 3 sur le
      téléphone n'écrase pas le chapitre 7 modifié sur l'ordinateur — la
      granularité est la ligne, pas le domaine.

   2. FUSION PAR MAXIMUM, pour les compteurs MONOTONES : questions répondues,
      bonnes réponses, temps passé, meilleure série, quiz terminés, activité
      quotidienne. Un compteur qui ne fait que monter ne doit jamais redescendre
      parce qu'un appareil en retard a écrit sa valeur. `max(local, distant)`
      est ici la bonne réponse, et « dernier écrivain gagnant » serait une perte
      silencieuse de données — précisément ce qu'on demande d'éviter.
      (`correct_streak`, série EN COURS, n'est pas monotone : elle suit la
      dernière écriture, comme il se doit.)

   3. UNION, pour les journaux : activités, historique d'examens, réussites.
      Ce sont des faits datés. Deux appareils qui en ajoutent chacun produisent
      l'union des deux, jamais l'un à la place de l'autre.

   ----------------------------------------------------------------------------
   SUPPRESSIONS : CE QU'ON NE FAIT PAS
   ----------------------------------------------------------------------------
   Pousser une collection supprime les lignes absentes de l'instantané — sinon
   une matière supprimée sur l'ordinateur ressusciterait sur le téléphone.
   Mais UNIQUEMENT parmi les clés que CET appareil a réellement vues
   (`knownKeys`, renseigné au pull et à chaque push).

   Conséquence voulue : une matière créée sur l'appareil B après notre dernier
   pull n'est jamais supprimée par un push de l'appareil A, qui ignore son
   existence. Sans ce garde-fou, deux appareils actifs se détruiraient
   mutuellement leurs créations.

   ----------------------------------------------------------------------------
   SÉCURITÉ
   ----------------------------------------------------------------------------
   `user_id` est écrit dans chaque ligne parce que la colonne l'exige, mais il
   n'est JAMAIS la barrière de sécurité : les policies RLS comparent
   `auth.uid()` au `user_id` de la ligne, côté PostgreSQL. Un `user_id` falsifié
   depuis le navigateur fait échouer l'écriture, il ne la détourne pas. Aucune
   clé secrète ici : le module reçoit le client déjà construit par auth.js.
   ============================================================================ */

(function(global){
  "use strict";

  /* ═════════════════════════════════════════════════════════════════════════
     OUTILS
     ═════════════════════════════════════════════════════════════════════════ */

  const iso = (ms) => {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return null;
    try { return new Date(n).toISOString(); } catch (e) { return null; }
  };
  /* Une date venue de la base peut arriver en chaîne ISO (client Supabase, via
     PostgREST) ou en objet Date (pilote PostgreSQL direct, utilisé par les
     tests d'intégration). Les deux doivent donner le même résultat : sans ça,
     un même code est juste en production et faux en test, ou l'inverse. */
  const ms = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date) { const n = v.getTime(); return isFinite(n) ? n : null; }
    const n = Date.parse(v);
    return isFinite(n) ? n : null;
  };
  /* Un jour civil, toujours « AAAA-MM-JJ ». Une colonne `date` PostgreSQL
     revient en objet Date : `String(date).slice(0,10)` donnerait « Thu Sep 24 »,
     qui n'est pas une clé de jour mais qui en a l'air — un piège silencieux,
     puisque les compteurs sont ensuite indexés dessus et ne se retrouvent
     plus. On passe donc par les composantes LOCALES de la date (pas UTC : une
     date sans heure est déjà dans le fuseau local, la convertir la ferait
     reculer d'un jour à l'ouest de Greenwich). */
  const dayKey = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      const p = (n) => String(n).padStart(2, "0");
      return v.getFullYear() + "-" + p(v.getMonth() + 1) + "-" + p(v.getDate());
    }
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  };
  const num = (v, dflt) => {
    const n = Number(v);
    return isFinite(n) ? n : (dflt || 0);
  };
  /* Un jour au format "AAAA-MM-JJ", tel que le client le produit déjà
     (todayKey/dateKey dans index.html). On ne reformate rien : une date mal
     formée est écartée plutôt que corrigée au hasard. */
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

  /* Supabase limite la taille d'une requête. Les collections de l'élève sont
     petites (quelques centaines de lignes au plus), mais `question_stats` peut
     atteindre le millier : on écrit par paquets plutôt que d'un bloc. */
  const CHUNK = 400;
  function chunk(arr, n){
    const out = [];
    for (let i = 0; i < arr.length; i += (n || CHUNK)) out.push(arr.slice(i, i + (n || CHUNK)));
    return out;
  }

  /* Toute erreur Supabase remonte ici : on ne lève jamais depuis un push, on
     RAPPORTE. Un appareil hors ligne doit continuer à fonctionner, pas se
     bloquer sur une exception non rattrapée. */
  function fail(domain, error){
    return { ok: false, domain: domain, error: (error && error.message) || String(error || "erreur inconnue") };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     LES DOMAINES
     ─────────────────────────────────────────────────────────────────────────
     Un domaine = une tranche de l'instantané ↔ une ou plusieurs tables.
     Chacun sait :
        rows(snap, userId)  → les lignes à écrire
        key(row)            → sa clé naturelle (pour les suppressions)
        conflict            → les colonnes de `on conflict`
        apply(rows, patch)  → comment la lecture retourne dans l'instantané

     `keyCol` : la colonne qui porte la clé naturelle, utilisée pour supprimer
     les lignes disparues. `null` = domaine à ligne unique (pas de suppression
     possible : la ligne de l'utilisateur est soit là, soit absente).
     ═════════════════════════════════════════════════════════════════════════ */

  /* ── MATIÈRES ──────────────────────────────────────────────────────────────
     Les matières importées d'un LMS ne sont PAS écrites ici : elles
     appartiennent à sync-engine.js, qui les tient à jour depuis la source.
     Les pousser depuis le cache local écraserait `external_id`, `sync_status`
     et `source_meta` par des valeurs appauvries. Elles sont en revanche LUES,
     pour que l'appareil B les voie comme n'importe quelle autre matière. */
  const isManual = (o) => !o || !o.source || o.source === "manual" || o.source === "pdf";

  const SUBJECTS = {
    name: "subjects",
    table: "subjects",
    keyCol: "local_id",
    conflict: "user_id,local_id",
    rows(snap, userId){
      return (snap.subjects || [])
        .filter(s => s && s.id && isManual(s) && !s.builtin)
        .map(s => ({
          user_id: userId,
          local_id: String(s.id),
          name: String(s.name || ""),
          icon: s.icon || null,
          color: s.color || null,
          semester_id: s.semesterId || null,
          description: s.description || null,
          source: "manual",
        }));
    },
    apply(rows, patch){
      patch.subjects = (rows || []).map(r => ({
        /* L'identifiant local reste celui du client quand il existe : les
           chapitres, la progression et les statistiques y font référence par
           cet id. Pour une matière importée, il n'y en a pas — l'uuid de la
           ligne fait office d'id, exactement comme le fait déjà
           bsPullIntoLocalState(). */
        id: r.local_id || r.id,
        name: r.name || "",
        semesterId: r.semester_id || null,
        icon: r.icon || "",
        color: r.color || "",
        description: r.description || "",
        builtin: false,
        source: r.source || "manual",
        externalId: r.external_id || undefined,
        syncStatus: r.sync_status || undefined,
        _row: r.id,
      }));
    },
  };

  /* ── CHAPITRES / COURS / FICHES / QUIZ IA / FLASHCARDS IA ────────────────
     Une seule table, volontairement : c'est déjà comme ça que l'application
     manipule un chapitre (un seul objet). Voir l'arbitrage documenté dans
     schema.sql — l'éclater ajouterait des jointures sans bénéfice.

     `subject_id` est une VRAIE clé étrangère (uuid), alors que le client ne
     connaît que l'id local de la matière : on la résout au moment de l'écriture
     à partir des matières qu'on vient d'écrire. Un chapitre dont la matière est
     introuvable n'est pas poussé — plutôt que d'inventer un rattachement. */
  const CHAPTERS = {
    name: "chapters",
    table: "chapters",
    keyCol: "local_id",
    conflict: "user_id,local_id",
    rows(snap, userId, ctx){
      const byLocal = (ctx && ctx.subjectIdByLocal) || {};
      return (snap.chapters || [])
        .filter(c => c && c.id && isManual(c))
        .map(c => {
          const subjectUuid = byLocal[String(c.subjectId)];
          if (!subjectUuid) return null;
          return {
            user_id: userId,
            subject_id: subjectUuid,
            local_id: String(c.id),
            num: c.num === undefined || c.num === null ? null : String(c.num),
            title: String(c.title || ""),
            description: c.desc || null,
            content: c.content || null,
            original_text: c.originalText || null,
            summary: c.summary || null,
            ai_quiz: c.aiQuiz || [],
            ai_flashcards: c.aiFlashcards || [],
            ai_review_questions: c.aiReviewQuestions || [],
            key_notions: c.keyNotions || [],
            source_file_name: c.sourceFileName || null,
            page_count: c.pageCount === undefined ? null : c.pageCount,
            has_original_file: !!c.hasOriginalFile,
            level: c.level || null,
            marked_reviewed: !!c.markedReviewed,
            generation_pending: !!c.generationPending,
            heuristic_mode: !!c.heuristicMode,
            source: "manual",
            resources: c.resources || [],
          };
        })
        .filter(Boolean);
    },
    apply(rows, patch, ctx){
      const localBySubjectUuid = (ctx && ctx.subjectLocalByUuid) || {};
      patch.chapters = (rows || []).map(r => ({
        id: r.local_id || r.id,
        subjectId: localBySubjectUuid[r.subject_id] || r.subject_id,
        num: r.num || "",
        title: r.title || "",
        desc: r.description || "",
        content: r.content || "",
        originalText: r.original_text || "",
        summary: r.summary || "",
        aiQuiz: r.ai_quiz || [],
        aiFlashcards: r.ai_flashcards || [],
        aiReviewQuestions: r.ai_review_questions || [],
        keyNotions: r.key_notions || [],
        sourceFileName: r.source_file_name || undefined,
        pageCount: r.page_count === null ? undefined : r.page_count,
        hasOriginalFile: !!r.has_original_file,
        level: r.level || undefined,
        markedReviewed: !!r.marked_reviewed,
        generationPending: !!r.generation_pending,
        heuristicMode: !!r.heuristic_mode,
        createdAt: ms(r.created_at) || Date.now(),
        updatedAt: ms(r.updated_at) || Date.now(),
        source: r.source || "manual",
        externalId: r.external_id || undefined,
        syncStatus: r.sync_status || undefined,
        resources: r.resources || [],
      }));
    },
  };

  /* ── PROGRESSION QUIZ ET FLASHCARDS ───────────────────────────────────────
     Une seule table `progress` avec une colonne `kind`, comme prévu par le
     schéma. `best` est monotone (un meilleur score ne se perd pas) : la
     fusion prend le maximum. `attempts` aussi. */
  function progressDomain(name, kind, snapKey){
    return {
      name: name,
      table: "progress",
      keyCol: "scope",
      conflict: "user_id,kind,scope",
      /* Deux domaines partagent la table : les suppressions doivent rester
         cantonnées à leur propre `kind`. */
      deleteFilter: { kind: kind },
      selectFilter: { kind: kind },
      monotonic: ["best", "attempts"],
      rows(snap, userId){
        const src = snap[snapKey] || {};
        return Object.keys(src).map(scope => ({
          user_id: userId,
          kind: kind,
          scope: String(scope),
          best: num(src[scope] && src[scope].best, 0),
          attempts: num(src[scope] && src[scope].attempts, 0),
        }));
      },
      apply(rows, patch){
        const out = {};
        (rows || []).forEach(r => { out[r.scope] = { best: num(r.best, 0), attempts: num(r.attempts, 0) }; });
        patch[snapKey] = out;
      },
    };
  }
  const QUIZ_PROGRESS  = progressDomain("quizProgress",  "quiz",      "quizProgress");
  const FLASH_PROGRESS = progressDomain("flashProgress", "flashcard", "flashProgress");

  /* ── MAÎTRISE PAR QUESTION ────────────────────────────────────────────────
     `data` reste un sac jsonb : c'est déjà comme ça que le client le manipule
     (jamais champ par champ côté serveur). La clé est `question_uid`, un hash
     STABLE du contenu de la question — pas un index positionnel. */
  const QSTATS = {
    name: "qstats",
    table: "question_stats",
    keyCol: "question_uid",
    conflict: "user_id,question_uid",
    rows(snap, userId){
      const src = snap.qstats || {};
      return Object.keys(src).map(uid => ({
        user_id: userId,
        question_uid: String(uid),
        data: src[uid] || {},
      }));
    },
    apply(rows, patch){
      const out = {};
      (rows || []).forEach(r => { out[r.question_uid] = r.data || {}; });
      patch.qstats = out;
    },
  };

  /* ── HISTORIQUE D'EXAMENS ─────────────────────────────────────────────────
     Un journal : union, jamais remplacement. La date du passage sert de clé
     naturelle (colonne `taken_at`, migration 005) — sans elle, deux appareils
     poussant le même examen créaient deux lignes.

     Le client n'en garde que 20 ; la base garde tout. À la lecture on redonne
     au client ce qu'il sait afficher, trié du plus récent au plus ancien. */
  const EXAM_HISTORY = {
    name: "examHistory",
    table: "exam_history",
    keyCol: null,              // journal : on n'efface jamais une ligne passée
    conflict: "user_id,taken_at",
    rows(snap, userId){
      return (snap.examHistory || [])
        .map(e => {
          const takenAt = e && e.date ? e.date : null;
          if (!takenAt || !isFinite(Date.parse(takenAt))) return null;
          return { user_id: userId, taken_at: new Date(takenAt).toISOString(), data: e };
        })
        .filter(Boolean);
    },
    apply(rows, patch){
      patch.examHistory = (rows || [])
        .slice()
        .sort((a, b) => (ms(b.taken_at) || 0) - (ms(a.taken_at) || 0))
        .map(r => r.data)
        .filter(Boolean);
    },
  };

  /* ── RÉUSSITES ────────────────────────────────────────────────────────────
     Journal lui aussi : un badge obtenu ne se retire pas. */
  const BADGES = {
    name: "badges",
    table: "badges",
    keyCol: null,
    conflict: "user_id,badge_id",
    rows(snap, userId){
      const src = snap.badges || {};
      return Object.keys(src).map(id => {
        const earned = src[id] && src[id].earnedDate;
        return {
          user_id: userId,
          badge_id: String(id),
          /* earnedDate est un jour ("AAAA-MM-JJ") côté client, la colonne est
             un timestamptz : on prend midi UTC pour éviter qu'un fuseau
             négatif ne fasse reculer la date d'un jour à l'aller-retour. */
          earned_date: isDay(earned) ? (earned + "T12:00:00Z") : new Date().toISOString(),
        };
      });
    },
    apply(rows, patch){
      const out = {};
      (rows || []).forEach(r => {
        const d = dayKey(r.earned_date) || (ms(r.earned_date) ? dayKey(new Date(ms(r.earned_date))) : null);
        out[r.badge_id] = { earnedDate: d };
      });
      patch.badges = out;
    },
  };

  /* ── FLASHCARDS IA DU PROGRAMME INTÉGRÉ ──────────────────────────────────
     Distinct de chapters.ai_flashcards : ici ce sont les cartes générées sur
     les chapitres EN DUR du site, qui n'ont pas de ligne `chapters`. */
  const AI_CARDS = {
    name: "aiCards",
    table: "ai_cards",
    keyCol: "builtin_chapter_id",
    conflict: "user_id,builtin_chapter_id",
    rows(snap, userId){
      const src = snap.aiCards || {};
      return Object.keys(src)
        .filter(id => Array.isArray(src[id]) && src[id].length)
        .map(id => ({ user_id: userId, builtin_chapter_id: String(id), cards: src[id] }));
    },
    apply(rows, patch){
      const out = {};
      (rows || []).forEach(r => { out[r.builtin_chapter_id] = r.cards || []; });
      patch.aiCards = out;
    },
  };

  /* ── NOTES DE COURS ───────────────────────────────────────────────────────
     Notes/résumé/questions/checklist par événement d'emploi du temps. */
  const COURSE_NOTES = {
    name: "courseData",
    table: "course_notes",
    keyCol: "event_id",
    conflict: "user_id,event_id",
    rows(snap, userId){
      const src = snap.courseData || {};
      return Object.keys(src).map(eventId => ({
        user_id: userId,
        event_id: String(eventId),
        data: src[eventId] || {},
      }));
    },
    apply(rows, patch){
      const out = {};
      (rows || []).forEach(r => { out[r.event_id] = r.data || {}; });
      patch.courseData = out;
    },
  };

  /* ── EMPLOI DU TEMPS ──────────────────────────────────────────────────────
     Les événements voyagent (ils peuvent être annotés/modifiés localement,
     pas seulement importés passivement depuis l'URL .ics). */
  const PLANNING_EVENTS = {
    name: "planningEvents",
    table: "planning_events",
    keyCol: "local_id",
    conflict: "user_id,local_id",
    rows(snap, userId){
      const evs = (snap.planning && snap.planning.events) || [];
      return evs
        .filter(e => e && e.id)
        .map(e => ({ user_id: userId, local_id: String(e.id), data: e }));
    },
    apply(rows, patch){
      patch.planningEvents = (rows || [])
        .map(r => r.data)
        .filter(Boolean)
        .sort((a, b) => num(a.start, 0) - num(b.start, 0));
    },
  };

  /* ── HISTORIQUE IA ────────────────────────────────────────────────────────
     Une seule ligne par utilisateur : historique court et plafonné, pas une
     collection qui grossit sans fin. */
  const AI_HISTORY = {
    name: "aiHistory",
    table: "ai_history",
    keyCol: null,
    conflict: "user_id",
    single: true,
    rows(snap, userId){
      return [{ user_id: userId, history: (snap.aiHistory || []).slice(-20) }];
    },
    apply(rows, patch){
      const r = (rows || [])[0];
      patch.aiHistory = (r && r.history) || [];
    },
  };

  /* ── PRÉFÉRENCES ──────────────────────────────────────────────────────────
     Réglages d'interface et URL du flux d'emploi du temps. Purement locales en
     apparence, mais l'utilisateur s'attend à retrouver son flux .ics sur son
     téléphone sans le ressaisir — c'est donc bien une donnée de compte. */
  const PREFERENCES = {
    name: "prefs",
    table: "preferences",
    keyCol: null,
    conflict: "user_id",
    single: true,
    rows(snap, userId){
      const p = snap.prefs || {};
      const side = (p.aiBubbleSide === "left" || p.aiBubbleSide === "right") ? p.aiBubbleSide : null;
      const model = (p.aiModelChoice === "auto" || p.aiModelChoice === "small" || p.aiModelChoice === "large")
        ? p.aiModelChoice : null;
      return [{
        user_id: userId,
        ai_bubble_side: side,
        ai_bubble_y: typeof p.aiBubbleY === "number" ? p.aiBubbleY : null,
        ai_model_choice: model,
        planning_official_url: (snap.planning && snap.planning.officialUrl) || null,
        planning_last_sync_at: iso(snap.planning && snap.planning.lastSyncAt),
      }];
    },
    apply(rows, patch){
      const r = (rows || [])[0] || {};
      patch.prefs = {
        aiBubbleSide: r.ai_bubble_side || null,
        aiBubbleY: r.ai_bubble_y === null || r.ai_bubble_y === undefined ? null : Number(r.ai_bubble_y),
        aiModelChoice: r.ai_model_choice || null,
      };
      patch.planningOfficialUrl = r.planning_official_url || "";
      patch.planningLastSyncAt = ms(r.planning_last_sync_at);
    },
  };

  /* ── DOCUMENTS ────────────────────────────────────────────────────────────
     MÉTADONNÉES SEULEMENT. Le contenu binaire (jusqu'à ~3 Mo par fichier)
     reste strictement local à l'appareil : la décision du 19/09 est conservée
     telle quelle, et `has_local_content` dit honnêtement à l'appareil B que le
     fichier lui-même n'est pas là. Mieux vaut un document listé mais
     inaccessible, avec son nom, qu'un document invisible. */
  const DOCUMENTS = {
    name: "documents",
    table: "documents",
    keyCol: "local_id",
    conflict: "user_id,local_id",
    rows(snap, userId, ctx){
      const byLocal = (ctx && ctx.subjectIdByLocal) || {};
      return (snap.documents || [])
        .filter(d => d && d.id)
        .map(d => ({
          user_id: userId,
          local_id: String(d.id),
          name: String(d.name || ""),
          type: (d.type === "document" || d.type === "resume" || d.type === "sujet") ? d.type : "document",
          mime: d.mime || null,
          subject_id: byLocal[String(d.subjectId)] || null,
          added_at: iso(d.addedAt),
          has_local_content: !!(d.dataUrl || d.content),
        }));
    },
    apply(rows, patch, ctx){
      const localByUuid = (ctx && ctx.subjectLocalByUuid) || {};
      /* Le binaire n'est jamais en base : il est dans le cache de CET
         appareil. On le RÉCUPÈRE du local plutôt que de le perdre — sans ça,
         se connecter effacerait le contenu de ses propres documents. */
      const localById = {};
      ((ctx && ctx.local && ctx.local.documents) || []).forEach(d => { if (d && d.id) localById[String(d.id)] = d; });

      patch.documents = (rows || []).map(r => {
        const id = String(r.local_id || r.id);
        const here = localById[id];
        const doc = {
          id: id,
          name: r.name || "",
          type: r.type || "document",
          mime: r.mime || "",
          addedAt: ms(r.added_at) || Date.now(),
        };
        const subj = r.subject_id ? (localByUuid[r.subject_id] || r.subject_id) : undefined;
        if (subj !== undefined) doc.subjectId = subj;
        if (here && here.dataUrl) doc.dataUrl = here.dataUrl;
        if (here && here.content !== undefined) doc.content = here.content;
        /* Le fichier existe pour ce compte, mais son contenu est resté sur
           l'appareil qui l'a importé. On le DIT, plutôt que d'ouvrir un
           document vide : un nom listé vaut mieux qu'un document invisible,
           et un mensonge vaut moins que les deux. */
        if (!doc.dataUrl && doc.content === undefined) doc.contentMissing = true;
        return doc;
      });
    },
  };

  /* ── PLANNING INTELLIGENT ─────────────────────────────────────────────────
     Une seule ligne : l'application ne manipule qu'un plan à la fois. */
  const STUDY_PLAN = {
    name: "studyPlan",
    table: "study_plans",
    keyCol: null,
    conflict: "user_id",
    single: true,
    rows(snap, userId){
      const p = snap.studyPlan;
      if (!p) return [];
      return [{
        user_id: userId,
        plan_id: p.id ? String(p.id) : null,
        goal: p.goal || null,
        deadline_at: iso(p.deadlineAt),
        deadline_label: p.deadlineLabel || null,
        deadline_event_id: p.deadlineEventId || null,
        subject_ids: p.subjectIds || [],
        chapter_ids: p.chapterIds || [],
        availability: p.availability || {},
        days: p.days || [],
        last_checked_missed_at: p.lastCheckedMissedAt || null,
        last_replan_message: p.lastReplanMessage || null,
      }];
    },
    apply(rows, patch){
      const r = (rows || [])[0];
      if (!r) { patch.studyPlan = null; return; }
      patch.studyPlan = {
        id: r.plan_id || null,
        goal: r.goal || "",
        deadlineAt: ms(r.deadline_at),
        deadlineLabel: r.deadline_label || "",
        deadlineEventId: r.deadline_event_id || null,
        subjectIds: r.subject_ids || [],
        chapterIds: r.chapter_ids || [],
        availability: r.availability || {},
        days: r.days || [],
        lastCheckedMissedAt: r.last_checked_missed_at || null,
        lastReplanMessage: r.last_replan_message || null,
      };
    },
  };

  /* ── STATISTIQUES : QUATRE TABLES POUR UN SEUL `state.dash` ───────────────
     `state.dash` n'est pas un objet : c'est quatre choses agrégées par
     commodité côté client (compteurs, séries par jour, journal d'activités,
     chapitres récemment ouverts). La migration 002 les a séparées selon leur
     nature réelle ; on respecte ce découpage, qui est ce qui permet la fusion
     par maximum sur les compteurs.

     `wrongQuestions` n'est VOLONTAIREMENT pas stocké : il duplique
     `question_stats` et il est indexé par un INDEX POSITIONNEL dans le tableau
     des questions — insérer une question au milieu du programme décalerait
     silencieusement toutes ses clés. Il est reconstruit à la lecture, à partir
     de `question_stats` dont la clé (`uid`) est stable. Voir rebuildWrong(). */

  const USER_STATS = {
    name: "userStats",
    table: "user_stats",
    keyCol: null,
    conflict: "user_id",
    single: true,
    monotonic: ["total_answered", "total_correct", "time_spent_seconds",
                "best_correct_streak", "quizzes_completed"],
    rows(snap, userId){
      const d = snap.dash || {};
      return [{
        user_id: userId,
        total_answered: num(d.totalAnswered, 0),
        total_correct: num(d.totalCorrect, 0),
        time_spent_seconds: Math.round(num(d.timeSpentSeconds, 0)),
        correct_streak: num(d.correctStreak, 0),
        best_correct_streak: num(d.bestCorrectStreak, 0),
        quizzes_completed: num(d.quizzesCompleted, 0),
        best90_achieved: !!d.best90Achieved,
        recent_adds: (d.recentAdds || []).slice(0, 5),
      }];
    },
    apply(rows, patch){
      const r = (rows || [])[0] || {};
      patch.userStats = {
        totalAnswered: num(r.total_answered, 0),
        totalCorrect: num(r.total_correct, 0),
        timeSpentSeconds: num(r.time_spent_seconds, 0),
        correctStreak: num(r.correct_streak, 0),
        bestCorrectStreak: num(r.best_correct_streak, 0),
        quizzesCompleted: num(r.quizzes_completed, 0),
        best90Achieved: !!r.best90_achieved,
        recentAdds: r.recent_adds || [],
      };
    },
  };

  /* Fusionne les trois dictionnaires par date de state.dash en une ligne par
     jour. L'existence de la ligne vaut « jour actif » : activityDates n'a plus
     besoin d'être stocké séparément, c'était la même information en double. */
  const DAILY_STATS = {
    name: "dailyStats",
    table: "daily_stats",
    keyCol: "day",
    conflict: "user_id,day",
    monotonic: ["answered", "correct", "time_seconds"],
    rows(snap, userId){
      const d = snap.dash || {};
      const days = {};
      Object.keys(d.dailyStats || {}).forEach(k => { if (isDay(k)) days[k] = true; });
      Object.keys(d.dailyTimeSeconds || {}).forEach(k => { if (isDay(k)) days[k] = true; });
      (d.activityDates || []).forEach(k => { if (isDay(k)) days[k] = true; });
      return Object.keys(days).map(day => {
        const s = (d.dailyStats || {})[day] || {};
        return {
          user_id: userId,
          day: day,
          answered: num(s.answered, 0),
          correct: num(s.correct, 0),
          time_seconds: Math.round(num((d.dailyTimeSeconds || {})[day], 0)),
        };
      });
    },
    apply(rows, patch){
      const dailyStats = {}, dailyTimeSeconds = {}, activityDates = [];
      (rows || []).forEach(r => {
        const day = dayKey(r.day);
        if (!day) return;
        dailyStats[day] = { answered: num(r.answered, 0), correct: num(r.correct, 0) };
        dailyTimeSeconds[day] = num(r.time_seconds, 0);
        activityDates.push(day);
      });
      activityDates.sort();
      patch.dailyStats = dailyStats;
      patch.dailyTimeSeconds = dailyTimeSeconds;
      patch.activityDates = activityDates;
    },
  };

  /* Journal des sessions. Le client en garde 20 ; la base garde tout — c'est
     tout l'intérêt de la centralisation, les statistiques d'évolution ne sont
     plus limitées aux 20 dernières. */
  const ACTIVITIES = {
    name: "activities",
    table: "activities",
    keyCol: null,              // journal : union
    conflict: "user_id,ts",
    rows(snap, userId){
      const d = snap.dash || {};
      return (d.recentActivity || [])
        .map(a => {
          if (!a || !a.ts) return null;
          const at = Date.parse(a.ts);
          if (!isFinite(at)) return null;
          const day = a.date && isDay(a.date) ? a.date : new Date(at).toISOString().slice(0, 10);
          const row = {
            user_id: userId,
            ts: new Date(at).toISOString(),
            day: day,
            type: String(a.type || "quiz"),
            scope: a.scope || null,
            label: a.label || null,
          };
          /* Les colonnes chiffrées portent des contraintes CHECK : on n'écrit
             que des valeurs qui les respectent, jamais une valeur bricolée
             pour « passer ». Une donnée absente reste absente. */
          if (isFinite(Number(a.score)) && Number(a.score) >= 0) row.score = Math.round(Number(a.score));
          if (isFinite(Number(a.total)) && Number(a.total) >= 0) row.total = Math.round(Number(a.total));
          const pct = Number(a.pct);
          if (isFinite(pct) && pct >= 0 && pct <= 100) row.pct = Math.round(pct);
          if (isFinite(Number(a.timeUsed)) && Number(a.timeUsed) >= 0) row.time_used = Math.round(Number(a.timeUsed));
          return row;
        })
        .filter(Boolean);
    },
    apply(rows, patch){
      patch.recentActivity = (rows || [])
        .slice()
        .sort((a, b) => (ms(b.ts) || 0) - (ms(a.ts) || 0))
        .slice(0, 20)
        .map(r => {
          const a = { type: r.type, ts: new Date(ms(r.ts) || 0).toISOString(), date: dayKey(r.day) };
          if (r.scope !== null && r.scope !== undefined) a.scope = r.scope;
          if (r.label !== null && r.label !== undefined) a.label = r.label;
          if (r.score !== null && r.score !== undefined) a.score = r.score;
          if (r.total !== null && r.total !== undefined) a.total = r.total;
          if (r.pct !== null && r.pct !== undefined) a.pct = r.pct;
          if (r.time_used !== null && r.time_used !== undefined) a.timeUsed = r.time_used;
          return a;
        });
    },
  };

  /* Ouvrir une fiche n'est pas terminer une session : distinct de `activities`,
     comme côté client (trackChapterVisit ≠ logActivity). */
  const CHAPTER_VISITS = {
    name: "chapterVisits",
    table: "chapter_visits",
    keyCol: "chapter_key",
    conflict: "user_id,chapter_key",
    rows(snap, userId){
      const d = snap.dash || {};
      return (d.recentChapters || [])
        .filter(c => c && c.chapterId)
        .map(c => ({
          user_id: userId,
          chapter_key: String(c.chapterId),
          kind: c.type || null,
          visited_at: iso(c.ts) || new Date().toISOString(),
        }));
    },
    apply(rows, patch){
      patch.recentChapters = (rows || [])
        .slice()
        .sort((a, b) => (ms(b.visited_at) || 0) - (ms(a.visited_at) || 0))
        .slice(0, 8)
        .map(r => ({ chapterId: r.chapter_key, type: r.kind || undefined, ts: ms(r.visited_at) || Date.now() }));
    },
  };

  /* L'ordre compte : les matières d'abord (les chapitres et les documents ont
     besoin de leur uuid), puis tout le reste. */
  const DOMAINS = [
    SUBJECTS, CHAPTERS,
    QUIZ_PROGRESS, FLASH_PROGRESS, QSTATS,
    EXAM_HISTORY, BADGES, AI_CARDS, COURSE_NOTES,
    PLANNING_EVENTS, AI_HISTORY, PREFERENCES, DOCUMENTS, STUDY_PLAN,
    USER_STATS, DAILY_STATS, ACTIVITIES, CHAPTER_VISITS,
  ];
  const BY_NAME = {};
  DOMAINS.forEach(d => { BY_NAME[d.name] = d; });

  /* Quels domaines une clé de stockage local touche-t-elle. C'est la table de
     correspondance qui permet de brancher la synchronisation sur `lsSet()` —
     un seul point de passage, donc aucun appel oublié, ni aujourd'hui ni
     quand une fonctionnalité sera ajoutée. */
  const DOMAINS_BY_STORAGE_KEY = {
    "user-subjects":    ["subjects"],
    "user-chapters":    ["chapters"],
    "quiz-progress":    ["quizProgress"],
    "flashcard-progress": ["flashProgress"],
    "question-stats":   ["qstats"],
    "exam-history":     ["examHistory"],
    "badges":           ["badges"],
    "ai-flashcards":    ["aiCards"],
    "course-data":      ["courseData"],
    "planning":         ["planningEvents", "prefs"],
    "ai-history":       ["aiHistory"],
    "documents":        ["documents"],
    "study-plan":       ["studyPlan"],
    "dashboard-stats":  ["userStats", "dailyStats", "activities", "chapterVisits"],
    "ai-bubble-pos":    ["prefs"],
    "ai-model-choice":  ["prefs"],
  };

  /* ═════════════════════════════════════════════════════════════════════════
     RECONSTRUCTION DES ERREURS RÉCENTES
     ─────────────────────────────────────────────────────────────────────────
     `state.dash.wrongQuestions` n'est pas stocké (voir plus haut). On le
     reconstruit depuis `question_stats`, dont on dispose de l'historique des
     dix dernières réponses : le nombre d'échecs consécutifs est exactement le
     nombre de zéros en fin d'historique. Au-delà de dix échecs d'affilée sur
     la même question, le compte est plafonné — et dire « au moins dix » est
     plus honnête que d'inventer un chiffre.

     `questionByUid` est fourni par l'appelant (index.html connaît QUESTIONS,
     ce module non). Sans lui, la reconstruction est simplement vide : aucune
     invention.
     ═════════════════════════════════════════════════════════════════════════ */
  function rebuildWrongQuestions(qstats, questionByUid){
    const out = {};
    if (!qstats || !questionByUid) return out;
    Object.keys(qstats).forEach(uid => {
      const s = qstats[uid];
      if (!s || s.last !== "ko") return;
      const q = questionByUid[uid];
      if (!q || q.id === undefined || q.id === null) return;
      const hist = Array.isArray(s.history) ? s.history : [];
      let run = 0;
      for (let i = hist.length - 1; i >= 0 && !hist[i]; i--) run++;
      out[q.id] = {
        theme: s.theme || q.theme,
        q: q.q,
        wrongCount: Math.max(1, run),
        lastWrong: s.lastDate || null,
      };
    });
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     LE CLIENT DE PERSISTANCE
     ═════════════════════════════════════════════════════════════════════════ */

  /* LA clé naturelle d'une ligne, normalisée — une seule définition, utilisée
     partout (lecture, fusion, suppression). C'est indispensable : une colonne
     `date` revient en objet Date depuis la base et en chaîne « AAAA-MM-JJ »
     depuis le client. Deux normalisations différentes, et la ligne lue ne se
     reconnaît plus dans la ligne écrite : la fusion ne s'applique pas, et pire,
     la suppression croit que la ligne a disparu et l'efface. */
  function rowKey(domain, row){
    if (!domain.keyCol) return null;
    const raw = row[domain.keyCol];
    if (raw === null || raw === undefined) return null;
    return domain.keyCol === "day" ? dayKey(raw) : String(raw);
  }

  function createCloud(opts){
    const o = opts || {};
    const client = o.client;
    const userId = o.userId;
    if (!client) throw new Error("LyonUserData.createCloud : client Supabase manquant.");
    if (!userId) throw new Error("LyonUserData.createCloud : userId manquant.");

    const debounceMs = o.debounceMs === undefined ? 900 : o.debounceMs;
    const onStatus = typeof o.onStatus === "function" ? o.onStatus : function(){};
    const now = typeof o.now === "function" ? o.now : (() => Date.now());

    /* Les clés que CET appareil a vues, par domaine. Sert uniquement à décider
       ce qu'on a le droit de supprimer — jamais à décider ce qu'on écrit. */
    const knownKeys = {};
    DOMAINS.forEach(d => { knownKeys[d.name] = new Set(); });

    /* Correspondances matière : id local ↔ uuid. Remplies au pull et après
       chaque écriture de matières ; les chapitres et documents en dépendent. */
    const ctx = { subjectIdByLocal: {}, subjectLocalByUuid: {} };

    let pending = new Set();       // domaines à pousser
    let timer = null;
    let inFlight = null;           // promesse du cycle d'écriture en cours
    let lastSnapshot = null;       // fourni par l'appelant, relu à chaque cycle
    let snapshotFn = typeof o.snapshot === "function" ? o.snapshot : null;
    const errors = [];

    function currentSnapshot(){
      if (snapshotFn) { try { return snapshotFn() || {}; } catch (e) { return lastSnapshot || {}; } }
      return lastSnapshot || {};
    }

    function rememberSubjects(rows){
      (rows || []).forEach(r => {
        if (!r || !r.id) return;
        const local = r.local_id || r.id;
        ctx.subjectIdByLocal[String(local)] = r.id;
        ctx.subjectLocalByUuid[r.id] = String(local);
      });
    }

    /* ── LECTURE ──────────────────────────────────────────────────────────── */

    async function readTable(domain){
      let q = client.from(domain.table).select("*").eq("user_id", userId);
      if (domain.selectFilter) {
        Object.keys(domain.selectFilter).forEach(k => { q = q.eq(k, domain.selectFilter[k]); });
      }
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    }

    /* Lit TOUT et retourne un instantané. Les erreurs sont collectées par
       domaine : un domaine en panne n'empêche pas les autres d'arriver. Mieux
       vaut un espace personnel presque complet qu'un écran vide. */
    /* `localSnapshot` : l'instantané actuel de l'appareil. Certains domaines
       en ont besoin pour ne pas écraser ce qui n'existe QUE localement — le
       binaire des documents, notamment. */
    async function pullAll(localSnapshot){
      onStatus({ phase: "pulling" });
      ctx.local = localSnapshot || currentSnapshot();
      const patch = {};
      const failed = [];

      /* Les matières d'abord : les chapitres et les documents ont besoin de la
         correspondance uuid ↔ id local. */
      try {
        const subjectRows = await readTable(SUBJECTS);
        rememberSubjects(subjectRows);
        knownKeys.subjects = new Set(subjectRows.map(r => rowKey(SUBJECTS, r)).filter(Boolean));
        SUBJECTS.apply(subjectRows, patch, ctx);
      } catch (e) {
        failed.push(fail("subjects", e));
      }

      for (const domain of DOMAINS) {
        if (domain === SUBJECTS) continue;
        try {
          const rows = await readTable(domain);
          if (domain.keyCol) {
            knownKeys[domain.name] = new Set(rows.map(r => rowKey(domain, r)).filter(Boolean));
          }
          domain.apply(rows, patch, ctx);
        } catch (e) {
          failed.push(fail(domain.name, e));
        }
      }

      onStatus({ phase: failed.length ? "partial" : "idle", errors: failed });
      return { snapshot: patch, errors: failed };
    }

    /* ── ÉCRITURE ─────────────────────────────────────────────────────────── */

    /* Fusion par maximum pour les compteurs monotones : on lit la valeur
       distante, on garde la plus grande. C'est ce qui empêche un appareil en
       retard de faire redescendre un compteur — la perte silencieuse que la
       demande interdit explicitement. */
    async function mergeMonotonic(domain, rows){
      if (!domain.monotonic || !rows.length) return rows;
      let remote = [];
      try { remote = await readTable(domain); } catch (e) { return rows; }
      const keyOf = (r) => domain.keyCol ? rowKey(domain, r) : "@single";
      const byKey = {};
      remote.forEach(r => { byKey[keyOf(r)] = r; });
      return rows.map(r => {
        const prev = byKey[keyOf(r)];
        if (!prev) return r;
        const merged = Object.assign({}, r);
        domain.monotonic.forEach(col => {
          merged[col] = Math.max(num(r[col], 0), num(prev[col], 0));
        });
        /* best90_achieved ne redescend pas non plus : une fois atteint, atteint. */
        if ("best90_achieved" in r) merged.best90_achieved = !!r.best90_achieved || !!prev.best90_achieved;
        return merged;
      });
    }

    async function writeDomain(domain, snap){
      const rows = domain.rows(snap, userId, ctx) || [];
      const merged = await mergeMonotonic(domain, rows);

      if (merged.length) {
        for (const part of chunk(merged)) {
          const { data, error } = await client
            .from(domain.table)
            .upsert(part, { onConflict: domain.conflict })
            .select();
          if (error) throw error;
          if (domain === SUBJECTS) rememberSubjects(data);
        }
      }

      /* Suppressions : uniquement parmi ce que cet appareil a vu (voir
         l'en-tête). Un domaine « journal » (keyCol null) n'efface jamais. */
      if (domain.keyCol) {
        const live = new Set(merged.map(r => rowKey(domain, r)).filter(Boolean));
        const gone = [...knownKeys[domain.name]].filter(k => !live.has(k));
        if (gone.length) {
          for (const part of chunk(gone)) {
            let q = client.from(domain.table).delete().eq("user_id", userId).in(domain.keyCol, part);
            if (domain.deleteFilter) {
              Object.keys(domain.deleteFilter).forEach(k => { q = q.eq(k, domain.deleteFilter[k]); });
            }
            const { error } = await q;
            if (error) throw error;
          }
        }
        knownKeys[domain.name] = live;
      }
      return merged.length;
    }

    async function runCycle(){
      const todo = [...pending];
      pending = new Set();
      if (!todo.length) return { ok: true, written: 0, errors: [] };

      const snap = currentSnapshot();
      onStatus({ phase: "pushing", domains: todo });

      /* Les matières d'abord si elles font partie du lot : les chapitres et
         les documents ont besoin de leur uuid. */
      const ordered = DOMAINS.filter(d => todo.indexOf(d.name) !== -1);
      const failed = [];
      let written = 0;

      for (const domain of ordered) {
        try {
          written += await writeDomain(domain, snap);
        } catch (e) {
          failed.push(fail(domain.name, e));
          /* On remet le domaine en file : la prochaine occasion (nouvelle
             écriture, reconnexion, flush explicite) réessaiera. Rien n'est
             perdu — la donnée est toujours dans le cache local. */
          pending.add(domain.name);
        }
      }

      failed.forEach(f => errors.push(f));
      onStatus({ phase: failed.length ? "error" : "idle", errors: failed, at: now() });
      return { ok: !failed.length, written: written, errors: failed };
    }

    function schedule(){
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        inFlight = (inFlight || Promise.resolve()).then(runCycle);
      }, debounceMs);
    }

    /* API publique -------------------------------------------------------- */

    return {
      /* Marque un ou plusieurs domaines comme à pousser. Regroupé et différé :
         terminer un quiz écrit quatre clés locales d'affilée, ça ne doit pas
         faire quatre allers-retours réseau. */
      push(domainNames){
        const names = Array.isArray(domainNames) ? domainNames : [domainNames];
        let any = false;
        names.forEach(n => { if (BY_NAME[n]) { pending.add(n); any = true; } });
        if (any) schedule();
        return any;
      },

      /* Pousse TOUT, immédiatement. Utilisé par la migration des données
         locales existantes, jamais dans le fonctionnement courant. */
      pushAll(snap){
        lastSnapshot = snap || lastSnapshot;
        DOMAINS.forEach(d => pending.add(d.name));
        if (timer) { clearTimeout(timer); timer = null; }
        inFlight = (inFlight || Promise.resolve()).then(runCycle);
        return inFlight;
      },

      pullAll,

      /* Attend que tout ce qui est en attente soit réellement écrit. À appeler
         avant de purger le cache local à la déconnexion : purger avant d'avoir
         poussé perdrait la donnée pour de bon. */
      async flush(){
        if (timer) { clearTimeout(timer); timer = null; }
        if (pending.size) inFlight = (inFlight || Promise.resolve()).then(runCycle);
        const r = await (inFlight || Promise.resolve({ ok: true, written: 0, errors: [] }));
        return { ok: !!(r && r.ok) && pending.size === 0, pending: [...pending] };
      },

      setSnapshotSource(fn){ snapshotFn = typeof fn === "function" ? fn : null; },
      get userId(){ return userId; },
      get pendingDomains(){ return [...pending]; },
      get errors(){ return errors.slice(); },
    };
  }

  global.LyonUserData = {
    createCloud,
    rebuildWrongQuestions,
    DOMAINS_BY_STORAGE_KEY,
    domainNames: DOMAINS.map(d => d.name),
    // exposés pour les tests
    _domains: BY_NAME,
    _chunk: chunk,
  };

})(typeof window !== "undefined" ? window : globalThis);
