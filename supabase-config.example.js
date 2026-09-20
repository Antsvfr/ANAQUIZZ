/* ============================================================================
   Lyon Révision — configuration Supabase (frontend)
   ------------------------------------------------------------------------
   1. Copie ce fichier en "supabase-config.js" (même dossier, à côté de
      index.html).
   2. Remplace les deux valeurs ci-dessous par celles de TON projet Supabase :
        Dashboard Supabase → Project Settings → API
          - "Project URL"        → SUPABASE_URL
          - "anon" "public" key  → SUPABASE_ANON_KEY
   3. Ne modifie rien d'autre dans ce fichier.

   IMPORTANT — ce qui peut/doit aller ici, et ce qui ne doit JAMAIS y aller :

     ✅ SUPABASE_URL et la clé "anon" / "public" SONT CONÇUES pour être
        visibles côté navigateur. Ce ne sont pas des secrets : la sécurité
        réelle est assurée par les policies Row Level Security (RLS) côté
        base de données (voir supabase/schema.sql), jamais par le fait que
        cette clé serait cachée. Un utilisateur qui inspecte le code source
        de la page verra toujours cette clé — c'est normal et sans risque
        tant que RLS est bien activé sur toutes les tables.

     ❌ Ne mets JAMAIS ici (ni nulle part dans le frontend) :
          - la "service_role key" Supabase
          - un mot de passe administrateur
          - une clé privée quelconque
        Ces valeurs donnent un accès total à la base en contournant RLS :
        elles ne doivent exister que côté serveur (aucun serveur de ce type
        n'existe dans ce projet — GitHub Pages est 100% statique — donc ces
        clés n'ont simplement pas leur place dans ce dépôt).

   "supabase-config.js" (le vrai fichier, avec tes valeurs) est listé dans
   .gitignore : il ne sera pas versionné par erreur. Comme la clé anon n'est
   pas un secret, tu PEUX aussi choisir de la committer si tu préfères une
   configuration simple à déployer sans étape manuelle — c'est ton choix,
   les deux approches sont sûres. Voir SETUP_SUPABASE.md pour le détail.
   ============================================================================ */

window.SUPABASE_CONFIG = {
  url: "REMPLACE_MOI_PAR_TON_SUPABASE_URL",       // ex. "https://xxxxxxxxxxxx.supabase.co"
  anonKey: "REMPLACE_MOI_PAR_TA_CLE_ANON_PUBLIC",  // clé "anon" "public", jamais "service_role"
};
