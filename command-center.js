/* ============================================================================
   REV-EM — moteur du Command Center
   ----------------------------------------------------------------------------
   Fichier autonome, chargé comme smart-revision.js / statistics.js /
   sync-engine.js. `window.LyonCommand` n'a AUCUNE dépendance au DOM, à
   `state`, à la navigation, à Supabase ni à WebLLM.

   Il ne sait pas ce qu'est une matière. Il sait trier des ITEMS par
   pertinence, et rien d'autre.

       index.html          enregistre les SOURCES (elles, connaissent state
             │             et la navigation)
             ▼
       LyonCommand         normalise, score, classe, regroupe
             │
             ▼
       index.html          affiche et exécute l'item choisi

   AJOUTER UNE SOURCE, PLUS TARD
       LyonCommand.registerSource({
         id: "annales", category: "resources", order: 60,
         collect: (ctx) => [ { title, subtitle, keywords, run } … ],
       });
   Aucune ligne de ce fichier ne change, et aucune ligne de l'interface non
   plus. C'est tout l'intérêt d'un registre : la recherche n'est écrite
   qu'une fois, jamais re-déclinée page par page.

   ----------------------------------------------------------------------------
   CE QUE « TOLÉRER LES FAUTES » VEUT DIRE ICI
   ----------------------------------------------------------------------------
   Cinq façons de reconnaître un texte, de la plus sûre à la plus permissive.
   La première qui répond gagne, et son rang fixe le score : on ne mélange pas
   une correspondance exacte avec une approximation, sinon un résultat
   approximatif passerait devant un résultat exact.

     1. égalité                  « maths »     → « maths »
     2. début du texte           « math »      → « mathématiques »
     3. début d'un mot           « dériv »     → « Chapitre : Dérivation »
     4. n'importe où dans le mot « rivation »  → « Dérivation »
     5. lettres dans l'ordre     « drvtn »     → « Dérivation »
     6. faute de frappe          « mathémtiqeus » → « mathématiques »

   Les accents sont retirés des DEUX côtés : « derivation » trouve
   « Dérivation », et personne n'a à deviner où mettre les accents.
   ============================================================================ */

