#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================
#  MindStone Daemon Installer
#  Requires: setup.sh completed, Node.js, npm
# ============================================================

echo ""
echo "============================================================"
echo "  MindStone Daemon Installer"
echo "============================================================"
echo ""

# ============================================================
#  Guard: .daemon/.env must exist
# ============================================================

DAEMON_ENV="$REPO_DIR/.daemon/.env"
if [[ ! -f "$DAEMON_ENV" ]]; then
  echo "Error: .daemon/.env not found. Run setup.sh first."
  exit 1
fi

# ============================================================
#  Check Node.js
# ============================================================

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org"
  exit 1
fi

echo "  Node.js: $(node --version)"
echo ""

# ============================================================
#  Install pm2 if missing
# ============================================================

if ! command -v pm2 &>/dev/null; then
  echo "  Installing pm2 globally..."
  npm install pm2@latest -g
  echo "  pm2 installed."
else
  echo "  pm2 already installed: $(pm2 --version)"
fi

echo ""

# ============================================================
#  Build intelligence service
# ============================================================

echo "------------------------------------------------------------"
echo "  Building intelligence service (this may take a moment)..."
echo "------------------------------------------------------------"
echo ""

if ! (cd "$REPO_DIR/.intelligence" && npm run build); then
  echo ""
  echo "Build failed. Check .intelligence/ for errors."
  exit 1
fi

echo ""
echo "  Build complete."
echo ""

# ============================================================
#  Create vault directory structure
# ============================================================

VAULT_PATH=$(grep ^VAULT_PATH= "$DAEMON_ENV" | cut -d= -f2-)

if [[ -z "$VAULT_PATH" ]]; then
  echo "Error: VAULT_PATH not found in $DAEMON_ENV. Re-run setup.sh."
  exit 1
fi

echo "  Creating vault directory structure at $VAULT_PATH ..."
mkdir -p "$VAULT_PATH"/{daily,weekly,monthly,library,events,goals,reviews,mocs,media,.personas}
mkdir -p "$VAULT_PATH/.claude/skills"
echo "  Vault directory structure created at $VAULT_PATH"
echo ""

# ============================================================
#  Start daemon via pm2
# ============================================================

echo "------------------------------------------------------------"
echo "  Starting MindStone daemon via pm2"
echo "------------------------------------------------------------"
echo ""

pm2 start "$REPO_DIR/ecosystem.config.cjs" --env production
pm2 save

echo ""

# ============================================================
#  pm2 startup — register for boot
# ============================================================

echo "=================================================================="
echo "  IMPORTANT: Register pm2 to start on system boot"
echo "=================================================================="
echo ""

pm2 startup

echo ""
echo "  Copy the 'sudo env PATH=...' command above and run it now."
echo "  Then press Enter to continue."
read -r _
echo "=================================================================="
echo ""

# ============================================================
#  Final status
# ============================================================

pm2 status
echo ""
echo "MindStone daemon is running. Check logs with: pm2 logs mindstone-daemon"
echo ""
echo "Next steps:"
echo "  1. Copy the Railway URL from your Railway dashboard"
echo "  2. Re-run setup.sh and paste it when prompted for SERVER_URL"
echo "  3. Open Claude Desktop or Claude.ai and connect the MCP server"
echo "     See README.md for Claude.ai MCP connection steps"
echo ""
