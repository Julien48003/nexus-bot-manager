#!/usr/bin/env bash
# -------------------------------------------------------------------
# Nexus Bot Manager — Script d'installation
# Compatible : Debian 11/12/13, Ubuntu 22.04/24.04
#
# Usage      : clone a pinned release tag, verify its commit SHA, then
#              run it. Do NOT pipe this script from a branch into a
#              shell: `curl …/main/scripts/install.sh | bash` executes
#              whatever the floating `main` branch happens to contain,
#              as root, with no integrity check. See README.md.
#
#   VERSION=<version>
#   COMMIT=<40-hex from the release notes>
#   git clone --depth 1 --branch "v${VERSION}" \
#     https://github.com/Julien48003/nexus-bot-manager.git /tmp/nexus-install
#   cd /tmp/nexus-install
#   test "$(git rev-parse HEAD)" = "${COMMIT}" || exit 1
#   sudo env VERSION="${VERSION}" NEXUS_COMMIT_SHA="${COMMIT}" bash scripts/install.sh
#
# Optional: NEXUS_COMMIT_SHA=<40-hex> pins the exact Git commit published
# in the release notes; the installer refuses a tag that points elsewhere.
# Without VERSION, the latest GitHub Release is installed.
# -------------------------------------------------------------------

set -euo pipefail

# UPD-19 — no file this script creates may be world-readable: the .env it
# generates holds the JWT signing key, and the database holds bcrypt hashes.
umask 077

# -- Colors --------------------------------------------------------
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
    echo -e "${GREEN}[OK]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $*"
}

error() {
    echo -e "${RED}[ERREUR]${NC} $*"
    exit 1
}

# -- Configuration ------------------------------------------------
REPO_URL="https://github.com/Julien48003/nexus-bot-manager.git"
# Public install: latest release by default, or an explicit VERSION/NEXUS_VERSION.
# The installed version comes from backend/package.json (single source of truth).
# For dev workflows, use scripts/dev-install.sh instead.
REPO_BRANCH=""

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
PORT="${PORT:-3001}"
BOTS_ROOT="${BOTS_ROOT:-/opt}"
INSTALL_DIR="${INSTALL_DIR%/}"
BOTS_ROOT="${BOTS_ROOT%/}"

REQUESTED_VERSION="${NEXUS_VERSION:-${VERSION:-}}"
if [[ -n "${REQUESTED_VERSION}" ]]; then
    REQUESTED_VERSION="${REQUESTED_VERSION#v}"
    [[ "${REQUESTED_VERSION}" =~ ^[0-9]+(\.[0-9]+){1,2}([-+][0-9A-Za-z.-]+)?$ ]] \
        || error "Version invalide : ${REQUESTED_VERSION}"
fi

NODE_MIN_VERSION=20
# Pinned Node.js LTS tarball, verified with the SHA-256 published by nodejs.org.
NODE_INSTALL_VERSION="24.22.3"
NODE_SHA256_X64="061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2"
NODE_SHA256_ARM64="261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8"
# Keep in sync with backend/package-lock.json (node_modules/pm2).
PM2_VERSION="7.1.2"

CURL_OPTS=(-fsSL --retry 3 --proto '=https' --tlsv1.2)

# Never let an inherited or mistyped path turn this installer into an
# arbitrary write target.
case "${INSTALL_DIR}" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
        error "INSTALL_DIR non sûr : ${INSTALL_DIR}" ;;
