/* ============================================================================
   auth.js — Lyon Révision : compte utilisateur (Supabase Auth)
   ----------------------------------------------------------------------------
   Responsabilité unique : connexion / inscription / déconnexion / session /
   profil (voir découpage "AUTH / DATA / SYNC / UI / AI" demandé). Ne touche
   JAMAIS aux données locales (localStorage/IndexedDB) ni au rendu — index.html
   s'abonne aux changements via LyonAuth.onChange() et décide quoi afficher.

   Chargé en script classique (pas de module ES, pas de bundler — cohérent
   avec le reste du projet), AVANT le script principal d'index.html, pour que
   window.LyonAuth existe dès que ce dernier démarre. N'appelle jamais
   render()/state directement : ce fichier ignore tout du reste de l'app.

   Une seule initialisation globale (LyonAuth.init(), protégée contre les
   doubles appels) et un seul listener onAuthStateChange — voir "Évite les
   boucles de chargement / les doubles listeners" dans la demande.
   ============================================================================ */

window.LyonAuth = (function(){
  "use strict";

  const cfg = window.SUPABASE_CONFIG || null;
  const configLooksReal = !!(cfg && cfg.url && cfg.anonKey &&
    !/REMPLACE_MOI/.test(cfg.url) && !/REMPLACE_MOI/.test(cfg.anonKey));
  const sdkReady = !!(window.supabase && typeof window.supabase.createClient === "function");
  const available = configLooksReal && sdkReady;

  const client = available ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

  // état public, en lecture seule pour le reste de l'app (ne jamais muter
  // depuis l'extérieur — passer par signUp/signIn/signOut/refreshProfile).
  const state = {
    status: "idle",   // idle | signed-out | signed-in
    user: null,       // objet utilisateur Supabase Auth (id, email, ...)
    profile: null,    // ligne de la table "profiles" (user_code, display_name, ...)
    busy: false,      // une opération d'auth (signUp/signIn/...) est en cours
  };

  const listeners = [];
  function onChange(fn){ listeners.push(fn); }
  function notify(){ listeners.forEach(fn => { try{ fn(state); }catch(e){ console.error("[LyonAuth] listener error", e); } }); }

  /* Traduit les erreurs Supabase/Postgrest en messages humains courts,
     jamais de détail technique côté utilisateur (le détail reste en
     console). */
  function humanError(err){
    const msg = String((err && err.message) || err || "");
    console.error("[LyonAuth]", msg);
    if(!available) return "La connexion aux comptes n'est pas configurée sur ce site.";
    if(/invalid login credentials/i.test(msg)) return "Email ou mot de passe incorrect.";
    if(/already registered|user already exists/i.test(msg)) return "Un compte existe déjà avec cet email.";
    if(/password.*(least|short|6 characters)/i.test(msg)) return "Le mot de passe doit contenir au moins 6 caractères.";
    if(/unable to validate email|invalid email/i.test(msg)) return "Adresse email invalide.";
    if(/email not confirmed/i.test(msg)) return "Confirme ton adresse email avant de te connecter (vérifie tes emails).";
    if(/rate limit|too many requests/i.test(msg)) return "Trop de tentatives. Réessaie dans quelques minutes.";
    if(/failed to fetch|network|timeout/i.test(msg)) return "Connexion impossible. Vérifie ta connexion Internet.";
    if(/jwt|session|expired/i.test(msg)) return "Ta session a expiré. Reconnecte-toi.";
    return "Une erreur est survenue. Réessaie dans un instant.";
  }

  async function fetchProfile(userId){
    if(!client) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).single();
    if(error){ console.error("[LyonAuth] fetchProfile", error.message); return null; }
    return data;
  }

  async function refreshProfile(){
    if(!state.user) return null;
    state.profile = await fetchProfile(state.user.id);
    notify();
    return state.profile;
  }

  async function signUp({ email, password, displayName }){
    if(!available) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const { data, error } = await client.auth.signUp({
        email: String(email || "").trim(),
        password: String(password || ""),
        options: { data: { display_name: String(displayName || "").trim() } },
      });
      if(error) return { error: humanError(error) };
      // data.session est null si la confirmation par email est activée côté
      // Supabase : dans ce cas, pas de connexion immédiate, on le signale.
      return { user: data.user, needsEmailConfirmation: !data.session };
    }catch(e){
      return { error: humanError(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  async function signIn({ email, password }){
    if(!available) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const { data, error } = await client.auth.signInWithPassword({
        email: String(email || "").trim(),
        password: String(password || ""),
      });
      if(error) return { error: humanError(error) };
      return { user: data.user };
    }catch(e){
      return { error: humanError(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  async function signOut(){
    if(!available) return;
    state.busy = true; notify();
    try{
      await client.auth.signOut();
      // onAuthStateChange (SIGNED_OUT) remet state.user/profile à null et
      // notifie déjà — pas de double travail ici.
    }catch(e){
      console.error("[LyonAuth] signOut", e);
    }finally{
      state.busy = false; notify();
    }
  }

  async function resetPassword(email){
    if(!available) return { error: humanError(null) };
    try{
      const redirectTo = window.location.href.split("#")[0].split("?")[0];
      const { error } = await client.auth.resetPasswordForEmail(String(email || "").trim(), { redirectTo });
      if(error) return { error: humanError(error) };
      return { ok: true };
    }catch(e){
      return { error: humanError(e) };
    }
  }

  let initStarted = false;
  function init(){
    // Une seule initialisation globale de l'authentification, jamais
    // ré-enregistrée (évite les doubles listeners en cas de rappel accidentel).
    if(initStarted) return;
    initStarted = true;

    if(!available){
      state.status = "signed-out";
      if(!sdkReady) console.warn("[LyonAuth] SDK Supabase non chargé — vérifie la balise <script> du SDK.");
      if(!configLooksReal) console.warn("[LyonAuth] supabase-config.js absent ou non renseigné — comptes désactivés.");
      notify();
      return;
    }

    // Un seul abonnement pour toute la durée de vie de la page. Le premier
    // appel (événement "INITIAL_SESSION") reflète déjà la session existante
    // (persistée par le SDK) : pas besoin d'appeler getSession() en plus.
    client.auth.onAuthStateChange(async (_event, session) => {
      state.user = session ? session.user : null;
      state.status = state.user ? "signed-in" : "signed-out";
      state.profile = state.user ? await fetchProfile(state.user.id) : null;
      notify();
      // Point d'accroche pour la synchronisation (préparée mais pas encore
      // implémentée à ce stade du chantier) : sync.js définira cette
      // fonction quand elle existera ; ici, no-op sûr si absente.
      if(state.status === "signed-in" && window.LyonSync && typeof window.LyonSync.onSignedIn === "function"){
        try{ window.LyonSync.onSignedIn(state.user, state.profile); }catch(e){ console.error("[LyonSync] onSignedIn", e); }
      }
    });
  }

  return {
    available, state, init, onChange,
    signUp, signIn, signOut, resetPassword, refreshProfile, humanError,
    get client(){ return client; },
  };
})();
