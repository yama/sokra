#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "${SCRIPT_DIR}/install-skills.sh"
bash "${SCRIPT_DIR}/sync-claude-skills.sh"
bash "${SCRIPT_DIR}/sync-copilot-prompts.sh"

echo "Synced shared skills for Codex, Claude, and Copilot"
