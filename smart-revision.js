/* ============================================================================
   Lyon Révision — moteur de révision intelligente (couche métier, sans UI)
   ------------------------------------------------------------------------
   Fichier autonome, chargé comme auth.js/translations.js (voir index.html) :
   window.LyonSmartRevision n'a AUCUNE dépendance au DOM, à l'état de
   l'application, à Supabase ni à WebLLM/WebGPU. Il ne fait que transformer
   des FAITS déjà connus par l'application — fournis en entrée par
   index.html, qui les lit depuis state.*, qstats, CHAPTERS, etc. — en une
   liste de recommandations priorisées et une proposition de session.

   Cette séparation permet de réutiliser exactement le même moteur depuis le
   dashboard, une page dédiée "Révision intelligente", et plus tard un
   assistant IA, une application mobile ou un planning automatique, sans
   jamais dupliquer la logique de calcul (voir index.html : buildChapterFacts /
   getSmartRevisionRecommendations font le pont entre l'état réel et ce
   moteur).

   Le moteur ne fabrique jamais de faiblesse : un chapitre sans donnée
   suffisante reçoit une confiance "insufficient"/"low" (voir buildConfidence)
   et une raison n'est choisie que si le fait qui la justifie est réellement
   présent dans l'entrée (voir pickReason). Aucun appel réseau, aucun calcul
   aléatoire : à faits identiques, la sortie est toujours identique
   (déterministe), ce qui permet de le tester avec de simples assertions.
   ============================================================================ */
