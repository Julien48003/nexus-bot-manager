#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Nexus Bot Manager — Script de mise à jour
#
# Modes d'appel :
#   1) Mode CLI :  bash scripts/update.sh [--from-version <ver>]
#        → Sortie colorée, affichée directement à l'utilisateur.
#   2) Mode API : NEXUS_PROGRESS_FILE défini
#        → Écrit la progression dans le fichier JSON pointé par
#          NEXUS_PROGRESS_FILE (lu par le backend).
#
# Les étapes doivent rester synchronisées avec les `STEPS` du service
# backend `update.service.js`.
# ═══════════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()     { echo -e "${BLUE}[Nexus]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# ── CLI parsing ────────────────────────────────────────────
FROM_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-version) FROM_VERSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Progress helpers ───────────────────────────────────────
# When called by the API, write a step update to NEXUS_PROGRESS_FILE.
PROGRESS_FILE="${NEXUS_PROGRESS_FILE:-}"

step_begin() {
  if [[ -n "$PROGRESS_FILE" ]]; then
    node -e "
      const fs = require('fs');
      const f  = process.env.PROGRESS_FILE;
      let s = {};
      try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { s = { steps: [] }; }
      s.currentStep = '$1';
      s.percent     = Math.max(s.percent || 0, $2);
      s.message     = '$3';
      const step = (s.steps || []).find(x => x.id === '$1');
      if (step) { step.status = 'running'; step.at = Date.now(); }
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    " PROGRESS_FILE="$PROGRESS_FILE" || true
  fi
  if [[ -z "$QUIET" ]]; then log "[$1] $3"; fi
}

step_done() {
  if [[ -n "$PROGRESS_FILE" ]]; then
    node -e "
      const fs = require('fs');
      const f  = process.env.PROGRESS_FILE;
      let s = {};
      try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
      s.percent = Math.max(s.percent || 0, $2);
      const step = (s.steps || []).find(x => x.id === '$1');
      if (step) { step.status = 'done'; step.at = Date.now(); }
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    " PROGRESS_FILE="$PROGRESS_FILE" || true
  fi
  if [[ -z "$QUIET" ]]; then success "[$1] OK"; fi
}

# ── Root check ─────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Ce script doit être exécuté en tant que root (sudo bash update.sh)"

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "$INSTALL_DIR/scripts")"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

# Quick mode for API (less chatter)
[[ -n "$PROGRESS_FILE" ]] && QUIET=1

if [[ -z "$QUIET" ]]; then
  echo -e "${BLUE}"
  echo '╔═══════════════════════════════════════════╗'
  echo '║   Nexus Bot Manager — Mise à jour        ║'
  echo '╚═══════════════════════════════════════════╝'
  echo -e "${NC}"
fi

# ── Step: preflight ────────────────────────────────────────
step_begin preflight 5 "Vérifications préalables"
[[ -d "$INSTALL_DIR" ]] || error "Installation introuvable : $INSTALL_DIR"
command -v node   >/dev/null || error "Node.js manquant"
command -v npm    >/dev/null || error "npm manquant"
command -v pm2    >/dev/null || error "pm2 manquant — installez-le (npm i -g pm2)"
command -v rsync  >/dev/null || error "rsync manquant — installez-le (apt install rsync)"
[[ -f "$INSTALL_DIR/scripts/update.sh" ]] || error "Script update.sh absent dans l'installation"

# Detect target version from remote tag (passed by backend)
TARGET_VERSION="${NEXUS_TO_VERSION:-${FROM_VERSION:-}}"
step_done preflight 5

# ── Step: backup ───────────────────────────────────────────
step_begin backup 15 "Sauvegarde de la configuration"
mkdir -p "$INSTALL_DIR/data/backups"
BACKUP_FILE="$INSTALL_DIR/data/backups/env-$(date +%Y%m%d-%H%M%S).bak"
if [[ -f "$INSTALL_DIR/backend/.env" ]]; then
  cp "$INSTALL_DIR/backend/.env" "$BACKUP_FILE" 2>/dev/null && chmod 600 "$BACKUP_FILE" || warn "Échec de la sauvegarde du .env"
  success "Configuration sauvegardée"
fi
step_done backup 15

