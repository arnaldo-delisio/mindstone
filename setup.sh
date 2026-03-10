#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================
#  MindStone Setup — Interactive .env Scaffolding Wizard
# ============================================================
#
#  This script collects all required configuration values and
#  writes:
#    - .daemon/.env    (sync daemon config)
#    - .intelligence/.env  (MCP server / intelligence pipeline config)
#
#  Have the following ready before running:
#    - Supabase project URL and service_role key
#      (Project Settings → API in the Supabase dashboard)
#    - Supabase DATABASE_URL — Session pooler connection string
#      (Settings → Database → Connection string, port 5432)
#    - OpenAI API key   https://platform.openai.com/api-keys
#    - Gemini API key   https://aistudio.google.com/apikey
#
# ============================================================

echo ""
echo "============================================================"
echo "  MindStone Setup"
echo "============================================================"
echo ""
echo "This wizard configures your MindStone environment."
echo "Have your Supabase credentials ready before continuing."
echo ""

# ------------------------------------------------------------
# Helper: prompt for a required value (re-prompts if blank)
# Usage: prompt VAR_NAME "Description" "example value"
# ------------------------------------------------------------
prompt() {
  local var_name="$1"
  local description="$2"
  local example="$3"
  local value=""
  while [[ -z "$value" ]]; do
    printf "  %s\n" "$description"
    if [[ -n "$example" ]]; then
      printf "  Example: %s\n" "$example"
    fi
    printf "  > "
    read -r value
    if [[ -z "$value" ]]; then
      echo "  [required — please enter a value]"
    fi
  done
  printf -v "$var_name" '%s' "$value"
}

# ------------------------------------------------------------
# Helper: prompt for an optional value (empty input allowed)
# Usage: prompt_optional VAR_NAME "Description" "example"
# ------------------------------------------------------------
prompt_optional() {
  local var_name="$1"
  local description="$2"
  local example="$3"
  printf "  %s\n" "$description"
  if [[ -n "$example" ]]; then
    printf "  Example: %s\n" "$example"
  fi
  printf "  > "
  local value=""
  read -r value
  printf -v "$var_name" '%s' "$value"
}

# ============================================================
#  Guard: existing .env files
# ============================================================

DAEMON_ENV="$REPO_DIR/.daemon/.env"
INTEL_ENV="$REPO_DIR/.intelligence/.env"

if [[ -f "$DAEMON_ENV" || -f "$INTEL_ENV" ]]; then
  echo "  Warning: one or more .env files already exist:"
  [[ -f "$DAEMON_ENV" ]]  && echo "    $DAEMON_ENV"
  [[ -f "$INTEL_ENV" ]] && echo "    $INTEL_ENV"
  echo ""
  printf "  Overwrite? (y/N): "
  read -r OVERWRITE
  if [[ "${OVERWRITE,,}" != "y" ]]; then
    echo ""
    echo "  Aborted. Existing .env files were not modified."
    exit 0
  fi
  echo ""
fi

# ============================================================
#  Section 1: Daemon env vars  →  .daemon/.env
# ============================================================

echo "------------------------------------------------------------"
echo "  Step 1 of 2: Sync Daemon Configuration"
echo "------------------------------------------------------------"
echo ""

prompt SUPABASE_URL \
  "Supabase project URL (Project Settings → API)" \
  "https://your-project-id.supabase.co"

prompt SUPABASE_SERVICE_ROLE_KEY \
  "Supabase service_role key (NOT the anon key)" \
  "eyJ..."

echo ""
prompt VAULT_PATH \
  "Absolute path to your local vault directory" \
  "~/vault"

# Expand tilde to absolute path
VAULT_PATH="${VAULT_PATH/#\~/$HOME}"
echo ""
echo "  Vault path (expanded): $VAULT_PATH"
echo ""

prompt VAULT_USER_ID \
  "Your Supabase user ID (run: SELECT id FROM auth.users LIMIT 1; in the SQL editor)" \
  "00000000-0000-0000-0000-000000000001"

