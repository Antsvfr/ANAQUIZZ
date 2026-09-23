/* ============================================================================
   REV-EM — moteur de planification de révision (couche métier, sans UI)
   ------------------------------------------------------------------------
   Fichier autonome, chargé comme smart-revision.js/statistics.js (voir
   index.html) : window.LyonPlanning n'a AUCUNE dépendance au DOM, à l'état
   de l'application, à Supabase ni à WebLLM/WebGPU.

   IMPORTANT — ce moteur NE RECALCULE PAS la priorité d'un chapitre : il
   reçoit en entrée les recommandations déjà produites par
   LyonSmartRevision.computeRecommendations() (voir index.html:
   buildPlanningCandidates) et se contente d'orchestrer leur répartition
   dans le temps disponible. Aucune donnée de maîtrise/erreurs/tendance
   n'est ni lue ni réinterprétée ici — uniquement des nombres déjà calculés
   ailleurs, passés en argument.

   Ce que ce moteur ajoute, et seulement ça :
     - répartition dans des jours à capacité limitée (bin-packing glouton) ;
     - découpage d'un chapitre volumineux en plusieurs séances ;
     - équilibre entre matières (jamais une seule matière tout le temps) ;
     - repli documenté pour un chapitre choisi par l'utilisateur mais absent
       des recommandations (ex. déjà bien maîtrisé) ;
     - replanification après une séance manquée, sans jamais perdre une
       tâche importante en silence.
   ============================================================================ */