# ── Step: fetch ────────────────────────────────────────────
# The frontend never touches Git directly. The backend will fetch the
# archive into $INSTALL_DIR/data/update-source/ before invoking this
# script. We just check it exists.
step_begin fetch 25 "Téléchargement de la nouvelle version"
SOURCE_TREE="${NEXUS_UPDATE_SOURCE:-$SOURCE_DIR}"
if [[ ! -d "$SOURCE_TREE/backend" ]] || [[ ! -d "$SOURCE_TREE/frontend" ]]; then
  error "Arborescence source invalide : $SOURCE_TREE"
fi
step_done fetch 25

# ── Step: stop ─────────────────────────────────────────────
step_begin stop 35 "Arrêt du service Nexus"
pm2 stop nexus-bot-manager >/dev/null 2>&1 || true
sleep 1
step_done stop 35

# ── Step: apply ────────────────────────────────────────────
step_begin apply 55 "Application des fichiers"
# On preserve strictement: .env, data/, node_modules/
rsync -a --exclude='.env' --exclude='data/' --exclude='node_modules/' \
  "$SOURCE_TREE/backend/"  "$INSTALL_DIR/backend/"  || error "rsync backend échoué"
rsync -a "$SOURCE_TREE/frontend/" "$INSTALL_DIR/frontend/" || error "rsync frontend échoué"
rsync -a "$SOURCE_TREE/scripts/"  "$INSTALL_DIR/scripts/"  || error "rsync scripts échoué"
step_done apply 55

# ── Step: dependencies ─────────────────────────────────────
step_begin dependencies 70 "Installation des dépendances"
cd "$INSTALL_DIR/backend" || error "Répertoire backend introuvable"
npm install --production --loglevel=error || error "npm install échoué"
step_done dependencies 70

# ── Step: syntax ───────────────────────────────────────────
step_begin syntax 78 "Vérification de la syntaxe"
# Use node --check to validate the main file without starting it.
node --check "$INSTALL_DIR/backend/src/server.js" || error "Erreur de syntaxe dans server.js"
node --check "$INSTALL_DIR/backend/src/services/update.service.js" || error "Erreur de syntaxe dans update.service.js"
node --check "$INSTALL_DIR/backend/src/services/version.service.js" || error "Erreur de syntaxe dans version.service.js"
node --check "$INSTALL_DIR/backend/src/routes/update.js" || error "Erreur de syntaxe dans routes/update.js"
step_done syntax 78

# ── Step: restart ──────────────────────────────────────────
step_begin restart 90 "Redémarrage du service"
if PATH=$PATH:/usr/local/bin pm2 restart nexus-bot-manager >/dev/null 2>&1; then
  :
else
  PATH=$PATH:/usr/local/bin pm2 start "$INSTALL_DIR/backend/src/server.js" \
    --name nexus-bot-manager --cwd "$INSTALL_DIR/backend" \
    >/dev/null 2>&1 || error "Redémarrage PM2 échoué"
fi
pm2 save --force >/dev/null 2>&1 || true
# Give the new process a moment to bind the port
sleep 2
step_done restart 90

# ── Step: verify ───────────────────────────────────────────
step_begin verify 96 "Vérification du service"
RETRIES=15
while (( RETRIES > 0 )); do
  if curl -fsS "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null 2>&1; then
    success "Service opérationnel"
    break
  fi
  RETRIES=$((RETRIES - 1))
  sleep 1
done
if (( RETRIES == 0 )); then
  warn "Le service ne répond pas encore — vérifiez avec : pm2 logs nexus-bot-manager"
fi
step_done verify 96

# ── Step: finalize ─────────────────────────────────────────
step_begin finalize 100 "Finalisation"
# Refresh .nexus-version so the backend reflects the actually installed code.
NEW_VERSION=$(node -e "console.log(require('$INSTALL_DIR/backend/package.json').version)" 2>/dev/null || echo "")
if [[ -n "$NEW_VERSION" && "$NEW_VERSION" != "undefined" ]]; then
  printf 'v%s\n' "$NEW_VERSION" > "$INSTALL_DIR/.nexus-version"
  chmod 644 "$INSTALL_DIR/.nexus-version"
fi
# Clean any leftover source tree
if [[ "$SOURCE_TREE" != "$SOURCE_DIR" ]] && [[ -d "$SOURCE_TREE" ]]; then
  rm -rf "$SOURCE_TREE"
fi
step_done finalize 100

if [[ -z "$QUIET" ]]; then
  echo ""
  echo -e "${GREEN}✅ Mise à jour terminée vers ${TARGET_VERSION:-nouvelle version}${NC}"
  pm2 status nexus-bot-manager || true
fi
exit 0