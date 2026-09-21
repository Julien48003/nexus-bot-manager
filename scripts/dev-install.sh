#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Nexus Bot Manager — Developper install script
#
# ⚠️  CE SCRIPT EST RÉSERVÉ AUX DÉVELOPPEURS / MAINTENEURS.
#
# Usage:
#     bash scripts/dev-install.sh <ref>
#
# <ref> can be:
#     - a commit SHA (full or short)         e.g. 97b0037
#     - a branch name                        e.g. main, feature/foo
#     - an existing release tag              e.g. v1.2.0
#
# The installed version file (.nexus-version) uses a special prefix
# when the ref is NOT an official GitHub Release tag:
#     dev-<short-sha>   for commits / branches
# This makes it crystal-clear in the UI that the running build is NOT
# an official release and should not be compared 1:1 to the published
# version in the Logiciel → "Latest version" panel.
#
# For public installations, use scripts/install.sh instead — it
# always installs the latest GitHub Release and writes the official
# tag into .nexus-version.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()     { echo -e "${BLUE}[Nexus-dev]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

REPO_URL="https://github.com/Julien48003/nexus-bot-manager.git"

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
PORT="${PORT:-3001}"
BOTS_ROOT="${BOTS_ROOT:-/opt}"
NODE_MIN_VERSION=20

REF="${1:-}"
if [[ -z "${REF}" ]]; then
    error "Usage : bash scripts/dev-install.sh <commit|branch|tag>"
fi

echo -e "${YELLOW}"
echo '╔═══════════════════════════════════════════════════╗'
echo '║   Nexus Bot Manager — Installateur développeur    ║'
echo '║   ⚠️  Réservé au développement / aux tests         ║'
echo '╚═══════════════════════════════════════════════════╝'
echo -e "${NC}"

if [[ "${EUID}" -ne 0 ]]; then
    error "Ce script doit être exécuté en tant que root."
fi

ARCH="$(dpkg --print-architecture 2>/dev/null || echo "unknown")"
log "Architecture détectée : ${ARCH}"

# ═══════════════════════════════════════════════════════════════════
# STEP 1 — Dépendances système
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 1/6 — Dépendances système..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl wget git rsync build-essential python3 ca-certificates gnupg
success "Dépendances système installées"

# ═══════════════════════════════════════════════════════════════════
# STEP 2 — Node.js
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 2/6 — Node.js..."
NODE_OK=false
if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node --version | sed 's/^v//' | cut -d. -f1)"
    if [[ -n "$NODE_VER" && "$NODE_VER" -ge "$NODE_MIN_VERSION" ]]; then
        success "Node.js $(node --version) déjà installé"
        NODE_OK=true
    fi
