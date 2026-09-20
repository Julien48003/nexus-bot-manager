#!/usr/bin/env bash
# Nexus Bot Manager — Désinstallation
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
[[ $EUID -ne 0 ]] && echo -e "${RED}[✗]${NC} Exécutez en tant que root" && exit 1

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"

echo -e "${YELLOW}⚠️  Désinstallation de Nexus Bot Manager${NC}"
echo ""
read -rp "Confirmer ? Les bots dans /opt/ ne seront PAS supprimés. (oui/non) : " confirm
[[ "$confirm" != "oui" ]] && echo "Annulé." && exit 0

echo -e "${RED}[Nexus]${NC} Arrêt et suppression du service PM2..."
pm2 stop nexus-bot-manager 2>/dev/null || true
pm2 delete nexus-bot-manager 2>/dev/null || true
pm2 save --force 2>/dev/null || true

echo -e "${RED}[Nexus]${NC} Suppression des fichiers..."
rm -rf "$INSTALL_DIR"

echo ""
echo -e "${GREEN}✅ Nexus Bot Manager désinstallé.${NC}"
echo "Note : Vos bots Discord dans /opt/ sont intacts."
