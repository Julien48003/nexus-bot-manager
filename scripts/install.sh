#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Nexus Bot Manager — Script d'installation
# Compatible : Debian 11/12/13, Ubuntu 22.04/24.04
# Usage      : bash install.sh
# One-liner  : bash -c "$(curl -fsSL https://raw.githubusercontent.com/Julien48003/nexus-bot-manager/main/scripts/install.sh)"
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[Nexus]${NC} $*"
}

success() {
    echo -e "${GREEN}[✓]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $*"
}

error() {
    echo -e "${RED}[✗]${NC} $*"
    exit 1
}

# ── Configuration ────────────────────────────────────────────────
REPO_URL="https://github.com/Julien48003/nexus-bot-manager.git"
REPO_BRANCH="main"

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
PORT="${PORT:-3001}"
BOTS_ROOT="${BOTS_ROOT:-/opt}"

NODE_MIN_VERSION=20

# ── Banner ────────────────────────────────────────────────────────
echo -e "${BLUE}"
echo '╔═══════════════════════════════════════════════════╗'
echo '║         Nexus Bot Manager — Installateur          ║'
echo '║         Discord Bot Manager for Proxmox LXC       ║'
echo '╚═══════════════════════════════════════════════════╝'
echo -e "${NC}"

# ── Root check ───────────────────────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
    error "Ce script doit être exécuté en tant que root."
fi

# ── Architecture ─────────────────────────────────────────────────
ARCH="$(dpkg --print-architecture 2>/dev/null || echo "unknown")"

log "Architecture détectée : ${ARCH}"

# ═══════════════════════════════════════════════════════════════════
# STEP 1 — Dépendances système
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 1/6 — Installation des dépendances système..."

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq

apt-get install -y -qq \
    curl \
    wget \
    git \
    rsync \
    build-essential \
    python3 \
    ca-certificates \
    gnupg

success "Dépendances système installées"

# ═══════════════════════════════════════════════════════════════════
# STEP 2 — Node.js
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 2/6 — Vérification de Node.js..."

NODE_OK=false

if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node --version | sed 's/^v//' | cut -d. -f1)"

    if [[ "${NODE_VER}" -ge "${NODE_MIN_VERSION}" ]]; then
        success "Node.js $(node --version) déjà installé"
        NODE_OK=true
    else
        warn "Node.js $(node --version) est trop ancien"
    fi
fi

if [[ "${NODE_OK}" == false ]]; then
    log "Installation de Node.js ${NODE_MIN_VERSION} LTS..."

    curl -fsSL https://deb.nodesource.com/setup_20.x \
        | bash - >/dev/null 2>&1 \
        || error "Échec de l'installation du dépôt NodeSource."

    apt-get install -y nodejs >/dev/null 2>&1 \
        || error "Échec de l'installation de Node.js."

    command -v node >/dev/null 2>&1 \
        || error "Node.js introuvable après installation."

    success "Node.js $(node --version) installé"
fi

# ── Vérification Node.js / npm ───────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
    error "Node.js n'a pas pu être installé."
fi

if ! command -v npm >/dev/null 2>&1; then
    error "npm n'a pas pu être installé."
fi

# ═══════════════════════════════════════════════════════════════════
# STEP 3 — PM2
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 3/6 — Installation de PM2..."

if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 --loglevel=error
    success "PM2 $(pm2 --version) installé"
else
    success "PM2 $(pm2 --version) déjà installé"
fi

pm2 startup systemd -u root --hp /root --silent 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════════
# STEP 4 — Téléchargement de Nexus Bot Manager
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 4/6 — Téléchargement de Nexus Bot Manager..."

TMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "${TMP_DIR}"
}

trap cleanup EXIT

log "Clonage du dépôt GitHub..."

git clone \
    --depth 1 \
    --branch "${REPO_BRANCH}" \
    --single-branch \
    "${REPO_URL}" \
    "${TMP_DIR}/nexus-bot-manager" \
    >/dev/null 2>&1 \
    || error "Impossible de télécharger Nexus Bot Manager."

SOURCE_DIR="${TMP_DIR}/nexus-bot-manager"

if [[ ! -d "${SOURCE_DIR}/backend" ]]; then
    error "Le dépôt téléchargé ne contient pas le dossier backend/."
fi

if [[ ! -d "${SOURCE_DIR}/frontend" ]]; then
    error "Le dépôt téléchargé ne contient pas le dossier frontend/."
fi

success "Dépôt téléchargé et structure vérifiée"

# ── Arrêt ancienne instance ──────────────────────────────────────

if command -v pm2 >/dev/null 2>&1; then
    pm2 delete nexus-bot-manager >/dev/null 2>&1 || true
fi

mkdir -p "${INSTALL_DIR}"

log "Installation dans ${INSTALL_DIR}..."

# ── Sauvegarde .env existant ─────────────────────────────────────

OLD_ENV=""

if [[ -f "${INSTALL_DIR}/backend/.env" ]]; then
    OLD_ENV="$(mktemp)"
    cp "${INSTALL_DIR}/backend/.env" "${OLD_ENV}"
    log "Configuration existante sauvegardée"