fi
if [[ "${NODE_OK}" == false ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 \
        || error "Échec du dépôt NodeSource"
    apt-get install -y nodejs >/dev/null 2>&1 || error "Échec de l'installation de Node.js"
    success "Node.js $(node --version) installé"
fi

# ═══════════════════════════════════════════════════════════════════
# STEP 3 — PM2
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 3/6 — PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 --loglevel=error
    success "PM2 $(pm2 --version) installé"
else
    success "PM2 $(pm2 --version) déjà installé"
fi
pm2 startup systemd -u root --hp /root --silent 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════════
# STEP 4 — Téléchargement de la référence demandée
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 4/6 — Téléchargement de la référence : ${REF}"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

# Use git's own ref resolution:
#   - if REF looks like a SHA (hex), clone then resolve-verify to a full SHA
#   - otherwise, use --branch
CLONE_BRANCH=""
if [[ "${REF}" =~ ^[0-9a-fA-F]{4,40}$ ]]; then
    log "SHA détecté — clonage complet puis checkout ${REF}…"
    git clone "${REPO_URL}" "${TMP_DIR}/nexus-bot-manager" >/dev/null 2>&1 \
        || error "Impossible de cloner le dépôt"
    (cd "${TMP_DIR}/nexus-bot-manager" && git checkout "${REF}" >/dev/null 2>&1) \
        || error "Référence '${REF}' introuvable"
else
    log "Branche/tag '${REF}' — clonage shallow…"
    git clone --depth 1 --branch "${REF}" --single-branch "${REPO_URL}" "${TMP_DIR}/nexus-bot-manager" >/dev/null 2>&1 \
        || error "Branche/tag '${REF}' introuvable"
fi

SOURCE_DIR="${TMP_DIR}/nexus-bot-manager"

if [[ ! -d "${SOURCE_DIR}/backend" ]] || [[ ! -d "${SOURCE_DIR}/frontend" ]]; then
    error "Le dépôt ne contient pas backend/ ou frontend/."
fi

# Resolve the effective full SHA we just installed
RESOLVED_SHA="$(cd "${SOURCE_DIR}" && git rev-parse HEAD)"
SHORT_SHA="${RESOLVED_SHA:0:7}"
log "Code installé : ${RESOLVED_SHA}"
success "Référence récupérée"

# ── Stop existing instance ──────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
    pm2 delete nexus-bot-manager >/dev/null 2>&1 || true
fi
mkdir -p "${INSTALL_DIR}"
log "Installation dans ${INSTALL_DIR}…"

# ── Save existing .env ───────────────────────────────────────────
OLD_ENV=""
if [[ -f "${INSTALL_DIR}/backend/.env" ]]; then
    OLD_ENV="$(mktemp)"
    cp "${INSTALL_DIR}/backend/.env" "${OLD_ENV}"
fi

# ── Copy files (preserve data + .env) ───────────────────────────
rsync -a \
    --exclude='backend/node_modules' \
    --exclude='backend/data/' \
    --exclude='backend/.env' \
    --exclude='.nexus-version' \
    "${SOURCE_DIR}/" \
    "${INSTALL_DIR}/"

if [[ -n "${OLD_ENV}" && -f "${OLD_ENV}" ]]; then
    mkdir -p "${INSTALL_DIR}/backend"
    cp "${OLD_ENV}" "${INSTALL_DIR}/backend/.env"
    rm -f "${OLD_ENV}"
fi
success "Fichiers installés dans ${INSTALL_DIR}"

# ═══════════════════════════════════════════════════════════════════
# STEP 5 — Backend + .nexus-version (dev-aware)
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 5/6 — Backend et fichier de version…"

if [[ ! -f "${INSTALL_DIR}/backend/package.json" ]]; then
    error "backend/package.json est introuvable."
fi

cd "${INSTALL_DIR}/backend"
npm install --omit=dev --loglevel=error || error "npm install échoué"
success "Dépendances npm installées"

ENV_FILE="${INSTALL_DIR}/backend/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
    JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")"
    cat > "${ENV_FILE}" <<EOF
# Nexus Bot Manager — Configuration dev
PORT=${PORT}
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=24h
BOTS_ROOT=${BOTS_ROOT}
INSTANCE_NAME=Nexus Bot Manager (dev)
EOF
    chmod 600 "${ENV_FILE}"
    success "Configuration dev générée"
fi

mkdir -p "${INSTALL_DIR}/backend/data"
chmod 700 "${INSTALL_DIR}/backend/data"

# ── .nexus-version (DEV-aware) ──────────────────────────────────
# Decide the version label based on what we installed:
#   - If the ref is exactly an existing GitHub Release tag, write the
#     official version (so it stays comparable to public releases).
#   - Otherwise, write dev-<short-sha> so the UI clearly flags this
#     build as a development snapshot.
PUBLISHED_TAGS="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: Nexus-Bot-Manager-DevInstaller' \
    "https://api.github.com/repos/Julien48003/nexus-bot-manager/git/refs/tags/${REF#v}" \
    2>/dev/null || true)"

LABEL="${REF#v}"
if [[ "${REF}" == v* ]] && echo "${PUBLISHED_TAGS}" | grep -q "${REF}"; then
    log "Référence correspondant à une release officielle : ${REF}"
    FINAL_TAG="${REF}"
else
    FINAL_TAG="dev-${SHORT_SHA}"
    log "Build de développement — étiquette : ${FINAL_TAG}"
fi

printf '%s\n' "${FINAL_TAG}" > "${INSTALL_DIR}/.nexus-version"
chmod 644 "${INSTALL_DIR}/.nexus-version"
log "Version installée enregistrée : ${FINAL_TAG}"

chown -R root:root "${INSTALL_DIR}"

# ═══════════════════════════════════════════════════════════════════
# STEP 6 — Démarrage
# ═══════════════════════════════════════════════════════════════════
echo ""
log "Étape 6/6 — Démarrage de Nexus Bot Manager (dev)…"

PATH="$PATH:/usr/local/bin" pm2 start "${INSTALL_DIR}/backend/src/server.js" \
    --name nexus-bot-manager \
    --cwd "${INSTALL_DIR}/backend" \
    --env production \
    --max-restarts 5 \
    --restart-delay 3000 \
    >/dev/null 2>&1 || error "Échec du démarrage PM2"
pm2 save --force >/dev/null 2>&1 || true
success "Nexus Bot Manager démarré (build dev)"

# ── Firewall ─────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
    fi
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "${SERVER_IP}" ]] && SERVER_IP="localhost"

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        ✅  Build dev installé avec succès !              ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Interface : ${CYAN}http://${SERVER_IP}:${PORT}${NC}"
echo -e "${GREEN}║  Réf       : ${CYAN}${REF}${NC}"
echo -e "${GREEN}║  Commit    : ${CYAN}${SHORT_SHA}${NC}"
echo -e "${GREEN}║  Étiquette : ${CYAN}${FINAL_TAG}${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
warn "Rappel : ce build est un SNAPSHOT DEV — ne pas le présenter comme release officielle."
echo ""