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
    // ligne de la table "profiles" (display_name/first_name/last_name/phone/
    // avatar_url) + profile._avatarSignedUrl : URL signée temporaire résolue
    // côté client à partir d'avatar_url (le bucket Storage est privé), jamais
    // stockée en base.
    profile: null,
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

  // Bucket Storage "avatars" privé (voir schema.sql) : avatar_url en base
  // n'est qu'un CHEMIN ("<user_id>/avatar.webp"), jamais une URL publique.
  // On la résout en URL signée à durée limitée, à la demande.
  const AVATAR_SIGNED_URL_TTL = 3600;
  async function resolveAvatarUrl(path){
    if(!client || !path) return null;
    try{
      const { data, error } = await client.storage.from("avatars").createSignedUrl(path, AVATAR_SIGNED_URL_TTL);
      if(error){ console.error("[LyonAuth] createSignedUrl", error.message); return null; }
      return data ? data.signedUrl : null;
    }catch(e){
      console.error("[LyonAuth] createSignedUrl", e);
      return null;
    }
  }

  async function fetchProfile(userId){
    if(!client) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).single();
    if(error){ console.error("[LyonAuth] fetchProfile", error.message); return null; }
    if(data && data.avatar_url) data._avatarSignedUrl = await resolveAvatarUrl(data.avatar_url);
    return data;
  }

  async function refreshProfile(){
    if(!state.user) return null;
    state.profile = await fetchProfile(state.user.id);
    notify();
    return state.profile;
  }

  /* Met à jour prénom/nom/pseudo/téléphone. L'email (Supabase Auth) et
     l'avatar (uploadAvatar/removeAvatar) ne passent pas par ici. */
  async function updateProfile(fields){
    if(!available || !state.user) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const patch = {};
      ["first_name", "last_name", "display_name", "phone"].forEach(k=>{
        if(Object.prototype.hasOwnProperty.call(fields, k)) patch[k] = fields[k];
      });
      const { data, error } = await client.from("profiles").update(patch).eq("id", state.user.id).select().single();
      if(error) return { error: humanError(error) };
      data._avatarSignedUrl = state.profile ? state.profile._avatarSignedUrl : null;
      state.profile = data;
      return { profile: data };
    }catch(e){
      return { error: humanError(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  /* blob : image déjà validée/redimensionnée côté appelant (voir index.html,
     modal "Mes informations"). ext : extension sans le point (ex. "webp").
     Chemin fixe par utilisateur (upsert) : pas de fichiers orphelins à
     nettoyer à chaque changement de photo. */
  async function uploadAvatar(blob, ext){
    if(!available || !state.user) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const path = state.user.id + "/avatar." + ext;
      const { error: upErr } = await client.storage.from("avatars").upload(path, blob, {
        upsert: true,
        contentType: blob.type || "image/webp",
      });
      if(upErr) return { error: humanError(upErr) };
      const { data, error } = await client.from("profiles").update({ avatar_url: path }).eq("id", state.user.id).select().single();
      if(error) return { error: humanError(error) };
      data._avatarSignedUrl = await resolveAvatarUrl(path);
      state.profile = data;
      return { profile: data };
    }catch(e){
      return { error: humanError(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  async function removeAvatar(){
    if(!available || !state.user) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const oldPath = state.profile && state.profile.avatar_url;
      const { data, error } = await client.from("profiles").update({ avatar_url: null }).eq("id", state.user.id).select().single();
      if(error) return { error: humanError(error) };
      if(oldPath){
        try{ await client.storage.from("avatars").remove([oldPath]); }
        catch(e){ console.error("[LyonAuth] removeAvatar storage", e); }
      }
      data._avatarSignedUrl = null;
      state.profile = data;
      return { profile: data };
    }catch(e){
      return { error: humanError(e) };
    }finally{
      state.busy = false; notify();
    }
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
    updateProfile, uploadAvatar, removeAvatar,
    get client(){ return client; },
  };
})();
