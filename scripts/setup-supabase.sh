#!/usr/bin/env bash
# =============================================================================
# REV-EM — étapes 2, 3 et 4 de BRIGHTSPACE_SETUP.md, en une commande
# -----------------------------------------------------------------------------
#   2. applique les migrations SQL
#   3. enregistre les secrets Supabase
#   4. déploie les six Edge Functions (avec --no-verify-jwt sur le callback)
#
# Ce script NE FAIT PAS l'étape 1 : l'enregistrement de l'application OAuth
# dans Brightspace se fait à la main, par un administrateur de l'établissement
# (voir DEMANDE_ADMIN_BRIGHTSPACE.md).
#
# GARANTIES
#   • le Client Secret et la clé de chiffrement sont saisis au clavier, jamais
#     passés en argument (sinon ils resteraient dans l'historique du shell) ;
#   • aucun secret n'est affiché, ni écrit sur le disque, ni committé ;
#   • le script s'arrête à la première erreur et dit laquelle.
#
# USAGE
#   ./scripts/setup-supabase.sh
#   ./scripts/setup-supabase.sh --migrations-only
#   ./scripts/setup-supabase.sh --deploy-only
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; RESET=$'\033[0m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'
step() { printf '\n%s▶ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RESET" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 1; }

DO_MIGRATIONS=1; DO_SECRETS=1; DO_DEPLOY=1
case "${1:-}" in
  --migrations-only) DO_SECRETS=0; DO_DEPLOY=0 ;;
  --secrets-only)    DO_MIGRATIONS=0; DO_DEPLOY=0 ;;
  --deploy-only)     DO_MIGRATIONS=0; DO_SECRETS=0 ;;
  "" ) ;;
  * ) die "Option inconnue : $1" ;;
esac

# -----------------------------------------------------------------------------
# Prérequis
# -----------------------------------------------------------------------------
step "Vérification des prérequis"
command -v supabase >/dev/null 2>&1 \
  || die "La CLI Supabase est absente. Installation : https://supabase.com/docs/guides/cli"
ok "CLI Supabase : $(supabase --version 2>/dev/null | head -1)"

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ] && [ -f supabase-config.js ]; then
  # Déduit la référence du projet depuis l'URL déjà configurée pour le frontend.
  PROJECT_REF="$(sed -n 's#.*https://\([a-z0-9]\{20\}\)\.supabase\.co.*#\1#p' supabase-config.js | head -1)"
fi
[ -n "$PROJECT_REF" ] || die "Référence du projet introuvable. Renseigne SUPABASE_PROJECT_REF=xxx."
ok "Projet Supabase : $PROJECT_REF"

REDIRECT_URI="https://${PROJECT_REF}.supabase.co/functions/v1/brightspace-callback"

# -----------------------------------------------------------------------------
# 2. Migrations
# -----------------------------------------------------------------------------
if [ "$DO_MIGRATIONS" = 1 ]; then
  step "Étape 2 — migrations SQL"
  if [ -n "${DATABASE_URL:-}" ]; then
    command -v psql >/dev/null 2>&1 || die "psql est absent (nécessaire quand DATABASE_URL est défini)."
    for f in supabase/schema.sql \
             supabase/migrations/001_brightspace.sql \
             supabase/migrations/002_centralisation.sql \
             supabase/migrations/003_sync_layer.sql \
             supabase/migrations/004_oauth_hardening.sql; do
      [ -f "$f" ] || die "Fichier manquant : $f"
      printf '  … %s\n' "$f"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null \
        || die "Échec sur $f. Rien n'a été laissé à moitié appliqué : les migrations sont idempotentes, corrige et relance."
    done
    ok "Migrations appliquées"

    step "Vérification post-migration"
    TOKEN_GRANTS="$(psql "$DATABASE_URL" -tAX -c "
      select count(*) from information_schema.column_privileges
       where table_name='brightspace_connections'
         and grantee in ('anon','authenticated')
         and column_name in ('access_token_enc','refresh_token_enc','refresh_lock_at')")"
    [ "$TOKEN_GRANTS" = "0" ] \
      || die "ARRÊT : les colonnes de tokens sont accessibles au navigateur ($TOKEN_GRANTS privilège(s)). Ne déploie pas."
    ok "Les colonnes de tokens sont hors de portée du navigateur"

    NO_RLS="$(psql "$DATABASE_URL" -tAX -c "
      select count(*) from pg_tables where schemaname='public' and not rowsecurity")"
    [ "$NO_RLS" = "0" ] || die "ARRÊT : $NO_RLS table(s) de public sans RLS."
    ok "RLS active sur toutes les tables de public"
  else
    warn "DATABASE_URL n'est pas défini : les migrations ne peuvent pas être appliquées automatiquement."
    cat <<EOF

  Deux possibilités :
    a) définir la chaîne de connexion et relancer :
         export DATABASE_URL='postgresql://postgres:<mdp>@db.${PROJECT_REF}.supabase.co:5432/postgres'
         ./scripts/setup-supabase.sh --migrations-only
       (Dashboard → Project Settings → Database → Connection string → URI)

    b) coller manuellement, dans cet ordre, dans le SQL Editor du dashboard :
         supabase/schema.sql
         supabase/migrations/001_brightspace.sql
         supabase/migrations/002_centralisation.sql
         supabase/migrations/003_sync_layer.sql
         supabase/migrations/004_oauth_hardening.sql
       puis les tests : supabase/tests/rls_tests.sql
                        supabase/tests/sync_idempotency_tests.sql
       (les deux doivent afficher 0 FAIL sur la ligne RÉSUMÉ)

