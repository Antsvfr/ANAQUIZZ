#!/usr/bin/env bash
# =============================================================================
# REV-EM — vérifie que la configuration Brightspace est réellement en place
# -----------------------------------------------------------------------------
# À lancer APRÈS scripts/setup-supabase.sh. Ne modifie rien : il constate.
#
# Ce qui est vérifié réellement :
#   • les six Edge Functions répondent, et refusent un appel sans session ;
#   • le callback, lui, est bien joignable SANS jeton (sinon OAuth casserait) ;
#   • les secrets obligatoires sont enregistrés ;
#   • la base : RLS active, colonnes de tokens hors de portée du navigateur ;
#   • la Redirect URI attendue, à comparer à celle déclarée dans Brightspace.
#
# Ce qui ne peut PAS être vérifié ici : que Brightspace accepte cette
# application. Seul un vrai essai de connexion le dira.
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; RESET=$'\033[0m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'
PASS=0; FAIL=0; SKIP=0
pass() { printf '  %sPASS%s  %s\n' "$GREEN" "$RESET" "$1"; PASS=$((PASS+1)); }
fail() { printf '  %sFAIL%s  %s\n' "$RED" "$RESET" "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  %s····%s  %s\n' "$YEL" "$RESET" "$1"; SKIP=$((SKIP+1)); }
step() { printf '\n%s▶ %s%s\n' "$BOLD" "$1" "$RESET"; }

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ] && [ -f supabase-config.js ]; then
  PROJECT_REF="$(sed -n 's#.*https://\([a-z0-9]\{20\}\)\.supabase\.co.*#\1#p' supabase-config.js | head -1)"
fi
if [ -z "$PROJECT_REF" ]; then
  printf '%sImpossible de déduire la référence du projet.%s\n' "$RED" "$RESET" >&2
  exit 1
fi
BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
REDIRECT_URI="${BASE}/brightspace-callback"

step "Projet"
printf '  Référence      : %s\n' "$PROJECT_REF"
printf '  Redirect URI   : %s%s%s\n' "$BOLD" "$REDIRECT_URI" "$RESET"
printf '  %s↑ doit être déclarée à l'"'"'identique dans Brightspace (étape 1)%s\n' "$YEL" "$RESET"

# -----------------------------------------------------------------------------
step "Edge Functions déployées et protégées"
# -----------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  skip "curl absent : impossible d'interroger les fonctions"
else
  for fn in brightspace-connect brightspace-refresh brightspace-status \
            brightspace-api brightspace-disconnect; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/$fn" \
            -H 'Content-Type: application/json' -d '{}' --max-time 20 2>/dev/null)"
    case "$code" in
      401) pass "$fn — déployée, et refuse un appel sans session (401)" ;;
      404) fail "$fn — NON DÉPLOYÉE (404). Lance ./scripts/setup-supabase.sh --deploy-only" ;;
      000) fail "$fn — injoignable (réseau ou projet en pause)" ;;
      200) fail "$fn — répond 200 SANS session : la vérification JWT est désactivée à tort" ;;
      *)   fail "$fn — réponse inattendue ($code)" ;;
    esac
  done

  # Le callback DOIT être joignable sans jeton : c'est une redirection de
  # navigateur. Sans code ni state, il redirige vers l'application.
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/brightspace-callback" --max-time 20 2>/dev/null)"
  case "$code" in
    302|303) pass "brightspace-callback — joignable sans jeton et redirige (--no-verify-jwt bien appliqué)" ;;
    401)     fail "brightspace-callback — répond 401 : il a été déployé AVEC vérification JWT. Le retour d'OAuth échouera. Redéploie : supabase functions deploy brightspace-callback --no-verify-jwt" ;;
    404)     fail "brightspace-callback — NON DÉPLOYÉE (404)" ;;
    000)     fail "brightspace-callback — injoignable" ;;
    *)       fail "brightspace-callback — réponse inattendue ($code)" ;;
  esac
fi

# -----------------------------------------------------------------------------
step "Site public (URL de retour d'OAuth)"
# -----------------------------------------------------------------------------
APP_URL="${BRIGHTSPACE_APP_URL:-https://antsvfr.github.io/REV-EM/}"
if ! command -v curl >/dev/null 2>&1; then
  skip "curl absent : site non vérifié"
else
  code="$(curl -s -o /dev/null -w '%{http_code}' -L "$APP_URL" --max-time 20 2>/dev/null)"
  case "$code" in
    200) pass "$APP_URL répond — c'est là que Brightspace renverra l'utilisateur" ;;
    404) fail "$APP_URL renvoie 404 : GitHub Pages n'est pas activé, ou pas sur ce chemin. Le retour d'OAuth échouerait." ;;
    000) skip "$APP_URL injoignable depuis cette machine (réseau ?)" ;;
    *)   fail "$APP_URL répond $code" ;;
  esac