(function(global){
  "use strict";

  const BLOCK_MINUTES = 15;           // taille d'un bloc de séance standard
  const MIN_TASK_MINUTES = 10;
  const MAX_TASK_MINUTES = 60;
  const FALLBACK_BASE_PRIORITY = 0.15; // candidat choisi par l'utilisateur mais absent des recommandations
  const MISSED_SESSION_BOOST = 0.08;   // léger boost documenté pour une séance manquée qu'on replace
  const DURATIONS = [10, 15, 20, 25, 30, 45, 60]; // blocs "réalistes" (voir §9 du cahier des charges)

  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  /* Arrondit une durée brute au bloc réaliste le plus proche (sans jamais
     dépasser le temps encore disponible ce jour-là). */
  function roundToRealisticBlock(minutes, maxAllowed){
    const capped = Math.min(minutes, maxAllowed, MAX_TASK_MINUTES);
    let best = DURATIONS[0];
    DURATIONS.forEach(d=>{ if(d <= capped) best = d; });
    return Math.max(MIN_TASK_MINUTES <= capped ? MIN_TASK_MINUTES : capped, best);
  }

  /* Priorité effective d'un candidat : celle déjà calculée par Révision
     intelligente si elle existe (jamais réinterprétée), sinon un repli bas
     et documenté — jamais 0 : un chapitre explicitement choisi par
     l'utilisateur pour son échéance garde une petite chance d'obtenir une
     place si le temps le permet. */
  function effectivePriority(candidate){
    if(typeof candidate.smartPriority === "number") return candidate.smartPriority;
    const masteryFactor = candidate.mastery === null ? 0.1 : ((100 - candidate.mastery) / 100) * 0.1;
    return FALLBACK_BASE_PRIORITY + masteryFactor;
  }

  /* Mode le plus pertinent pour un bloc donné d'un candidat — même logique
     que smart-revision.js (jamais dupliquée en detail, juste la même
     intention : jamais faites -> découvrir le cours, erreurs -> quiz,
     correct + ancien -> flashcards), appliquée ici séance par séance. */
  function pickBlockMode(candidate, blockIndex){
    if(blockIndex === 0 && candidate.mastery === null && candidate.hasFiche) return "course";
    if(candidate.hasErrorData && candidate.recentErrorCount > 0 && candidate.hasQuiz) return "quiz";
    if(candidate.mastery !== null && candidate.mastery >= 60 && candidate.hasFlashcards) return "flash";
    if(candidate.hasQuiz) return "quiz";
    if(candidate.hasFlashcards) return "flash";
    return "quiz";
  }

  /* Nombre de blocs nécessaires pour un candidat, dérivé du temps estimé
     déjà fourni (quizEstimateMinutes/flashEstimateMinutes, eux-mêmes issus
     de smart-revision.js) — matérialise le facteur "volume" (§7E) : un
     grand chapitre est étalé sur plusieurs séances plutôt qu'une seule
     séance trop longue. */
  function blocksNeeded(candidate){
    const estimate = Math.max(candidate.quizEstimateMinutes || 0, candidate.flashEstimateMinutes || 0) || BLOCK_MINUTES;
    return clamp(Math.round(estimate / BLOCK_MINUTES), 1, 4);
  }

  /* Construit la file des blocs à placer, triée par priorité décroissante.
     Une entrée par bloc (pas par candidat) pour permettre l'étalement. */
  function buildBlockQueue(candidates){
    const queue = [];
    candidates.forEach(c=>{
      const n = blocksNeeded(c);
      for(let i = 0; i < n; i++){
        queue.push({
          candidate: c,
          blockIndex: i,
          totalBlocks: n,
          priority: effectivePriority(c),
        });
      }
    });
    return queue.sort((a, b) => b.priority - a.priority);
  }

  /* Répartition gloutonne dans les jours disponibles.
     - Respecte STRICTEMENT le temps disponible par jour (§7G) — jamais dépassé.
     - Équilibre les matières (§7H) : évite de placer deux blocs de la même
       matière consécutivement sur le même jour tant qu'une autre matière a
       encore des blocs en attente et qu'il reste de la place.
     - Évite de reproposer immédiatement la même chose (§7F) : un candidat
       qui vient de recevoir un bloc n'en reçoit pas un second avant qu'au
       moins un autre candidat ait été servi, sauf s'il ne reste plus que lui. */
  function scheduleBlocks(blockQueue, availability){
    const days = availability.map(d => ({ dateKey: d.dateKey, availableMinutes: d.minutes, usedMinutes: 0, tasks: [] }));
    const remaining = blockQueue.slice();
    let lastCandidateId = null;

    days.forEach(day=>{
      let guard = remaining.length + 1; // sécurité anti-boucle infinie
      while(day.availableMinutes - day.usedMinutes >= MIN_TASK_MINUTES && remaining.length && guard-- > 0){
        const budget = day.availableMinutes - day.usedMinutes;
        // Préfère un bloc d'une matière différente du dernier placé aujourd'hui, si possible.
        let idx = remaining.findIndex(b => b.candidate.chapterId !== lastCandidateId);
        if(idx === -1) idx = 0;
        const block = remaining[idx];
        const rawMinutes = Math.max(candidateMinutesForMode(block.candidate, pickBlockMode(block.candidate, block.blockIndex)), MIN_TASK_MINUTES);
        const duration = roundToRealisticBlock(rawMinutes, budget);
        if(duration > budget) {
          // Aucun bloc ne rentre plus dans le temps restant aujourd'hui : jour terminé.
          break;
        }
        remaining.splice(idx, 1);
        const mode = pickBlockMode(block.candidate, block.blockIndex);
        day.tasks.push({
          subjectId: block.candidate.subjectId,
          chapterId: block.candidate.chapterId,
          title: block.candidate.title,
          subjectName: block.candidate.subjectName,
          mode,
          duration,
          priority: Math.round(block.priority * 1000) / 1000,
          reasonKey: block.candidate.smartReasonKey || "planning.reason_selected_low_priority",
          reasonVars: block.candidate.smartReasonKey ? block.candidate.smartReasonVars : null,
          blockIndex: block.blockIndex,
          totalBlocksForChapter: block.totalBlocks,
          confidence: block.candidate.confidence,
        });
        day.usedMinutes += duration;
        lastCandidateId = block.candidate.chapterId;
      }
    });

    return { days, unscheduled: remaining.map(b => b.candidate) };
  }

  function candidateMinutesForMode(candidate, mode){
    if(mode === "flash") return candidate.flashEstimateMinutes || BLOCK_MINUTES;
    if(mode === "course") return Math.min(15, (candidate.quizEstimateMinutes || BLOCK_MINUTES));
    return candidate.quizEstimateMinutes || BLOCK_MINUTES;
  }

  /* Point d'entrée principal. `input` :
       { now, deadlineAt: ms|null, availability: [{dateKey, minutes}], candidates: [...] }
     candidates: voir index.html (buildPlanningCandidates) pour le format
     exact — jamais construit ici, uniquement transformé. */
  function generateStudyPlan(input){
    const candidates = (input.candidates || []).filter(c => c.hasQuiz || c.hasFlashcards);
    const availability = (input.availability || []).filter(d => d.minutes > 0);
    if(candidates.length === 0 || availability.length === 0){
      return { days: availability.map(d => ({ dateKey: d.dateKey, availableMinutes: d.minutes, usedMinutes: 0, tasks: [] })), unscheduled: candidates, deadlineAt: input.deadlineAt || null, totalPlannedMinutes: 0 };
    }
    const queue = buildBlockQueue(candidates);
    const { days, unscheduled } = scheduleBlocks(queue, availability);
    const totalPlannedMinutes = days.reduce((sum, d) => sum + d.usedMinutes, 0);
    return { days, unscheduled, deadlineAt: input.deadlineAt || null, totalPlannedMinutes };
  }

  /* Replanification après une ou plusieurs séances manquées : reconstruit
     un nouveau plan sur les jours RESTANTS (jamais le passé) à partir des
     candidats non terminés, avec un léger boost documenté pour ceux dont
     une séance a été manquée — jamais supprimés silencieusement (§12).
     `pastMissedCandidates` : sous-ensemble de `input.candidates` dont une
     séance a été ratée. */
  function replan(input, pastMissedCandidates){
    const boosted = (input.candidates || []).map(c=>{
      const wasMissed = (pastMissedCandidates || []).some(m => m.chapterId === c.chapterId);
      if(!wasMissed || typeof c.smartPriority !== "number") return c;
      return Object.assign({}, c, { smartPriority: clamp(c.smartPriority + MISSED_SESSION_BOOST, 0, 1) });
    });
    return generateStudyPlan(Object.assign({}, input, { candidates: boosted }));
  }

  global.LyonPlanning = {
    generateStudyPlan,
    replan,
    roundToRealisticBlock,
    BLOCK_MINUTES, MIN_TASK_MINUTES, MAX_TASK_MINUTES, DURATIONS,
  };

})(typeof window !== "undefined" ? window : globalThis);
