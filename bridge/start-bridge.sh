#!/usr/bin/env sh
# Прокси: ./start-bridge.sh --proxy socks5://user:pass@host:1080
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Нужен Node.js 18 или новее: https://nodejs.org"; exit 1; }
exec node tubecomment-bridge.mjs "$@"
