/* ============================================================================
   auth.js — REV-EM : compte utilisateur (Supabase Auth)
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

  /* Diagnostic temporaire (demande du 20/09) : affiche le détail COMPLET
     d'une erreur Supabase/Postgrest — message, code, details, hint — sur 4
     lignes distinctes en console, jamais masqué derrière un seul message
     générique. error.code est aussi répercuté dans le message utilisateur
     (entre parenthèses) : permet de nous le communiquer même sans ouvrir
     la console. À réduire une fois la cause du bug de sauvegarde confirmée
     réglée en conditions réelles. */
  function logProfileError(context, error){
    console.error("[PROFILE SAVE ERROR]", context, error);
    console.error("[PROFILE SAVE ERROR] error.message =", error && error.message);
    console.error("[PROFILE SAVE ERROR] error.code =", error && error.code);
    console.error("[PROFILE SAVE ERROR] error.details =", error && error.details);
    console.error("[PROFILE SAVE ERROR] error.hint =", error && error.hint);
  }
  function profileErrorMessage(error){
    const code = error && error.code;
    return "Impossible d'enregistrer les informations." + (code ? " (code Supabase : " + code + ")" : "");
  }

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
    console.log("[PROFILE] user id =", userId);
    console.log("[PROFILE LOAD] select * from profiles where id =", userId);
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).single();
    if(error){
      // Ne JAMAIS avaler cette erreur en silence : si elle se produit, c'est
      // la cause la plus probable d'un profil qui "ne persiste pas" (colonne
      // manquante si supabase/schema.sql n'a pas été rejoué, RLS SELECT trop
      // restrictive, ligne absente...). Toujours visible en console, détail
      // complet (message/code/details/hint), pas juste un message générique.
      console.error("[PROFILE LOAD ERROR]", error);
      console.error("[PROFILE LOAD ERROR] error.message =", error.message);
      console.error("[PROFILE LOAD ERROR] error.code =", error.code);
      console.error("[PROFILE LOAD ERROR] error.details =", error.details);
      console.error("[PROFILE LOAD ERROR] error.hint =", error.hint);
      return null;
    }
    console.log("[PROFILE LOAD] result =", data);
    if(data && data.avatar_url) data._avatarSignedUrl = await resolveAvatarUrl(data.avatar_url);
    return data;
  }

  async function refreshProfile(){
    if(!state.user) return null;
    state.profile = await fetchProfile(state.user.id);
    notify();
    return state.profile;
  }

  /* upsert() plutôt que update() : la ligne "profiles" est normalement déjà
     créée par le trigger on_auth_user_created au moment de l'inscription,
     mais un update() sur une ligne qui n'existe pas (pour quelque raison que
     ce soit — trigger jamais exécuté sur ce projet, ligne supprimée...) ne
     modifie 0 ligne et échoue ensuite sur .single(), donnant l'impression
     que "rien ne s'enregistre" sans jamais créer le profil. upsert() couvre
     les deux cas (création ET mise à jour) avec la même logique — nécessite
     la policy RLS "profiles_insert_own" (voir supabase/schema.sql). Ne gère
     pas state.busy/notify() elle-même : réservé aux fonctions publiques
     ci-dessous, qui l'appellent chacune une seule fois.

     Revérifie l'utilisateur via client.auth.getUser() (plutôt que de faire
     confiance à state.user, mis en cache depuis le dernier événement
     onAuthStateChange) juste avant d'écrire : garantit que le profil est
     toujours lié au VRAI utilisateur actuellement authentifié auprès de
     Supabase, jamais à une référence obsolète. */
  async function saveProfileFields(extraFields){
    const { data: { user }, error: userErr } = await client.auth.getUser();
    console.log("[PROFILE DEBUG] user.id =", user && user.id);
    console.log("[PROFILE DEBUG] user.email =", user && user.email);
    if(userErr || !user){
      logProfileError("getUser", userErr || new Error("no authenticated user"));
      return { error: profileErrorMessage(userErr) };
    }
    const payload = Object.assign({ id: user.id }, extraFields);
    console.log("[PROFILE SAVE] payload =", payload);
    const { data, error } = await client.from("profiles").upsert(payload, { onConflict: "id" }).select().single();
    if(error){
      logProfileError("upsert profiles", error);
      return { error: profileErrorMessage(error) };
    }
    console.log("[PROFILE SAVE RESULT]", data);
    data._avatarSignedUrl = state.profile ? state.profile._avatarSignedUrl : null;
    state.profile = data;
    return { profile: data };
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
      return await saveProfileFields(patch);
    }catch(e){
      logProfileError("updateProfile", e);
      return { error: profileErrorMessage(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  /* blob : image déjà validée/redimensionnée côté appelant (voir index.html,
     modal "Mes informations"). ext : extension sans le point (ex. "webp").
     Chemin fixe par utilisateur (upsert Storage) : pas de fichiers orphelins
     à nettoyer à chaque changement de photo. */
  async function uploadAvatar(blob, ext){
    if(!available || !state.user) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const path = state.user.id + "/avatar." + ext;
      console.log("[PROFILE SAVE] avatar upload path =", path, "size =", blob.size, "type =", blob.type);
      const { error: upErr } = await client.storage.from("avatars").upload(path, blob, {
        upsert: true,
        contentType: blob.type || "image/webp",
      });
      if(upErr){
        logProfileError("storage.upload avatars", upErr);
        return { error: profileErrorMessage(upErr) };
      }
      const res = await saveProfileFields({ avatar_url: path });
      if(res.error) return res;
      res.profile._avatarSignedUrl = await resolveAvatarUrl(path);
      state.profile = res.profile;
      return res;
    }catch(e){
      logProfileError("uploadAvatar", e);
      return { error: profileErrorMessage(e) };
    }finally{
      state.busy = false; notify();
    }
  }

  async function removeAvatar(){
    if(!available || !state.user) return { error: humanError(null) };
    state.busy = true; notify();
    try{
      const oldPath = state.profile && state.profile.avatar_url;
      const res = await saveProfileFields({ avatar_url: null });
      if(res.error) return res;
      if(oldPath){
        try{ await client.storage.from("avatars").remove([oldPath]); }
        catch(e){ logProfileError("removeAvatar storage", e); }
      }
      res.profile._avatarSignedUrl = null;
      state.profile = res.profile;
      return res;
    }catch(e){
      logProfileError("removeAvatar", e);
      return { error: profileErrorMessage(e) };
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
    client.auth.onAuthStateChange(async (event, session) => {
      state.user = session ? session.user : null;
      state.status = state.user ? "signed-in" : "signed-out";
      // Toujours réévalué depuis LA session courante : jamais de résidu d'un
      // utilisateur précédent (déconnexion -> state.profile repasse à null
      // immédiatement ci-dessous ; reconnexion, même sous un autre compte ->
      // fetchProfile relit le bon profil pour le nouvel state.user.id).
      state.profile = state.user ? await fetchProfile(state.user.id) : null;
      console.log("[PROFILE DEBUG] auth event =", event, "-> status =", state.status, "profile =", state.profile);
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
