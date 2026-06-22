#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8081}"
URL="http://localhost:${PORT}"

cd "$ROOT_DIR"

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

nohup python3 -m http.server "$PORT" >/tmp/portfolio-tracker-http.log 2>&1 &

for _ in {1..30}; do
  if curl -sf "$URL" >/dev/null 2>&1; then
    open "$URL"
    exit 0
  fi
  sleep 0.25
done

echo "Server did not start correctly. Check /tmp/portfolio-tracker-http.log"
exit 1