fi

# -----------------------------------------------------------------------------
step "Secrets"
# -----------------------------------------------------------------------------
if ! command -v supabase >/dev/null 2>&1; then
  skip "CLI Supabase absente : secrets non vérifiés"
else
  SECRETS="$(supabase secrets list 2>/dev/null || true)"
  if [ -z "$SECRETS" ]; then
    skip "Impossible de lister les secrets (projet non lié ? supabase link --project-ref $PROJECT_REF)"
  else
    for s in BRIGHTSPACE_CLIENT_ID BRIGHTSPACE_CLIENT_SECRET BRIGHTSPACE_TENANT_URL \
             BRIGHTSPACE_TOKEN_ENC_KEY BRIGHTSPACE_APP_URL BRIGHTSPACE_SCOPES; do
      if printf '%s' "$SECRETS" | grep -q "$s"; then pass "$s est défini"
      else fail "$s MANQUANT — l'intégration ne peut pas fonctionner"; fi
    done
  fi
fi

# -----------------------------------------------------------------------------
step "Base de données"
# -----------------------------------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  skip "DATABASE_URL non défini : vérifications SQL sautées (voir BRIGHTSPACE_SETUP.md §5.2)"
elif ! command -v psql >/dev/null 2>&1; then
  skip "psql absent : vérifications SQL sautées"
else
  q() { psql "$DATABASE_URL" -tAX -c "$1" 2>/dev/null | tr -d '[:space:]'; }

  n="$(q "select count(*) from information_schema.column_privileges
          where table_name='brightspace_connections'
            and grantee in ('anon','authenticated')
            and column_name in ('access_token_enc','refresh_token_enc','refresh_lock_at')")"
  [ "$n" = "0" ] && pass "Les colonnes de tokens sont hors de portée du navigateur" \
                 || fail "DANGER : $n privilège(s) sur les colonnes de tokens"

  n="$(q "select count(*) from pg_tables where schemaname='public' and not rowsecurity")"
  [ "$n" = "0" ] && pass "RLS active sur toutes les tables de public" \
                 || fail "$n table(s) sans RLS"

  # Les six migrations sont-elles réellement passées ? On cherche un objet que
  # chacune est la seule à créer — même méthode que supabase/tests/00_diagnostic.sql.
  n="$(q "select (to_regclass('public.subjects') is not null)::int
               + (to_regclass('public.brightspace_connections') is not null)::int
               + (to_regclass('public.user_stats') is not null)::int
               + (exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='subjects'
                             and column_name='source_updated_at'))::int
               + (to_regclass('public.oauth_states') is not null)::int
               + (exists (select 1 from pg_indexes where schemaname='public'
                           and indexname='uq_subjects_user_local'))::int")"
  [ "$n" = "6" ] && pass "Les six migrations (000 → 005) sont appliquées" \
                 || fail "$n/6 migrations appliquées — exécute supabase/tests/00_diagnostic.sql pour savoir lesquelles manquent"

  n="$(q "select count(*) from information_schema.role_table_grants
          where table_name='oauth_states' and grantee in ('anon','authenticated')")"
  [ "$n" = "0" ] && pass "oauth_states inaccessible au client" \
                 || fail "oauth_states exposé au client ($n privilège(s))"

  n="$(q "select count(*) from pg_tables where schemaname='public'
            and tablename in ('brightspace_connections','sync_runs','oauth_states')")"
  [ "$n" = "3" ] && pass "Les tables de l'intégration existent" \
                 || fail "Migrations incomplètes ($n/3 tables)"

  n="$(q "select count(*) from public.brightspace_connections
           where access_token_enc is not null and access_token_enc not like '%.%'")"
  [ "$n" = "0" ] && pass "Aucun token stocké hors du format chiffré" \
                 || fail "$n token(s) potentiellement en clair"
fi

# -----------------------------------------------------------------------------
printf '\n%s▶ Bilan%s\n' "$BOLD" "$RESET"
printf '  %d PASS · %d FAIL · %d non vérifié(s)\n\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '  %sLa configuration n'"'"'est pas prête. Corrige les FAIL ci-dessus.%s\n\n' "$RED" "$RESET"
  exit 1
fi
printf '  Configuration serveur en place. Reste à essayer une connexion réelle :\n'
printf '  Ressources → Sources connectées → Connecter Brightspace.\n'
printf '  %sTant que cet essai n'"'"'a pas abouti, rien ne prouve que Brightspace accepte l'"'"'application.%s\n\n' "$YEL" "$RESET"