echo ""
echo "  Writing $DAEMON_ENV ..."
mkdir -p "$REPO_DIR/.daemon"
printf "SUPABASE_URL=%s\n"            "$SUPABASE_URL"            > "$DAEMON_ENV"
printf "SUPABASE_SERVICE_ROLE_KEY=%s\n" "$SUPABASE_SERVICE_ROLE_KEY" >> "$DAEMON_ENV"
printf "VAULT_PATH=%s\n"              "$VAULT_PATH"              >> "$DAEMON_ENV"
printf "VAULT_USER_ID=%s\n"           "$VAULT_USER_ID"           >> "$DAEMON_ENV"
echo "  Done."
echo ""

# ============================================================
#  Section 2: Intelligence / MCP env vars  →  .intelligence/.env
# ============================================================

echo "------------------------------------------------------------"
echo "  Step 2 of 2: Intelligence / MCP Server Configuration"
echo "------------------------------------------------------------"
echo ""

echo "  Using same Supabase URL as daemon: $SUPABASE_URL"
echo ""

prompt DATABASE_URL \
  "Session pooler connection string from Supabase → Settings → Database → Connection string.
  Use port 5432 (NOT 6543 — Transaction pooler port will fail on Railway)." \
  "postgresql://postgres.your-project-id:password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"

# --- Auto-generate secrets --------------------------------
echo ""
echo "  Generating secrets (saving these is recommended)..."
echo ""

OAUTH_CLIENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 64)
API_KEY=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)

echo "  OAUTH_CLIENT_ID:     $OAUTH_CLIENT_ID"
echo "  OAUTH_CLIENT_SECRET: $OAUTH_CLIENT_SECRET"
echo "  SESSION_SECRET:      $SESSION_SECRET"
echo "  API_KEY:             $API_KEY"
echo "  BETTER_AUTH_SECRET:  $BETTER_AUTH_SECRET"
echo ""

# --- OAUTH_PASSWORD_HASH ----------------------------------
echo "  To generate your password hash, run this command in a separate terminal"
echo "  (after npm install in .intelligence/ completes below):"
echo ""
echo "    node -e \"require('bcrypt').hash('YOUR_PASSWORD', 12).then(console.log)\""
echo ""
echo "  Then paste the resulting hash below."
echo ""
prompt OAUTH_PASSWORD_HASH \
  "Paste the bcrypt hash of your desired MCP login password" \
  "\$2b\$12\$..."

# --- AI keys ----------------------------------------------
echo ""
prompt OPENAI_API_KEY \
  "OpenAI API key — https://platform.openai.com/api-keys" \
  "sk-..."

prompt GEMINI_API_KEY \
  "Gemini API key — https://aistudio.google.com/apikey" \
  "AIza..."

echo ""
prompt_optional SUPADATA_API_KEY \
  "Supadata API key (optional — used for YouTube transcript extraction) — https://supadata.ai" \
  ""

# --- Timezone ---------------------------------------------
echo ""
echo "  Vault timezone (optional). Press Enter to use UTC."
echo "  Find yours: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
printf "  > "
read -r VAULT_TIMEZONE
VAULT_TIMEZONE="${VAULT_TIMEZONE:-UTC}"
echo "  Using timezone: $VAULT_TIMEZONE"

# --- SERVER_URL -------------------------------------------
echo ""
prompt_optional SERVER_URL \
  "Railway URL (optional — leave blank for now; re-run this script after first Railway deploy)" \
  "https://mindstone-xxx.up.railway.app"

# --- GCal (optional) -------------------------------------
echo ""
echo "  Google Calendar credentials (optional — required only for GCal sync)."
echo "  See docs/gcal-setup.md for setup instructions. Press Enter to skip each."
echo ""
prompt_optional GCAL_CLIENT_ID     "Google OAuth client ID" ""
prompt_optional GCAL_CLIENT_SECRET "Google OAuth client secret" ""
prompt_optional GCAL_REFRESH_TOKEN "Google refresh token" ""