esac
if [[ "${INSTALL_DIR}" != /* ]] || [[ "${INSTALL_DIR}" == *"/.."* ]]; then
    error "INSTALL_DIR doit être un chemin absolu sans '..' (reçu : ${INSTALL_DIR})"
fi
if [[ "${BOTS_ROOT}" != /* ]] || [[ "${BOTS_ROOT}" == *"/.."* ]]; then
    error "BOTS_ROOT doit être un chemin absolu sans '..' (reçu : ${BOTS_ROOT})"
fi
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    error "PORT invalide : ${PORT}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

install_node_verified() {
    local arch sha name tarball dest
    case "${ARCH}" in
        amd64|x86_64) arch="x64";   sha="${NODE_SHA256_X64}" ;;
        arm64|aarch64) arch="arm64"; sha="${NODE_SHA256_ARM64}" ;;
        *) error "Architecture non supportée pour Node.js : ${ARCH}" ;;
    esac

    name="node-v${NODE_INSTALL_VERSION}-linux-${arch}"
    tarball="${TMP_DIR}/${name}.tar.gz"
    dest="/usr/local/lib/nodejs"

    log "Téléchargement de Node.js v${NODE_INSTALL_VERSION} (${arch})..."
    curl "${CURL_OPTS[@]}" -o "${tarball}" \
        "https://nodejs.org/dist/v${NODE_INSTALL_VERSION}/${name}.tar.gz" \
        || error "Téléchargement de Node.js échoué"

    printf '%s  %s\n' "${sha}" "${tarball}" | sha256sum -c - >/dev/null 2>&1 \
        || error "ÉCHEC D'INTÉGRITÉ Node.js (SHA-256)"

    mkdir -p "${dest}"
    tar -xzf "${tarball}" -C "${dest}" \
        || error "Extraction de Node.js échouée"

    local bin
    for bin in node npm npx corepack; do
        if [[ -e "${dest}/${name}/bin/${bin}" ]]; then
            ln -sfn "${dest}/${name}/bin/${bin}" "/usr/local/bin/${bin}"
        fi
    done
    export PATH="/usr/local/bin:${PATH}"
    hash -r
    command -v node >/dev/null 2>&1 || error "Node.js introuvable après installation"
    command -v npm  >/dev/null 2>&1 || error "npm introuvable après installation"
}

# -- Banner --------------------------------------------------------
echo -e "${BLUE}"
echo '-----------------------------------------------------'
echo '-         Nexus Bot Manager — Installateur          -'
echo '-         Discord Bot Manager for Proxmox LXC       -'
echo '-----------------------------------------------------'
echo -e "${NC}"

# -- Root check ---------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    error "Ce script doit être exécuté en tant que root."
fi

# -- Architecture -------------------------------------------------
ARCH="$(dpkg --print-architecture 2>/dev/null || echo "unknown")"

log "Architecture détectée : ${ARCH}"

# -------------------------------------------------------------------
# STEP 1 — Dépendances système
# -------------------------------------------------------------------

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

# -------------------------------------------------------------------
# STEP 2 — Node.js
# -------------------------------------------------------------------

echo ""
log "Étape 2/6 — Vérification de Node.js..."

NODE_OK=false

if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node --version | sed 's/^v//' | cut -d. -f1)"

    if [[ "${NODE_VER}" -ge "${NODE_MIN_VERSION}" ]]; then
        success "Node.js $(node --version) déjà installé"
        if [[ "${NODE_VER}" -lt 22 ]]; then
            warn "Node.js ${NODE_VER} est en fin de vie (EOL). Node.js 22/24 est recommandé."
        fi
        NODE_OK=true
    else
        warn "Node.js $(node --version) est trop ancien"
    fi
fi

if [[ "${NODE_OK}" == false ]]; then
    log "Installation de Node.js v${NODE_INSTALL_VERSION} (archive officielle vérifiée)..."
    install_node_verified
    success "Node.js $(node --version) installé"
fi

# -- Vérification Node.js / npm -----------------------------------

if ! command -v node >/dev/null 2>&1; then
    error "Node.js n'a pas pu être installé."
fi

if ! command -v npm >/dev/null 2>&1; then
    error "npm n'a pas pu être installé."
fi

# -------------------------------------------------------------------
# STEP 3 — PM2
# -------------------------------------------------------------------

echo ""
log "Étape 3/6 — Installation de PM2..."

if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g "pm2@${PM2_VERSION}" --loglevel=error --ignore-scripts
    success "PM2 $(pm2 --version) installé"
else
    GLOBAL_PM2="$(pm2 --version 2>/dev/null || true)"
    if [[ "${GLOBAL_PM2}" != "${PM2_VERSION}" ]]; then
        error "PM2 global ${GLOBAL_PM2} incompatible avec la version attendue ${PM2_VERSION}. Alignez PM2 et redémarrez son daemon avant l'installation (docs/SECURITY-PRODUCTION.md, section 2.7)."
    fi
    success "PM2 $(pm2 --version) déjà installé"
fi

pm2 startup systemd -u root --hp /root --silent 2>/dev/null || true

# -------------------------------------------------------------------
# STEP 4 — Téléchargement de Nexus Bot Manager
# -------------------------------------------------------------------

echo ""
log "Étape 4/6 — Téléchargement de Nexus Bot Manager..."

log "Clonage du dépôt GitHub..."

# Public install policy: latest release by default, or an explicit
# VERSION/NEXUS_VERSION. The tag is resolved to a commit and verified after
# clone, so a moved tag cannot silently install different code.
RELEASE_TAG=""
RELEASE_JSON=""

if [[ -n "${REQUESTED_VERSION}" ]]; then
    log "Version demandée : v${REQUESTED_VERSION}"
    for candidate in "v${REQUESTED_VERSION}" "${REQUESTED_VERSION}"; do
        RELEASE_JSON="$(curl "${CURL_OPTS[@]}" \
            -H 'Accept: application/vnd.github+json' \
            -H 'User-Agent: Nexus-Bot-Manager-Installer' \
            "https://api.github.com/repos/Julien48003/nexus-bot-manager/releases/tags/${candidate}" \
            2>/dev/null || true)"
        RELEASE_TAG="$(printf '%s' "${RELEASE_JSON}" \
            | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | head -n1 \
            | sed -E 's/.*"([^"]+)"$/\1/' || true)"
        if [[ -n "${RELEASE_TAG}" ]]; then break; fi
    done
else
    log "Récupération de la dernière release GitHub..."
    RELEASE_JSON="$(curl "${CURL_OPTS[@]}" \
        -H 'Accept: application/vnd.github+json' \
        -H 'User-Agent: Nexus-Bot-Manager-Installer' \
        "https://api.github.com/repos/Julien48003/nexus-bot-manager/releases/latest" \
        2>/dev/null || true)"
    RELEASE_TAG="$(printf '%s' "${RELEASE_JSON}" \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | head -n1 \
        | sed -E 's/.*"([^"]+)"$/\1/' || true)"
fi

if [[ -z "${RELEASE_TAG}" ]]; then
    error "Aucune release GitHub trouvée pour la version demandée. Pour un workflow dev, utilisez scripts/dev-install.sh <ref>."
fi
if [[ ! "${RELEASE_TAG}" =~ ^v?[0-9A-Za-z._-]+$ ]] || [[ "${RELEASE_TAG}" == -* ]]; then
    error "Tag de release invalide : ${RELEASE_TAG}"
fi

INSTALLED_VERSION="${RELEASE_TAG#v}"
if [[ -n "${REQUESTED_VERSION}" && "${INSTALLED_VERSION}" != "${REQUESTED_VERSION}" ]]; then
    error "La release ${RELEASE_TAG} ne correspond pas à la version demandée ${REQUESTED_VERSION}."
fi
GIT_REF="${RELEASE_TAG}"
log "Release sélectionnée : ${RELEASE_TAG}"

# Optional external anchor: pass the full commit SHA from the release notes
# (NEXUS_COMMIT_SHA=...). Otherwise resolve the tag to its peeled commit and
# compare it after cloning.
EXPECTED_COMMIT="${NEXUS_COMMIT_SHA:-}"
if [[ -n "${EXPECTED_COMMIT}" ]]; then
    [[ "${EXPECTED_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]] \
        || error "NEXUS_COMMIT_SHA doit être un SHA Git complet (40 caractères hexadécimaux)."
else
    EXPECTED_COMMIT="$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO_URL}" "refs/tags/${GIT_REF}^{}" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    if [[ -z "${EXPECTED_COMMIT}" ]]; then
        EXPECTED_COMMIT="$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO_URL}" "refs/tags/${GIT_REF}" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    fi
fi
[[ -n "${EXPECTED_COMMIT}" ]] || error "Tag ${GIT_REF} introuvable sur le dépôt distant."
log "Commit attendu : ${EXPECTED_COMMIT}"

GIT_TERMINAL_PROMPT=0 git clone \
    --depth 1 \
    --branch "${GIT_REF}" \
    --single-branch \
    "${REPO_URL}" \
    "${TMP_DIR}/nexus-bot-manager" \
    >/dev/null 2>&1 \
    || error "Impossible de télécharger Nexus Bot Manager (ref=${GIT_REF})."

SOURCE_DIR="${TMP_DIR}/nexus-bot-manager"

if [[ ! -d "${SOURCE_DIR}/backend" ]]; then
    error "Le dépôt téléchargé ne contient pas le dossier backend/."
fi
if [[ ! -d "${SOURCE_DIR}/frontend" ]]; then
    error "Le dépôt téléchargé ne contient pas le dossier frontend/."
fi

ACTUAL_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse HEAD 2>/dev/null || true)"
if [[ "${ACTUAL_COMMIT}" != "${EXPECTED_COMMIT}" ]]; then
    error "Intégrité du tag violée : ${GIT_REF} pointe vers ${ACTUAL_COMMIT}, attendu ${EXPECTED_COMMIT}."
fi

PKG_VERSION="$(node -p "require('${SOURCE_DIR}/backend/package.json').version" 2>/dev/null || true)"
if [[ "${INSTALLED_VERSION}" != "${PKG_VERSION}" ]]; then
    error "Version incohérente : tag ${RELEASE_TAG}, backend/package.json ${PKG_VERSION}."
fi

success "Dépôt téléchargé, tag et commit vérifiés (${INSTALLED_VERSION})"

# -- Arrêt ancienne instance --------------------------------------

if command -v pm2 >/dev/null 2>&1; then
    pm2 delete nexus-bot-manager >/dev/null 2>&1 || true
fi

mkdir -p "${INSTALL_DIR}"

log "Installation dans ${INSTALL_DIR}..."

# -- Sauvegarde .env existant -------------------------------------

OLD_ENV=""

if [[ -f "${INSTALL_DIR}/backend/.env" ]]; then
    OLD_ENV="$(mktemp)"
    cp "${INSTALL_DIR}/backend/.env" "${OLD_ENV}"
    log "Configuration existante sauvegardée"
fi

# -- Copie des fichiers -------------------------------------------
# Preserve .env, data/ and node_modules/ from the existing install.
# The version of the installed code comes from the backend/package.json
# we just cloned from the GitHub Release tag (single source of truth).

rsync -a --safe-links \
    --exclude='backend/node_modules' \
    --exclude='backend/data/' \
    --exclude='backend/.env' \
    "${SOURCE_DIR}/" \
    "${INSTALL_DIR}/"

# Restaurer .env existant
if [[ -n "${OLD_ENV}" && -f "${OLD_ENV}" ]]; then
    mkdir -p "${INSTALL_DIR}/backend"
    cp "${OLD_ENV}" "${INSTALL_DIR}/backend/.env"
    rm -f "${OLD_ENV}"
fi

success "Fichiers installés dans ${INSTALL_DIR}"

# -------------------------------------------------------------------
# STEP 5 — Installation et configuration
# -------------------------------------------------------------------

echo ""
log "Étape 5/6 — Installation et configuration..."

# -- Backend ------------------------------------------------------

if [[ ! -f "${INSTALL_DIR}/backend/package.json" ]]; then
    error "backend/package.json est introuvable."
fi

cd "${INSTALL_DIR}/backend"

log "Installation des dépendances npm..."

# UPD-07 — `npm ci` installs exactly what package-lock.json pins; the
# fallback keeps the installer working if the lockfile is out of sync.
if [[ -f package-lock.json ]] && npm ci --omit=dev --loglevel=error --ignore-scripts 2>/dev/null; then
  success "Dépendances npm installées (npm ci, lockfile respecté)"
else
  warn "npm ci impossible — repli sur npm install"
  npm install --omit=dev --loglevel=error --ignore-scripts
  success "Dépendances npm installées"
fi

# -- Environment -------------------------------------------------

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

# -- Data directory -----------------------------------------------

mkdir -p "${INSTALL_DIR}/backend/data"
chmod 700 "${INSTALL_DIR}/backend/data"

# -- Version handling -----------------------------------------------
# The single source of truth for the installed version is
#   <INSTALL_DIR>/backend/package.json
# which was cloned verbatim from the GitHub Release tag (RELEASE_TAG).
# No .nexus-version file is written: the backend reads package.json
# directly. This guarantees consistency between the installed code and
# the version reported in the UI.
INSTALLED_VERSION="${RELEASE_TAG#v}"
log "Version installée (lu depuis package.json) : v${INSTALLED_VERSION}"

# -- Permissions --------------------------------------------------

chown -R root:root "${INSTALL_DIR}"

# -------------------------------------------------------------------
# STEP 6 — Démarrage via PM2
# -------------------------------------------------------------------

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

# -- Firewall -----------------------------------------------------

if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
        log "Port ${PORT}/tcp autorisé dans UFW"
    fi
fi

# -- Network IP ---------------------------------------------------

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

if [[ -z "${SERVER_IP}" ]]; then
    SERVER_IP="localhost"
fi

# -------------------------------------------------------------------
# DONE
# -------------------------------------------------------------------

echo ""

echo -e "${GREEN}-------------------------------------------------------------${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-        [OK]  Installation terminée avec succès !          -${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-------------------------------------------------------------${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-  Interface web :                                          -${NC}"
echo -e "${GREEN}-  -> ${CYAN}http://${SERVER_IP}:${PORT}${NC}"
echo -e "${GREEN}-  -> ${CYAN}http://localhost:${PORT}${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-------------------------------------------------------------${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-  Installation : ${CYAN}${INSTALL_DIR}${NC}"
echo -e "${GREEN}-  Version      : ${CYAN}v${INSTALLED_VERSION} ${YELLOW}(release ${RELEASE_TAG})${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-  Commandes utiles :                                       -${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-    ${CYAN}pm2 status${NC}"
echo -e "${GREEN}-    ${CYAN}pm2 logs nexus-bot-manager${NC}"
echo -e "${GREEN}-    ${CYAN}pm2 restart nexus-bot-manager${NC}"
echo -e "${GREEN}-                                                           -${NC}"
echo -e "${GREEN}-------------------------------------------------------------${NC}"

echo ""
