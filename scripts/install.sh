#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Nexus Bot Manager — Script d'installation
# Compatible : Debian 11/12, Ubuntu 22.04/24.04
# Usage      : sudo bash install.sh
# ═══════════════════════════════════════════════════════════════════
set -e

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'
YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()     { echo -e "${BLUE}[Nexus]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────
echo -e "${BLUE}"
echo '╔═══════════════════════════════════════════════════╗'
echo '║         Nexus Bot Manager — Installateur          ║'
echo '║         Discord Bot Manager for Proxmox LXC       ║'
echo '╚═══════════════════════════════════════════════════╝'
echo -e "${NC}"

# ── Root check ────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Ce script doit être exécuté en tant que root (sudo bash install.sh)"
fi

# ── Variables ─────────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
PORT="${PORT:-3001}"
BOTS_ROOT="${BOTS_ROOT:-/opt}"
NODE_MIN_VERSION=18

# ════════════════════════════════════════════════════════════════════
# STEP 1 — Dépendances système
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 1/6 — Mise à jour des paquets système..."
apt-get update -qq 2>/dev/null || warn "apt-get update a rencontré des avertissements"
apt-get install -y -qq curl wget git build-essential python3 ca-certificates gnupg 2>/dev/null
success "Dépendances système installées"

# ════════════════════════════════════════════════════════════════════
# STEP 2 — Node.js
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 2/6 — Vérification de Node.js..."

NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node --version | grep -oP '(?<=v)\d+')
  if [[ $NODE_VER -ge $NODE_MIN_VERSION ]]; then
    success "Node.js $(node --version) déjà installé"
    NODE_OK=true
  fi
fi

if [[ $NODE_OK == false ]]; then
  log "Installation de Node.js 20 LTS..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
    apt-get install -y nodejs 2>/dev/null
  else
    error "Gestionnaire de paquets non supporté. Installez Node.js 20 manuellement."
  fi
  success "Node.js $(node --version) installé"
fi

# ════════════════════════════════════════════════════════════════════
# STEP 3 — PM2
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 3/6 — Installation de PM2..."

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --loglevel=error
  success "PM2 installé"
else
  success "PM2 $(pm2 --version) déjà installé"
fi

# Configure PM2 startup
pm2 startup systemd -u root --hp /root --silent 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════
# STEP 4 — Copie des fichiers
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 4/6 — Installation de Nexus Bot Manager..."

# Get script directory (handle both direct run and curl | bash)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo ".")"

mkdir -p "$INSTALL_DIR"

# Copy project files
if [[ -d "$SCRIPT_DIR/backend" ]] && [[ -d "$SCRIPT_DIR/frontend" ]]; then
  cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"
  log "Fichiers copiés depuis $SCRIPT_DIR"
else
  warn "Répertoire source incomplet. Assurez-vous d'extraire l'archive complète."
fi

# Install npm dependencies
log "Installation des dépendances npm..."
cd "$INSTALL_DIR/backend"
npm install --production --loglevel=error
success "Dépendances installées"

# ════════════════════════════════════════════════════════════════════
# STEP 5 — Configuration
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 5/6 — Configuration..."

ENV_FILE="$INSTALL_DIR/backend/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  # Generate cryptographically secure secret
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")

  cat > "$ENV_FILE" << ENVEOF
# Nexus Bot Manager — Configuration
# Généré automatiquement le $(date '+%Y-%m-%d %H:%M:%S')
# NE PAS COMMITER CE FICHIER

PORT=${PORT}
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=24h
BOTS_ROOT=${BOTS_ROOT}
INSTANCE_NAME=Nexus Bot Manager
ENVEOF

  success "Fichier .env généré avec un secret sécurisé"
else
  success "Fichier .env existant conservé"
fi

# Create data directory
mkdir -p "$INSTALL_DIR/backend/data"
chmod 700 "$INSTALL_DIR/backend/data"

# ════════════════════════════════════════════════════════════════════
# STEP 6 — Démarrage via PM2
# ════════════════════════════════════════════════════════════════════
echo ""
log "Étape 6/6 — Démarrage du service..."

cd "$INSTALL_DIR"

# Stop old instance if running
pm2 delete nexus-bot-manager 2>/dev/null || true

# Start
PATH=$PATH:/usr/local/bin pm2 start backend/src/server.js \
  --name nexus-bot-manager \
  --cwd backend \
  --env production \
  --max-restarts 5 \
  --restart-delay 3000 \
  2>/dev/null

pm2 save --force 2>/dev/null || true

success "Nexus Bot Manager démarré"

# ── Firewall (optional) ───────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" &>/dev/null && log "Port $PORT ouvert dans ufw"
fi

# ── Get network IP ────────────────────────────────────────────────
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

# ════════════════════════════════════════════════════════════════════
# DONE
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      ✅  Installation terminée avec succès !           ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Interface web → ${CYAN}http://${SERVER_IP}:${PORT}${NC}"
echo -e "${GREEN}║${NC}                  ${CYAN}http://localhost:${PORT}${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Ouvrez l'URL dans votre navigateur pour configurer  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  votre instance (assistant de configuration intégré). ${GREEN}║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Commandes PM2 utiles :                               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    pm2 status                → état du service        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    pm2 logs nexus-bot-manager → logs en direct        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    pm2 restart nexus-bot-manager → redémarrer         ${GREEN}║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
