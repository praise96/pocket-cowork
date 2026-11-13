#!/usr/bin/env bash
# ==============================================================================
# Pocket Cowork — Standalone Android (Termux) Runner
# Runs the full AI Web IDE and Agent Studio locally on your phone without a PC.
# ==============================================================================

set -e

# Terminal Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}📱 Pocket Cowork — Mobile Agent Studio (Android/Termux)${NC}"
echo -e "${CYAN}======================================================${NC}"

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] Node.js is not installed in Termux!${NC}"
    echo -e "${YELLOW}Please install it by running:${NC}"
    echo "  pkg update && pkg install nodejs-lts git python"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}✓ Node.js detected:${NC} $NODE_VERSION"

# 2. Acquire Termux Wake-Lock (prevents Android from sleeping the server)
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    echo -e "${GREEN}✓ Termux wake-lock acquired${NC} (server stays active in background)"
fi

# 3. Setup .env file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${YELLOW}✓ Created .env from .env.example${NC}"
        echo -e "${YELLOW}  (You can set your AGENTROUTER_API_KEY in .env or via the UI)${NC}"
    else
        cat <<EOF > .env
PORT=3300
HOST=127.0.0.1
AGENTROUTER_API_KEY=
EOF
        echo -e "${YELLOW}✓ Created default .env file${NC}"
    fi
fi

# Ensure HOST is set for mobile local access
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3300}"

echo -e "\n${GREEN}🚀 Starting Pocket Cowork server on http://${HOST}:${PORT}${NC}"
echo -e "${CYAN}👉 Open your browser on your phone and go to:${NC}"
echo -e "${CYAN}   http://localhost:${PORT}${NC}\n"

# Optional: auto-open in default Android browser
if command -v termux-open-url >/dev/null 2>&1; then
    (sleep 1 && termux-open-url "http://localhost:${PORT}") &
fi

exec node serve_chat.js

