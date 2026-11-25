#!/usr/bin/env bash
# Nexus Bot Manager — Désinstallation
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
error() { echo -e "${RED}[ERREUR]${NC} $*" >&2; exit 1; }
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}[ERREUR]${NC} Exécutez en tant que root"
    exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/nexus-bot-manager}"
INSTALL_DIR="${INSTALL_DIR%/}"

# Safety guard: never let an inherited (or mistyped) INSTALL_DIR turn the
# recursive delete below into `rm -rf /` or `rm -rf /opt`. Only a
# non-empty absolute path with at least two segments is accepted, and the
# directory must actually exist before we touch it.
case "$INSTALL_DIR" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    error "INSTALL_DIR non sûr : $INSTALL_DIR" ;;
esac
if [[ "$INSTALL_DIR" != /* ]] || [[ "$INSTALL_DIR" == *"/.."* ]]; then
  error "INSTALL_DIR doit être un chemin absolu sans '..' (reçu : $INSTALL_DIR)"
fi
if [[ ! -d "$INSTALL_DIR" ]]; then
  error "INSTALL_DIR introuvable : $INSTALL_DIR — rien à désinstaller."
fi
if [[ ! -f "$INSTALL_DIR/backend/package.json" ]]; then
  error "Refus : $INSTALL_DIR ne semble pas être une installation Nexus Bot Manager."
fi

echo -e "${YELLOW}[ATTENTION]  Désinstallation de Nexus Bot Manager${NC}"
echo ""
echo -e "Répertoire qui sera supprimé : ${RED}${INSTALL_DIR}${NC}"
read -rp "Confirmer ? Les bots dans /opt/ ne seront PAS supprimés. (oui/non) : " confirm
if [[ "$confirm" != "oui" ]]; then
    echo "Annulé."
    exit 0
fi

echo -e "${RED}[Nexus]${NC} Arrêt et suppression du service PM2..."
pm2 stop nexus-bot-manager 2>/dev/null || true
pm2 delete nexus-bot-manager 2>/dev/null || true
pm2 save --force 2>/dev/null || true

echo -e "${RED}[Nexus]${NC} Suppression des fichiers..."
# Quoted variable, validated absolute path, and only ever the one directory.
rm -rf -- "$INSTALL_DIR"

echo ""
echo -e "${GREEN}[OK] Nexus Bot Manager désinstallé.${NC}"
echo "Note : Vos bots Discord dans /opt/ sont intacts."