(function(global){
  "use strict";

  /* Poids nommés et documentés — volontairement simples, pas une "science
     exacte" (voir le rapport d'étape pour la justification de chaque terme).
     Modifier un chiffre ici change le classement mais jamais la logique. */
  var WEIGHTS = {
    masteryBase: 0.5,          // poids de "100% - maîtrise" dans le score de base
    neverStudiedBase: 0.55,    // priorité de base pour un chapitre jamais travaillé
    maxErrorBoost: 0.3,        // plafond du boost lié aux erreurs récentes
    errorBoostStep: 0.05,      // boost par erreur récente (plafonné à maxErrorBoost)
    maxRecencyBoost: 0.2,      // plafond du boost lié à l'absence de révision
    recencyFullDays: 30,       // délai (jours) auquel le boost de récence est maximal
    justRevisedHours: 20,      // en dessous de ce délai, on évite de reproposer aussitôt
    justRevisedPenalty: 0.25,
    trendAdjust: 0.1,          // tendance en baisse -> +trendAdjust, en hausse -> -trendAdjust
  };

  /* Confiance dérivée du volume de données réellement disponible :
     - "insufficient" : aucune donnée exploitable (0 point)
     - "low"          : 1-2 points (ex. 1 question répondue, 1 tentative)
     - "moderate"      : 3-9 points
     - "high"          : 10 points ou plus
     Elle module (buildConfidence + CONFIDENCE_DAMPING) le score de priorité
     sans jamais l'annuler : une recommandation à faible confiance reste
     affichable, juste moins mise en avant, et l'UI peut choisir de la
     signaler explicitement (voir §4 du cahier des charges). */
  function buildConfidence(sampleSize){
    var n = sampleSize || 0;
    if(n <= 0) return "insufficient";
    if(n < 3) return "low";
    if(n < 10) return "moderate";
    return "high";
  }
  var CONFIDENCE_DAMPING = { insufficient: 0.6, low: 0.8, moderate: 1, high: 1 };

  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function round3(x){ return Math.round(x * 1000) / 1000; }
  function daysBetween(fromTs, toTs){ return Math.max(0, (toTs - fromTs) / 86400000); }

  /* Une seule raison par recommandation, la plus spécifique et actionnable,
     jamais culpabilisante ("cette notion semble encore fragile", jamais
     "tu es mauvais en..."). Ordre volontaire : erreurs récurrentes > erreurs
     récentes > tendance en baisse > jamais travaillé > maîtrise fragile sans
     donnée d'erreur > absence de révision prolongée > progrès avec fragilité
     résiduelle (repli). */
  function pickReason(f){
    if(f.hasErrorData && f.recentErrorCount >= 3){
      return { key: "smart.reason_recurring_errors", vars: null };
    }
    if(f.hasErrorData && f.recentErrorCount >= 1){
      return { key: "smart.reason_errors_recent", vars: { n: f.recentErrorCount } };
    }
    if(f.trend === "down"){
      return { key: "smart.reason_declining_trend", vars: null };
    }
    if(f.mastery === null && f.masterySampleSize === 0){
      return { key: "smart.reason_never_studied", vars: null };
    }
    if(f.mastery !== null && f.mastery < 60 && !f.hasErrorData){
      return { key: "smart.reason_low_mastery", vars: null };
    }
    if(f.lastRevisionAt !== null){
      var days = Math.round(daysBetween(f.lastRevisionAt, f.now));
      if(days >= 7) return { key: "smart.reason_not_revised", vars: { n: days } };
    }
    if(f.trend === "up" && f.mastery !== null && f.mastery < 75){
      return { key: "smart.reason_improving_but_fragile", vars: null };
    }
    return { key: "smart.reason_low_mastery", vars: null };
  }

  /* Choix du mode le plus pertinent PARMI LES MODES EXISTANTS de l'app
     (quiz / flashcards) — jamais un nouveau mode. "course_quiz"/"course_flash"
     signalent juste, pour l'affichage, qu'il vaut mieux jeter un œil au
     cours avant de se lancer (chapitre jamais travaillé, ou erreurs
     récurrentes sur une notion) ; l'action réelle reste un quiz ou des
     flashcards existants (voir index.html: attachSessionPayload). */
  function pickSuggestedMode(f){
    if(f.masterySampleSize === 0){
      if(f.hasQuiz) return "course_quiz";
      if(f.hasFlashcards) return "course_flash";
      return "quiz";
    }
    if(f.hasErrorData && f.recentErrorCount >= 3 && f.hasFlashcards) return "course_flash";
    if(f.hasErrorData && f.recentErrorCount >= 1 && f.hasQuiz) return "quiz";
    if(f.mastery !== null && f.mastery >= 60 && f.hasFlashcards) return "flash";
    if(f.hasQuiz) return "quiz";
    if(f.hasFlashcards) return "flash";
    return "quiz";
  }

  /* Estimation grossière, assumée comme telle (jamais présentée comme une
     promesse) : ~40s par question de quiz, ~20s par carte, +2min si le mode
     suggère de revoir le cours d'abord. Bornée à [2,15] minutes pour rester
     réaliste dans une session courte (voir §8). */
  function estimateMinutes(f, mode){
    var perQuestionMin = 40 / 60, perCardMin = 20 / 60;
    var mins;
    if(mode === "flash" || mode === "course_flash"){
      mins = (f.flashcardCount || 8) * perCardMin;
    } else {
      mins = (f.quizQuestionCount || 8) * perQuestionMin;
    }
    if(mode === "course_quiz" || mode === "course_flash") mins += 2;
    return Math.max(2, Math.min(15, Math.round(mins)));
  }

  function computeOne(f){
    var mastery = f.mastery;
    var base = mastery === null
      ? WEIGHTS.neverStudiedBase
      : ((100 - mastery) / 100) * WEIGHTS.masteryBase;
    var errorBoost = f.hasErrorData
      ? Math.min(WEIGHTS.maxErrorBoost, f.recentErrorCount * WEIGHTS.errorBoostStep)
      : 0;

    var recencyBoost = 0, justRevised = false;
    if(f.lastRevisionAt !== null){
      var hoursSince = (f.now - f.lastRevisionAt) / 3600000;
      if(hoursSince < WEIGHTS.justRevisedHours){
        justRevised = true;
      } else {
        var days = hoursSince / 24;
        recencyBoost = Math.min(WEIGHTS.maxRecencyBoost, (days / WEIGHTS.recencyFullDays) * WEIGHTS.maxRecencyBoost);
      }
    }

    var trendAdjust = f.trend === "down" ? WEIGHTS.trendAdjust : (f.trend === "up" ? -WEIGHTS.trendAdjust : 0);
    var confidence = buildConfidence(f.masterySampleSize);
    var damping = CONFIDENCE_DAMPING[confidence];

    var raw = base + errorBoost + recencyBoost + trendAdjust;
    if(justRevised) raw -= WEIGHTS.justRevisedPenalty;
    var priority = clamp01(raw * damping);

    var reason = pickReason(f);
    var mode = pickSuggestedMode(f);

    return {
      chapterId: f.chapterId,
      subjectId: f.subjectId,
      title: f.title,
      mastery: mastery,
      masterySampleSize: f.masterySampleSize || 0,
      confidence: confidence,
      priority: round3(priority),
      reasonKey: reason.key,
      reasonVars: reason.vars,
      lastRevisionAt: f.lastRevisionAt,
      trend: f.trend,
      suggestedMode: mode,
      estimatedMinutes: estimateMinutes(f, mode),
      hasQuiz: !!f.hasQuiz,
      hasFlashcards: !!f.hasFlashcards,
      justRevised: justRevised,
    };
  }

  /* Exclut les chapitres qui n'ont objectivement aucune raison d'être
     recommandés maintenant : maîtrise déjà très haute, révisée récemment,
     sans erreur connue -> on ne force pas une recommandation qui n'a pas de
     justification réelle. Un chapitre jamais travaillé ou en erreur reste
     toujours éligible. */
  function shouldRecommend(f){
    if(!f.hasQuiz && !f.hasFlashcards) return false; // rien à proposer concrètement
    if(f.mastery === null) return true;
    if(f.hasErrorData && f.recentErrorCount > 0) return true;
    if(f.mastery < 85) return true;
    if(f.lastRevisionAt === null) return true;
    return daysBetween(f.lastRevisionAt, f.now) >= 14;
  }

  /* Entrée : tableau de "faits" par chapitre (voir index.html:
     buildChapterFacts pour le format exact attendu). Sortie : recommandations
     triées par priorité décroissante. Pur et déterministe — aucun effet de
     bord, aucune lecture de state/DOM/réseau. */
  function computeRecommendations(chapterFacts, opts){
    opts = opts || {};
    var now = opts.now || Date.now();
    return (chapterFacts || [])
      .map(function(f){ return Object.assign({}, f, { now: now }); })
      .filter(shouldRecommend)
      .map(computeOne)
      .sort(function(a, b){ return b.priority - a.priority; });
  }

  /* Construit une session réaliste dans une enveloppe de temps demandée
     (10/20/30 min), à partir de recommandations déjà triées par priorité.
     Repli (fallback) fourni par l'appelant si les données sont insuffisantes
     pour remplir le temps demandé — jamais inventé ici (voir index.html:
     buildFallbackSessionItem, qui réutilise le pool "révision express"
     existant). */
  function buildSession(recommendations, targetMinutes, fallbackItem){
    var items = [];
    var used = 0;
    for(var i = 0; i < recommendations.length; i++){
      var r = recommendations[i];
      if(used >= targetMinutes) break;
      if(items.length > 0 && used + r.estimatedMinutes > targetMinutes + 5) continue;
      items.push(r);
      used += r.estimatedMinutes;
    }
    if(items.length === 0 && fallbackItem){
      items.push(fallbackItem);
      used += fallbackItem.estimatedMinutes;
    }
    return { items: items, totalMinutes: used, targetMinutes: targetMinutes };
  }

  global.LyonSmartRevision = {
    computeRecommendations: computeRecommendations,
    buildSession: buildSession,
    buildConfidence: buildConfidence,
    pickReason: pickReason,
    pickSuggestedMode: pickSuggestedMode,
    estimateMinutes: estimateMinutes,
    WEIGHTS: WEIGHTS,
  };

})(typeof window !== "undefined" ? window : globalThis);
