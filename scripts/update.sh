#!/usr/bin/env bash
# -------------------------------------------------------------------
# Nexus Bot Manager — Script de mise à jour
#
# Modes d'appel :
#   1) Mode CLI :  bash scripts/update.sh [--from-version <ver>]
#        -> Sortie colorée, affichée directement à l'utilisateur.
#   2) Mode API : NEXUS_PROGRESS_FILE défini
#        -> Écrit la progression dans le fichier JSON pointé par
#          NEXUS_PROGRESS_FILE (lu par le backend).
#
# Les étapes doivent rester synchronisées avec les `STEPS` du service
# backend `update.service.js`.
# -------------------------------------------------------------------
set -euo pipefail

# UPD-19 — everything this script creates (the tree extracted from the
# release tarball, the .env backup, the progress file) must not be
# world-readable: a default umask of 022 produced 644 files holding the
# JWT secret.
umask 077

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()     { echo -e "${BLUE}[Nexus]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[ERREUR]${NC} $*"; exit 1; }

# -- CLI parsing --------------------------------------------
FROM_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-version)
      [[ $# -ge 2 ]] || error "Valeur manquante pour --from-version"
      FROM_VERSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# -- Progress helpers ---------------------------------------
# When called by the API, write a step update to NEXUS_PROGRESS_FILE.
PROGRESS_FILE="${NEXUS_PROGRESS_FILE:-}"

step_begin() {
  if [[ -n "$PROGRESS_FILE" ]]; then
    PROGRESS_FILE="$PROGRESS_FILE" node -e "
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
    " || true
  fi
  if [[ -z "${QUIET:-}" ]]; then log "[$1] $3"; fi
}

step_done() {
  if [[ -n "$PROGRESS_FILE" ]]; then
    PROGRESS_FILE="$PROGRESS_FILE" node -e "
      const fs = require('fs');
      const f  = process.env.PROGRESS_FILE;
      let s = {};
      try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
      s.percent = Math.max(s.percent || 0, $2);
      const step = (s.steps || []).find(x => x.id === '$1');
      if (step) { step.status = 'done'; step.at = Date.now(); }
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    " || true
  fi
  if [[ -z "${QUIET:-}" ]]; then success "[$1] OK"; fi
}

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
PORT="${PORT:-3001}"
INSTALL_DIR="${INSTALL_DIR%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "$INSTALL_DIR/scripts")"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

case "${INSTALL_DIR}" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    error "INSTALL_DIR non sûr : ${INSTALL_DIR}" ;;
esac
if [[ "${INSTALL_DIR}" != /* ]] || [[ "${INSTALL_DIR}" == *"/.."* ]]; then
  error "INSTALL_DIR doit être un chemin absolu sans '..' (reçu : ${INSTALL_DIR})"
fi
if [[ ! -f "${INSTALL_DIR}/backend/package.json" ]]; then
  error "Refus : ${INSTALL_DIR} ne semble pas être une installation Nexus Bot Manager."
fi
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  error "PORT invalide : ${PORT}"
fi

# -- Privilege check ----------------------------------------
# Root installs update as root. A non-root installation (panel and PM2 running
# as a dedicated user) must update as that same user so ownership and
# PM2_HOME stay consistent. The panel sets NEXUS_ALLOW_NONROOT=1 when it is
# itself unprivileged; a manual operator can do the same deliberately.
if [[ $EUID -ne 0 ]]; then
  if [[ "${NEXUS_ALLOW_NONROOT:-}" != "1" ]]; then
    error "Exécutez en root, ou avec NEXUS_ALLOW_NONROOT=1 pour une installation non-root."
  fi
  [[ -w "${INSTALL_DIR}" && -w "${INSTALL_DIR}/backend" ]] \
    || error "L'utilisateur courant ne peut pas écrire dans ${INSTALL_DIR}."
fi

# Quick mode for API (less chatter)
[[ -n "$PROGRESS_FILE" ]] && QUIET=1 || QUIET=""

if [[ -z "${QUIET:-}" ]]; then
  echo -e "${BLUE}"
  echo '---------------------------------------------'
  echo '-   Nexus Bot Manager — Mise à jour        -'
  echo '---------------------------------------------'
  echo -e "${NC}"
fi

# -- Step: preflight ----------------------------------------
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

# -- Step: backup -------------------------------------------
step_begin backup 15 "Sauvegarde de la configuration"
mkdir -p "$INSTALL_DIR/data/backups"
BACKUP_FILE="$INSTALL_DIR/data/backups/env-$(date +%Y%m%d-%H%M%S).bak"
if [[ -f "$INSTALL_DIR/backend/.env" ]]; then
  cp "$INSTALL_DIR/backend/.env" "$BACKUP_FILE" 2>/dev/null && chmod 600 "$BACKUP_FILE" || warn "Échec de la sauvegarde du .env"
  success "Configuration sauvegardée"
fi
step_done backup 15

# -- Step: fetch --------------------------------------------
# The frontend never touches Git directly. The backend will fetch the
# archive into $INSTALL_DIR/data/update-source/ before invoking this
# script. We just check it exists.
step_begin fetch 25 "Téléchargement de la nouvelle version"
SOURCE_TREE="${NEXUS_UPDATE_SOURCE:-$SOURCE_DIR}"
if [[ ! -d "$SOURCE_TREE/backend" ]] || [[ ! -d "$SOURCE_TREE/frontend" ]]; then
  error "Arborescence source invalide : $SOURCE_TREE"
fi

if [[ -n "${NEXUS_COMMIT_SHA:-}" ]]; then
  [[ -d "$SOURCE_TREE/.git" ]] || error "NEXUS_COMMIT_SHA fourni mais la source n'est pas un clone Git."
  ACTUAL_COMMIT="$(git -C "$SOURCE_TREE" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$ACTUAL_COMMIT" != "$NEXUS_COMMIT_SHA" ]]; then
    error "Commit source inattendu : ${ACTUAL_COMMIT}, attendu ${NEXUS_COMMIT_SHA}."
  fi
fi
step_done fetch 25

# UPD-20: a major PM2 upgrade must be done deliberately, before this script
# stops the panel. Otherwise the new local pm2 module would talk to the old
# daemon and the operator would get a half-migrated process manager.
TARGET_PM2="$(node -e "
  const lock = require(process.argv[1]);
  process.stdout.write((lock.packages && lock.packages['node_modules/pm2'] && lock.packages['node_modules/pm2'].version) || '');
" "$SOURCE_TREE/backend/package-lock.json" 2>/dev/null || true)"
[[ -n "$TARGET_PM2" ]] || error "package-lock.json de la nouvelle version ne contient pas PM2."
GLOBAL_PM2="$(pm2 --version 2>/dev/null || true)"
if [[ -n "$GLOBAL_PM2" && "$TARGET_PM2" != "$GLOBAL_PM2" ]]; then
  error "PM2 global ${GLOBAL_PM2} incompatible avec la version cible ${TARGET_PM2}. Mettez PM2 à niveau et redémarrez son daemon avant la mise à jour (docs/SECURITY-PRODUCTION.md, section 2.7)."
fi

# UPD-14: validate the incoming tree BEFORE stopping the service and
# BEFORE overwriting anything. A syntax error must leave the running
# instance untouched.
if command -v node >/dev/null 2>&1; then
  for f in server.js db/db.js middleware/security.js middleware/auth.middleware.js \
           routes/auth.js routes/bots.js routes/files.js routes/backup.js \
           routes/system.js routes/update.js \
           services/fs.service.js services/update.service.js services/version.service.js \
           services/pm2.service.js services/system.service.js services/templates.service.js; do
    if [[ -f "$SOURCE_TREE/backend/src/$f" ]]; then
      node --check "$SOURCE_TREE/backend/src/$f" \
        || error "Syntaxe invalide dans $f — aucune modification n'a été appliquée."
    fi
  done
  success "Syntaxe de la nouvelle version vérifiée"
fi

# -- Step: preparation --------------------------------------
# Do NOT stop the panel here. When the update is started from the UI, this
# script is a child of the panel process; stopping the panel here would kill
# the updater itself and leave the panel stopped (the v1.1.5 failure).
# The final `pm2 restart` applies the new code.
step_begin stop 35 "Préparation"
step_done stop 35

# -- Step: apply --------------------------------------------
step_begin apply 55 "Application des fichiers"

# On preserve strictement: .env, data/, node_modules/
# UPD-18: --delete so a file removed upstream actually disappears, instead
# of lingering forever and being served by the old code path.
# --safe-links refuses symlinks that point outside the destination.
rsync -a --delete --safe-links \
  --exclude='.env' --exclude='data/' --exclude='node_modules/' \
  "$SOURCE_TREE/backend/"  "$INSTALL_DIR/backend/"  || error "rsync backend échoué"
rsync -a --delete --safe-links "$SOURCE_TREE/frontend/" "$INSTALL_DIR/frontend/" || error "rsync frontend échoué"
rsync -a --delete --safe-links "$SOURCE_TREE/scripts/"  "$INSTALL_DIR/scripts/"  || error "rsync scripts échoué"
step_done apply 55

# -- Step: dependencies -------------------------------------
step_begin dependencies 70 "Installation des dépendances"
cd "$INSTALL_DIR/backend" || error "Répertoire backend introuvable"
# UPD-07 — `npm ci` installs exactly what package-lock.json pins and never
# runs a package's install scripts; `npm install` remains the fallback so a
# lockfile out of sync with package.json cannot block an update entirely.
if [[ -f package-lock.json ]] && npm ci --omit=dev --loglevel=error --ignore-scripts 2>/dev/null; then
  success "Dépendances installées (npm ci, lockfile respecté)"
else
  warn "npm ci impossible — repli sur npm install"
  npm install --omit=dev --loglevel=error --ignore-scripts || error "npm install échoué"
fi

LOCAL_PM2="$(node -p "require('./node_modules/pm2/package.json').version" 2>/dev/null || true)"
GLOBAL_PM2="$(pm2 --version 2>/dev/null || true)"
if [[ -n "$LOCAL_PM2" && -n "$GLOBAL_PM2" && "$LOCAL_PM2" != "$GLOBAL_PM2" ]]; then
  warn "PM2 global ${GLOBAL_PM2} différent du module local ${LOCAL_PM2} ; alignez-les pour éviter un mélange CLI/daemon."
fi
step_done dependencies 70

# -- Step: syntax -------------------------------------------
step_begin syntax 78 "Vérification de la syntaxe"
# Use node --check to validate the main file without starting it.
node --check "$INSTALL_DIR/backend/src/server.js" || error "Erreur de syntaxe dans server.js"
node --check "$INSTALL_DIR/backend/src/services/update.service.js" || error "Erreur de syntaxe dans update.service.js"
node --check "$INSTALL_DIR/backend/src/services/version.service.js" || error "Erreur de syntaxe dans version.service.js"
node --check "$INSTALL_DIR/backend/src/routes/update.js" || error "Erreur de syntaxe dans routes/update.js"
step_done syntax 78

# -- Step: restart ------------------------------------------
step_begin restart 90 "Redémarrage du service"
if PATH=$PATH:/usr/local/bin pm2 restart nexus-bot-manager >/dev/null 2>&1; then
  :
else
  # `--env production` is ignored by PM2 for a plain script: pass NODE_ENV
  # in the environment instead, as the installer does.
  PM2_START_LOG="$(mktemp)"
  if ! NODE_ENV=production PATH=$PATH:/usr/local/bin pm2 start "$INSTALL_DIR/backend/src/server.js" \
    --name nexus-bot-manager --cwd "$INSTALL_DIR/backend" \
    --max-restarts 5 --restart-delay 3000 \
    >"$PM2_START_LOG" 2>&1; then
    warn "Démarrage PM2 impossible. Sortie :"
    sed 's/^/    /' "$PM2_START_LOG" 2>/dev/null || true
    rm -f "$PM2_START_LOG"
    error "Redémarrage PM2 échoué"
  fi
  rm -f "$PM2_START_LOG"
fi
pm2 save --force >/dev/null 2>&1 || true
# Give the new process a moment to bind the port
sleep 2
step_done restart 90

# -- Step: verify -------------------------------------------
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

# -- Step: finalize -----------------------------------------
step_begin finalize 100 "Finalisation"
# Version is read from <INSTALL_DIR>/backend/package.json — which has
# just been updated with the new release tag's content — so no extra
# file is written here. Remove any legacy .nexus-version to avoid
# drift between the file and the actual installed code.
NEW_VERSION="${NEXUS_TO_VERSION:-${TARGET_VERSION:-}}"
NEW_VERSION="${NEW_VERSION#v}"
if [[ -n "$NEW_VERSION" && "$NEW_VERSION" != "undefined" ]]; then
  rm -f "$INSTALL_DIR/.nexus-version"
fi
# Clean any leftover source tree (INF-12: it was left behind holding a
# copy of every file, and the .env backup it sat next to).
if [[ "$SOURCE_TREE" != "$SOURCE_DIR" ]] && [[ -d "$SOURCE_TREE" ]]; then
  # Only ever the directory the backend created under $INSTALL_DIR/data,
  # never $SOURCE_DIR and never a path outside the install directory.
  case "$SOURCE_TREE" in
    "$INSTALL_DIR"/data/update-source-*|"$INSTALL_DIR"/backend/data/update-source-*) rm -rf -- "$SOURCE_TREE" ;;
    *) warn "Source tree inattendue, conservée : $SOURCE_TREE" ;;
  esac
fi

# Keep only the three most recent .env backups, all at 0600. Leaving a
# growing pile of copies of the signing key on disk is itself a leak.
if [[ -d "$INSTALL_DIR/data/backups" ]]; then
  mapfile -t OLD_BACKUPS < <(ls -1t "$INSTALL_DIR"/data/backups/env-*.bak 2>/dev/null | tail -n +4)
  for old in "${OLD_BACKUPS[@]:-}"; do
    if [[ -n "$old" ]]; then rm -f -- "$old"; fi
  done
fi
step_done finalize 100

if [[ -z "${QUIET:-}" ]]; then
  echo ""
  echo -e "${GREEN}[OK] Mise à jour terminée vers ${TARGET_VERSION:-nouvelle version}${NC}"
  pm2 status nexus-bot-manager || true
fi
exit 0