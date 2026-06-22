#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8081}"

cd "$ROOT_DIR"

"$ROOT_DIR/run-portfolio.command" "$PORT"