fi

# ── Copie des fichiers ───────────────────────────────────────────
# Note : .nexus-version est exclu du rsync pour préserver un éventuel
# fichier existant ; il sera régénéré juste après depuis le package.json
# du code que l'on vient d'installer.

rsync -a \
    --exclude='backend/node_modules' \
    --exclude='backend/data/' \
    --exclude='backend/.env' \
    --exclude='.nexus-version' \
    "${SOURCE_DIR}/" \
    "${INSTALL_DIR}/"

# Restaurer .env existant
if [[ -n "${OLD_ENV}" && -f "${OLD_ENV}" ]]; then
    mkdir -p "${INSTALL_DIR}/backend"
    cp "${OLD_ENV}" "${INSTALL_DIR}/backend/.env"
    rm -f "${OLD_ENV}"
fi

success "Fichiers installés dans ${INSTALL_DIR}"

# ═══════════════════════════════════════════════════════════════════
# STEP 5 — Installation et configuration
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 5/6 — Installation et configuration..."

# ── Backend ──────────────────────────────────────────────────────

if [[ ! -f "${INSTALL_DIR}/backend/package.json" ]]; then
    error "backend/package.json est introuvable."
fi

cd "${INSTALL_DIR}/backend"

log "Installation des dépendances npm..."

npm install --omit=dev --loglevel=error

success "Dépendances npm installées"

# ── Environment ─────────────────────────────────────────────────

ENV_FILE="${INSTALL_DIR}/backend/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
    log "Génération de la configuration..."

    JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")"

    cat > "${ENV_FILE}" <<EOF
# Nexus Bot Manager — Configuration
# Généré automatiquement le $(date '+%Y-%m-%d %H:%M:%S')
# NE PAS COMMITER CE FICHIER

PORT=${PORT}
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=24h
BOTS_ROOT=${BOTS_ROOT}
INSTANCE_NAME=Nexus Bot Manager
EOF

    chmod 600 "${ENV_FILE}"

    success "Configuration générée"
else
    success "Configuration existante conservée"
fi

# ── Data directory ───────────────────────────────────────────────

mkdir -p "${INSTALL_DIR}/backend/data"
chmod 700 "${INSTALL_DIR}/backend/data"

# ── .nexus-version (source de vérité de la version installée) ────────
# Lecture dynamique depuis le package.json du code installé :
# aucune valeur n'est codée en dur, ce qui fonctionne pour toutes
# les versions futures (v1.3.0, v2.0.0, …) sans modifier ce script.
INSTALLED_VERSION="$(node -e "console.log(require('${INSTALL_DIR}/backend/package.json').version)" 2>/dev/null || echo "0.0.0")"
printf 'v%s\n' "${INSTALLED_VERSION}" > "${INSTALL_DIR}/.nexus-version"
chmod 644 "${INSTALL_DIR}/.nexus-version"
log "Version installée enregistrée : v${INSTALLED_VERSION}"

# ── Permissions ──────────────────────────────────────────────────

chown -R root:root "${INSTALL_DIR}"

# ═══════════════════════════════════════════════════════════════════
# STEP 6 — Démarrage via PM2
# ═══════════════════════════════════════════════════════════════════

echo ""
log "Étape 6/6 — Démarrage de Nexus Bot Manager..."

if [[ ! -f "${INSTALL_DIR}/backend/src/server.js" ]]; then
    error "backend/src/server.js est introuvable."
fi

cd "${INSTALL_DIR}/backend"

PATH="$PATH:/usr/local/bin" pm2 start "${INSTALL_DIR}/backend/src/server.js" \
    --name nexus-bot-manager \
    --cwd "${INSTALL_DIR}/backend" \
    --env production \
    --max-restarts 5 \
    --restart-delay 3000 \
    >/dev/null 2>&1 \
    || error "Échec du démarrage via PM2."

pm2 save --force >/dev/null 2>&1 || true

success "Nexus Bot Manager démarré"

# ── Firewall ─────────────────────────────────────────────────────

if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
        log "Port ${PORT}/tcp autorisé dans UFW"
    fi
fi

# ── Network IP ───────────────────────────────────────────────────

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

if [[ -z "${SERVER_IP}" ]]; then
    SERVER_IP="localhost"
fi

# ═══════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════

echo ""

echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║        ✅  Installation terminée avec succès !            ║${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║  Interface web :                                         ║${NC}"
echo -e "${GREEN}║  → ${CYAN}http://${SERVER_IP}:${PORT}${NC}"
echo -e "${GREEN}║  → ${CYAN}http://localhost:${PORT}${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║  Installation : ${CYAN}${INSTALL_DIR}${NC}"
echo -e "${GREEN}║  Version      : ${CYAN}v${INSTALLED_VERSION}${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║  Commandes utiles :                                      ║${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║    ${CYAN}pm2 status${NC}"
echo -e "${GREEN}║    ${CYAN}pm2 logs nexus-bot-manager${NC}"
echo -e "${GREEN}║    ${CYAN}pm2 restart nexus-bot-manager${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"

echo ""