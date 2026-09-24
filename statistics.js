/* ============================================================================
   REV-EM — couche de calcul statistique (sans UI)
   ------------------------------------------------------------------------
   Fichier autonome, chargé comme translations.js/smart-revision.js (voir
   index.html), APRÈS smart-revision.js : window.LyonStatistics réutilise
   directement LyonSmartRevision.buildConfidence plutôt que de dupliquer les
   mêmes seuils de confiance (0/1-2/3-9/10+ points), pour rester cohérent
   avec "Révision intelligente" sur ce qu'est une donnée "limitée",
   "suffisante" ou "solide".

   Comme smart-revision.js, ce module est PUR : aucune dépendance au DOM, à
   state, à Supabase ni à WebLLM. index.html lui fournit des "faits" déjà
   lisibles depuis les fonctions existantes (globalMetrics, chapterMetrics,
   userChapterProgress, qstats...) et se contente d'assembler le résultat
   pour l'affichage — voir buildStatisticsSnapshot()/getStatistics() dans
   index.html. Réutilisable tel quel par un futur assistant IA, une future
   application mobile ou un futur planning automatique.

   Aucune fonction ici n'invente de donnée : chaque calcul qui nécessite un
   volume minimal (évolution, comparaison hebdomadaire, tendance) retourne
   explicitement `null`/`available:false` plutôt qu'une valeur approximative
   quand ce volume n'est pas atteint.
   ============================================================================ */
(function(global){
  "use strict";

  function confidenceOf(sampleSize){
    if(global.LyonSmartRevision && typeof global.LyonSmartRevision.buildConfidence === "function"){
      return global.LyonSmartRevision.buildConfidence(sampleSize);
    }
    // Repli si smart-revision.js n'est pas chargé (ne devrait pas arriver en
    // pratique, voir l'ordre des <script> dans index.html) : mêmes seuils.
    const n = sampleSize || 0;
    if(n <= 0) return "insufficient";
    if(n < 3) return "low";
    if(n < 10) return "moderate";
    return "high";
  }

  /* Maîtrise globale : moyenne pondérée par le volume réel de contenu
     évalué, jamais une simple moyenne des pourcentages par matière (qui
     ferait peser un chapitre de 2 questions autant qu'un chapitre de 50 —
     biais explicitement à éviter, voir le cahier des charges). Le
     programme intégré compte question par question (comme globalMetrics,
     déjà établi et affiché ailleurs dans l'app — même convention réutilisée
     ici pour rester cohérent d'une page à l'autre) ; chaque chapitre
     utilisateur/IA compte pour son meilleur score, pondéré par son nombre
     de questions+cartes. Un chapitre jamais évalué compte pour 0 à son
     plein poids (couverture réelle du programme), pas exclu du calcul —
     sauf s'il n'a strictement aucun contenu jouable, auquel cas il ne peut
     tout simplement pas être évalué. */
  function computeGlobalMastery(builtinMastery, builtinWeight, userChapterFacts){
    let weightedSum = (builtinMastery || 0) * (builtinWeight || 0);
    let totalWeight = builtinWeight || 0;
    let sampleSize = 0;
    (userChapterFacts || []).forEach(f=>{
      const w = f.weight || 0;
      if(w <= 0) return;
      weightedSum += (f.mastery === null ? 0 : f.mastery) * w;
      totalWeight += w;
      if(f.mastery !== null) sampleSize++;
    });
    if(totalWeight <= 0) return { value: null, confidence: "insufficient", sampleSize: 0 };
    return {
      value: Math.round(weightedSum / totalWeight),
      confidence: confidenceOf(sampleSize + (builtinWeight > 0 ? 1 : 0) * 3), // le programme intégré, s'il existe, compte comme un signal fort à lui seul
      sampleSize,
    };
  }

  /* Évolution dans le temps : entrée = sessions déjà triées chronologiquement
     [{pct}], typiquement le résultat de buildScoreEvolution() (réutilisé tel
     quel, pas redupliqué). Sous le seuil minimal, retourne available:false —
     jamais une courbe reconstruite à partir de trop peu de points. */
  function computeEvolution(sessions, minPoints){
    minPoints = minPoints || 3;
    if(!sessions || sessions.length < minPoints){
      return { available: false, points: [], trend: null };
    }
    const first = sessions[0].pct;
    const last = sessions[sessions.length - 1].pct;
    const delta = last - first;
    const trend = delta >= 8 ? "up" : (delta <= -8 ? "down" : "flat");
    return { available: true, points: sessions, trend, deltaFromStart: delta };
  }

  /* Comparaison entre deux périodes (ex: cette semaine / semaine précédente).
     current/previous = {correct, total} (quiz uniquement, seule mesure de
     réussite comparable entre deux périodes). N'affiche une comparaison que
     si LES DEUX périodes ont un minimum de données exploitables — sinon
     available:false, jamais un delta calculé sur une poignée de questions
     d'un côté et rien de l'autre. */
  function computeComparison(current, previous, minTotal){
    minTotal = minTotal || 5;
    const curOk = current && current.total >= minTotal;
    const prevOk = previous && previous.total >= minTotal;
    if(!curOk || !prevOk) return { available: false };
    const curRate = Math.round((current.correct / current.total) * 100);
    const prevRate = Math.round((previous.correct / previous.total) * 100);
    return { available: true, currentRate: curRate, previousRate: prevRate, deltaPoints: curRate - prevRate };
  }

  /* Insights : règles explicites uniquement, jamais d'interprétation
     inventée. `facts` rassemble ce que les autres fonctions ci-dessus ont
     déjà déterminé + quelques compteurs simples fournis par index.html.
     Chaque règle a une condition de déclenchement claire et documentée ;
     à défaut, on retourne un insight honnête "historique trop court" plutôt
     que de forcer une observation. Retourne au plus quelques insights, pas
     une liste exhaustive. */
  function computeInsights(facts){
    const insights = [];

    if(facts.evolution && facts.evolution.available){
      if(facts.evolution.trend === "up"){
        insights.push({ key: "stats.insight_improving", vars: null });
      } else if(facts.evolution.trend === "down"){
        insights.push({ key: "stats.insight_declining", vars: null });
      }
    }

    if(facts.comparison && facts.comparison.available && facts.comparison.deltaPoints !== 0){
      insights.push({
        key: facts.comparison.deltaPoints > 0 ? "stats.insight_week_better" : "stats.insight_week_worse",
        vars: { n: Math.abs(facts.comparison.deltaPoints) },
      });
    }

    if(facts.topWeeklySubject){
      insights.push({ key: "stats.insight_subject_focus", vars: { subject: facts.topWeeklySubject } });
    }

    if(facts.topErrorChapter){
      insights.push({ key: "stats.insight_recurring_errors", vars: { chapter: facts.topErrorChapter } });
    }

    if(insights.length === 0){
      insights.push({ key: "stats.insight_not_enough_history", vars: null });
    }

    return insights.slice(0, 4);
  }

  global.LyonStatistics = {
    computeGlobalMastery,
    computeEvolution,
    computeComparison,
    computeInsights,
    confidenceOf,
  };

})(typeof window !== "undefined" ? window : globalThis);
