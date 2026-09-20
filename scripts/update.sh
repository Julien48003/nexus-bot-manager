#!/usr/bin/env bash
# Nexus Bot Manager — Script de mise à jour
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[Nexus]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Exécutez en tant que root"

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}"
echo '╔═══════════════════════════════════════════╗'
echo '║   Nexus Bot Manager — Mise à jour        ║'
echo '╚═══════════════════════════════════════════╝'
echo -e "${NC}"

[[ ! -d "$INSTALL_DIR" ]] && error "Installation non trouvée dans $INSTALL_DIR"

log "Sauvegarde de la configuration..."
cp "$INSTALL_DIR/backend/.env" "/tmp/nexus-backup-env-$(date +%s)" 2>/dev/null && success ".env sauvegardé"

log "Arrêt du service..."
pm2 stop nexus-bot-manager 2>/dev/null || true

log "Mise à jour des fichiers..."
# Keep .env and data/ intact
rsync -a --exclude='.env' --exclude='data/' --exclude='node_modules/' "$SOURCE_DIR/backend/" "$INSTALL_DIR/backend/"
rsync -a "$SOURCE_DIR/frontend/" "$INSTALL_DIR/frontend/"
rsync -a "$SOURCE_DIR/scripts/" "$INSTALL_DIR/scripts/"
success "Fichiers mis à jour"

log "Mise à jour des dépendances npm..."
cd "$INSTALL_DIR/backend"
npm install --production --loglevel=error
success "Dépendances mises à jour"

log "Redémarrage du service..."
PATH=$PATH:/usr/local/bin pm2 restart nexus-bot-manager 2>/dev/null || \
  PATH=$PATH:/usr/local/bin pm2 start backend/src/server.js --name nexus-bot-manager --cwd backend
pm2 save --force 2>/dev/null || true
success "Service redémarré"

echo ""
echo -e "${GREEN}✅ Mise à jour terminée !${NC}"
pm2 status nexus-bot-manager