EOF
  fi
fi

# -----------------------------------------------------------------------------
# 3. Secrets
# -----------------------------------------------------------------------------
if [ "$DO_SECRETS" = 1 ]; then
  step "Étape 3 — secrets Supabase"
  cat <<EOF
  Les valeurs marquées (étape 1) viennent de l'application OAuth enregistrée
  dans Brightspace par l'administrateur. Rien n'est affiché ni écrit sur disque.

EOF
  supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1 || die "Échec de « supabase link ». Es-tu connecté (supabase login) ?"
  ok "Projet lié"

  read -r -p "  Client ID Brightspace (étape 1) : " BS_CLIENT_ID
  [ -n "$BS_CLIENT_ID" ] || die "Client ID vide."

  read -r -s -p "  Client Secret Brightspace (étape 1, non affiché) : " BS_CLIENT_SECRET; echo
  [ -n "$BS_CLIENT_SECRET" ] || die "Client Secret vide."

  read -r -p "  URL du tenant [https://emlyon.brightspace.com] : " BS_TENANT
  BS_TENANT="${BS_TENANT:-https://emlyon.brightspace.com}"

  DEFAULT_APP_URL="https://antsvfr.github.io/REV-EM/"
  read -r -p "  URL publique du site [$DEFAULT_APP_URL] : " APP_URL
  APP_URL="${APP_URL:-$DEFAULT_APP_URL}"

  DEFAULT_SCOPES="enrollment:orgunit:read content:toc:read content:modules:read content:topics:read users:userdata:read"
  read -r -p "  Scopes accordés [par défaut : les 5 en lecture seule] : " BS_SCOPES
  BS_SCOPES="${BS_SCOPES:-$DEFAULT_SCOPES}"

  # Refus net de toute permission d'écriture : même garde-fou que la fonction
  # brightspace-connect, appliqué avant même le déploiement.
  for s in $BS_SCOPES; do
    perm="${s##*:}"
    case "$perm" in
      read) ;;
      *) die "Scope non lecture seule refusé : « $s ». REV-EM ne doit rien pouvoir écrire dans Brightspace." ;;
    esac
  done
  ok "Scopes validés (lecture seule)"

  # Clé de chiffrement : réutilisée si elle existe déjà, car la changer rendrait
  # tous les tokens déjà stockés indéchiffrables.
  if supabase secrets list 2>/dev/null | grep -q BRIGHTSPACE_TOKEN_ENC_KEY; then
    warn "BRIGHTSPACE_TOKEN_ENC_KEY existe déjà — elle est CONSERVÉE (la changer invaliderait les connexions existantes)."
    ENC_ARG=""
  else
    command -v openssl >/dev/null 2>&1 || die "openssl est absent (nécessaire pour générer la clé de chiffrement)."
    ENC_KEY="$(openssl rand -base64 32)"
    ENC_ARG="BRIGHTSPACE_TOKEN_ENC_KEY=$ENC_KEY"
    ok "Clé de chiffrement AES-256 générée (non affichée)"
  fi

  supabase secrets set \
    BRIGHTSPACE_CLIENT_ID="$BS_CLIENT_ID" \
    BRIGHTSPACE_CLIENT_SECRET="$BS_CLIENT_SECRET" \
    BRIGHTSPACE_TENANT_URL="$BS_TENANT" \
    BRIGHTSPACE_APP_URL="$APP_URL" \
    BRIGHTSPACE_SCOPES="$BS_SCOPES" \
    ${ENC_ARG:+"$ENC_ARG"} >/dev/null \
    || die "Échec de l'enregistrement des secrets."
  unset BS_CLIENT_SECRET ENC_KEY ENC_ARG
  ok "Secrets enregistrés"
fi

# -----------------------------------------------------------------------------
# 4. Déploiement
# -----------------------------------------------------------------------------
if [ "$DO_DEPLOY" = 1 ]; then
  step "Étape 4 — déploiement des Edge Functions"
  supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1 || true

  for fn in brightspace-connect brightspace-refresh brightspace-status \
            brightspace-api brightspace-disconnect; do
    printf '  … %s\n' "$fn"
    supabase functions deploy "$fn" >/dev/null || die "Échec du déploiement de $fn."
  done
  ok "Cinq fonctions déployées avec vérification JWT"

  # Le callback est appelé par une REDIRECTION DE NAVIGATEUR : aucune en-tête
  # Authorization. Avec la vérification JWT, le retour d'OAuth échouerait
  # systématiquement. Sa sécurité repose sur la signature du state et son nonce
  # à usage unique.
  printf '  … brightspace-callback (--no-verify-jwt)\n'
  supabase functions deploy brightspace-callback --no-verify-jwt >/dev/null \
    || die "Échec du déploiement de brightspace-callback."
  ok "Callback déployé sans vérification JWT (obligatoire)"
fi

# -----------------------------------------------------------------------------
step "Terminé"
cat <<EOF

  Redirect URI à déclarer dans Brightspace (étape 1), caractère pour caractère :

      ${BOLD}${REDIRECT_URI}${RESET}

  Vérification : ./scripts/verify-setup.sh
  Puis, dans l'application : Ressources → Sources connectées → Connecter Brightspace.

EOF