# --- Write .intelligence/.env ----------------------------
echo ""
echo "  Writing $INTEL_ENV ..."
mkdir -p "$REPO_DIR/.intelligence"
printf "SERVER_URL=%s\n"                "$SERVER_URL"                > "$INTEL_ENV"
printf "SUPABASE_URL=%s\n"              "$SUPABASE_URL"              >> "$INTEL_ENV"
printf "SUPABASE_SERVICE_ROLE_KEY=%s\n" "$SUPABASE_SERVICE_ROLE_KEY" >> "$INTEL_ENV"
printf "DATABASE_URL=%s\n"              "$DATABASE_URL"              >> "$INTEL_ENV"
printf "OAUTH_CLIENT_ID=%s\n"           "$OAUTH_CLIENT_ID"           >> "$INTEL_ENV"
printf "OAUTH_CLIENT_SECRET=%s\n"       "$OAUTH_CLIENT_SECRET"       >> "$INTEL_ENV"
printf "OAUTH_PASSWORD_HASH=%s\n"       "$OAUTH_PASSWORD_HASH"       >> "$INTEL_ENV"
printf "SESSION_SECRET=%s\n"            "$SESSION_SECRET"            >> "$INTEL_ENV"
printf "API_KEY=%s\n"                   "$API_KEY"                   >> "$INTEL_ENV"
printf "BETTER_AUTH_SECRET=%s\n"        "$BETTER_AUTH_SECRET"        >> "$INTEL_ENV"
printf "OPENAI_API_KEY=%s\n"            "$OPENAI_API_KEY"            >> "$INTEL_ENV"
printf "GEMINI_API_KEY=%s\n"            "$GEMINI_API_KEY"            >> "$INTEL_ENV"
printf "SUPADATA_API_KEY=%s\n"          "$SUPADATA_API_KEY"          >> "$INTEL_ENV"
printf "VAULT_TIMEZONE=%s\n"            "$VAULT_TIMEZONE"            >> "$INTEL_ENV"
printf "GCAL_CLIENT_ID=%s\n"            "$GCAL_CLIENT_ID"            >> "$INTEL_ENV"
printf "GCAL_CLIENT_SECRET=%s\n"        "$GCAL_CLIENT_SECRET"        >> "$INTEL_ENV"
printf "GCAL_REFRESH_TOKEN=%s\n"        "$GCAL_REFRESH_TOKEN"        >> "$INTEL_ENV"
printf "ALLOW_PROD_QUEUES=%s\n"         "true"                       >> "$INTEL_ENV"
echo "  Done."
echo ""

# ============================================================
#  Install dependencies
# ============================================================

echo "------------------------------------------------------------"
echo "  Installing dependencies"
echo "------------------------------------------------------------"
echo ""
echo "  Installing daemon dependencies..."
(cd "$REPO_DIR/.daemon" && npm install --silent)
echo "  Done."
echo ""
echo "  Installing intelligence dependencies..."
(cd "$REPO_DIR/.intelligence" && npm install --silent)
echo "  Done."
echo ""

# ============================================================
#  Migration instructions
# ============================================================

echo ""
echo "================================================"
echo "  Next: apply the Supabase migration"
echo "================================================"
echo ""
echo "  Install the Supabase CLI if you haven't:"
echo "    https://supabase.com/docs/guides/local-development/cli/getting-started"
echo ""
echo "  Then run:"
echo "    supabase link --project-ref YOUR_PROJECT_REF"
echo "    supabase db push"
echo ""
echo "  (Find your project ref in the Supabase dashboard URL)"
echo "================================================"
echo ""

# ============================================================
#  Final summary
# ============================================================

echo "setup.sh complete. Run install.sh next to start the daemon."
echo ""