(function(global){
  "use strict";

  /* ═════════════════════════════════════════════════════════════════════════
     NORMALISATION
     ═════════════════════════════════════════════════════════════════════════ */

  /* Minuscules, sans accents, sans ponctuation, espaces réduits.
     `normalize("NFD")` sépare la lettre de son accent ; on retire ensuite les
     marques combinantes. C'est ce qui fait que « éàç » devient « eac » sans
     table de correspondance à maintenir. */
  function normalize(s){
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’`]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function words(s){
    const n = normalize(s);
    return n ? n.split(" ") : [];
  }

  /* ═════════════════════════════════════════════════════════════════════════
     DISTANCE D'ÉDITION (Damerau-Levenshtein, avec transpositions)
     ─────────────────────────────────────────────────────────────────────────
     Les transpositions comptent pour UNE faute, pas deux : « mathémtiqeus »
     est une inversion de doigts, pas deux erreurs distinctes. Sans ça, la
     faute de frappe la plus courante au clavier serait la moins bien tolérée.

     Arrêt anticipé : dès qu'une ligne entière dépasse le budget, la distance
     finale le dépassera aussi. Inutile de finir le calcul — et c'est ce qui
     rend la tolérance abordable sur plusieurs centaines d'items.
     ═════════════════════════════════════════════════════════════════════════ */
  function editDistance(a, b, max){
    const la = a.length, lb = b.length;
    if(Math.abs(la - lb) > max) return max + 1;
    if(!la) return lb;
    if(!lb) return la;

    let prev2 = null;
    let prev = new Array(lb + 1);
    let cur  = new Array(lb + 1);
    for(let j = 0; j <= lb; j++) prev[j] = j;

    for(let i = 1; i <= la; i++){
      cur[0] = i;
      let best = cur[0];
      for(let j = 1; j <= lb; j++){
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if(i > 1 && j > 1
           && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
           && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)){
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if(v < best) best = v;
      }
      if(best > max) return max + 1;
      prev2 = prev; prev = cur; cur = new Array(lb + 1);
    }
    return prev[lb];
  }

  /* Combien de fautes on accepte, selon la longueur de ce qui est tapé.
     Un mot court ne supporte pas deux fautes : « bac » deviendrait « bic »,
     « sac », « bal »… et la recherche renverrait n'importe quoi. */
  function budget(len){
    if(len <= 3) return 0;
    if(len <= 5) return 1;
    if(len <= 9) return 2;
    return 3;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     SCORE D'UN TEXTE FACE À UNE REQUÊTE — 0 (rien) à 1 (exact)
     ═════════════════════════════════════════════════════════════════════════ */

  /* Les lettres de `q` apparaissent-elles dans l'ordre dans `text` ?
     Retourne la compacité (0..1) : plus les lettres sont rapprochées, plus
     c'est probablement ce que l'utilisateur visait. « drvtn » dans
     « derivation » vaut mieux que « drvtn » dans « developpement rationnel ». */
  function subsequenceTightness(q, text){
    let i = 0, first = -1, last = -1;
    for(let j = 0; j < text.length && i < q.length; j++){
      if(text.charCodeAt(j) === q.charCodeAt(i)){
        if(first < 0) first = j;
        last = j; i++;
      }
    }
    if(i < q.length) return 0;
    const span = last - first + 1;
    return q.length / span;
  }

  function scoreText(qn, text){
    if(!qn) return 0;
    const n = normalize(text);
    if(!n) return 0;

    if(n === qn) return 1;

    /* Début du texte : on pénalise très légèrement les textes longs, pour que
       « Quiz » passe devant « Quiz de révision express du chapitre 4 ». */
    if(n.startsWith(qn)) return 0.94 - Math.min(0.08, (n.length - qn.length) / 400);

    const ws = n.split(" ");
    for(let i = 0; i < ws.length; i++){
      if(ws[i].startsWith(qn)) return 0.86 - Math.min(0.06, i * 0.01);
    }

    if(n.indexOf(qn) >= 0) return 0.72;

    /* Requête en plusieurs mots : chaque mot doit se retrouver quelque part.
       « quiz deriv » trouve « Quiz : Dérivation ». */
    const qws = qn.split(" ");
    if(qws.length > 1 && qws.every(w => n.indexOf(w) >= 0)) return 0.70;

    const tight = subsequenceTightness(qn.replace(/ /g, ""), n.replace(/ /g, ""));
    if(tight > 0) return 0.38 + 0.22 * tight;

    /* Dernier recours : la faute de frappe, comparée mot à mot. Comparer à la
       chaîne entière donnerait toujours une distance énorme sur un titre long. */
    const max = budget(qn.length);
    if(max > 0){
      let best = 0;
      for(const w of ws){
        if(Math.abs(w.length - qn.length) > max) continue;
        const d = editDistance(qn, w, max);
        if(d <= max){
          const s = 0.62 - (d - 1) * 0.10;
          if(s > best) best = s;
        }
      }
      if(best > 0) return best;
    }
    return 0;
  }

  /* Le poids d'un champ. Le titre prime : c'est ce que l'utilisateur lit.
     Les mots-clés viennent juste après — ils existent pour rattraper les
     synonymes (« notes » pour « fiches ») sans polluer l'affichage. */
  const FIELD_WEIGHT = { title: 1, keywords: 0.9, subtitle: 0.62, meta: 0.46 };

  function scoreItem(qn, item){
    let best = 0, field = null;

    const t = scoreText(qn, item.title);
    if(t > best){ best = t; field = "title"; }

    if(Array.isArray(item.keywords)){
      for(const k of item.keywords){
        const s = scoreText(qn, k) * FIELD_WEIGHT.keywords;
        if(s > best){ best = s; field = "keywords"; }
      }
    }
    if(item.subtitle){
      const s = scoreText(qn, item.subtitle) * FIELD_WEIGHT.subtitle;
      if(s > best){ best = s; field = "subtitle"; }
    }
    if(item.meta){
      const s = scoreText(qn, item.meta) * FIELD_WEIGHT.meta;
      if(s > best){ best = s; field = "meta"; }
    }
    return { score: best, field: field };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     LE REGISTRE DES SOURCES
     ═════════════════════════════════════════════════════════════════════════ */

  const sources = [];

  function registerSource(src){
    if(!src || !src.id) throw new Error("LyonCommand.registerSource : id manquant.");
    if(typeof src.collect !== "function") throw new Error("LyonCommand.registerSource : collect() manquant.");
    const i = sources.findIndex(s => s.id === src.id);
    const entry = {
      id: src.id,
      category: src.category || src.id,
      order: typeof src.order === "number" ? src.order : 100,
      limit: typeof src.limit === "number" ? src.limit : 6,
      collect: src.collect,
    };
    /* Ré-enregistrer le même id REMPLACE : au rechargement d'un écran, on ne
       veut pas deux fois la même source qui renverrait deux fois les mêmes
       résultats. */
    if(i >= 0) sources[i] = entry; else sources.push(entry);
    sources.sort((a, b) => a.order - b.order);
    return entry;
  }

  function clearSources(){ sources.length = 0; }
  function listSources(){ return sources.map(s => ({ id: s.id, category: s.category, order: s.order })); }

  /* ═════════════════════════════════════════════════════════════════════════
     LA RECHERCHE
     ─────────────────────────────────────────────────────────────────────────
     Requête vide : chaque source propose ses entrées « par défaut » (celles
     qu'elle marque `suggested`). Ce n'est pas un catalogue — c'est ce qu'on
     montre avant que l'utilisateur ait tapé quoi que ce soit.
     ═════════════════════════════════════════════════════════════════════════ */
  function search(query, opts){
    const o = opts || {};
    const perGroup = typeof o.perGroup === "number" ? o.perGroup : 0;
    const maxTotal = typeof o.maxTotal === "number" ? o.maxTotal : 40;
    const qn = normalize(query);
    const empty = qn.length === 0;

    const groups = [];
    let total = 0;

    for(const src of sources){
      let items = [];
      try{
        items = src.collect({ query: String(query || ""), normalized: qn, isEmpty: empty }) || [];
      }catch(e){
        /* Une source qui tombe ne doit pas emporter la recherche entière :
           l'utilisateur garde les autres résultats. */
        if(global.console && console.error) console.error("[LyonCommand] source « " + src.id + " »", e);
        items = [];
      }

      const scored = [];
      for(const item of items){
        if(!item || !item.title) continue;
        if(empty){
          if(!item.suggested) continue;
          scored.push({ item: item, score: 0, field: null });
        } else {
          const r = scoreItem(qn, item);
          if(r.score <= 0) continue;
          /* `boost` laisse une source dire « celui-ci compte un peu plus »
             (une matière ouverte récemment, par exemple) sans jamais pouvoir
             faire passer une approximation devant une correspondance exacte :
             il est borné, et appliqué après le score. */
          const boosted = Math.min(1, r.score * (1 + Math.max(0, Math.min(0.15, item.boost || 0))));
          scored.push({ item: item, score: boosted, field: r.field });
        }
      }

      if(!scored.length) continue;
      if(!empty){
        scored.sort((a, b) => b.score - a.score
          || normalize(a.item.title).length - normalize(b.item.title).length);
      }
      const cap = perGroup || src.limit;
      const kept = scored.slice(0, cap);
      total += kept.length;
      groups.push({
        id: src.id,
        category: src.category,
        order: src.order,
        results: kept,
        truncated: scored.length - kept.length,
      });
      if(total >= maxTotal) break;
    }

    /* Pour une requête, les groupes qui contiennent le meilleur résultat
       passent devant : chercher « dérivation » doit montrer le chapitre avant
       la page « Paramètres », même si Paramètres est déclaré plus haut. */
    if(!empty){
      groups.sort((a, b) => {
        const am = a.results[0] ? a.results[0].score : 0;
        const bm = b.results[0] ? b.results[0].score : 0;
        return bm - am || a.order - b.order;
      });
    }

    /* La liste à plat, dans l'ordre d'affichage : c'est elle que le clavier
       parcourt avec ↑ et ↓. La calculer ici évite que l'interface ait à
       recomposer l'ordre — et donc qu'elle puisse s'en écarter. */
    const flat = [];
    groups.forEach(g => g.results.forEach(r => flat.push({ group: g.category, ...r })));

    return { query: String(query || ""), normalized: qn, isEmpty: empty,
             groups: groups, flat: flat, total: flat.length };
  }

  global.LyonCommand = {
    registerSource, clearSources, listSources, search,
    /* exposés pour les tests et la réutilisation */
    normalize, words, scoreText, scoreItem, editDistance, subsequenceTightness, budget,
    FIELD_WEIGHT,
  };

})(typeof window !== "undefined" ? window : globalThis);
