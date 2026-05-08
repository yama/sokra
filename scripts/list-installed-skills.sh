#!/usr/bin/env bash

set -euo pipefail

TARGET_DIR="${CODEX_HOME:-$HOME/.codex}/skills/sokra"

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "No Sokra skills installed at ${TARGET_DIR}" >&2
  exit 1
fi

find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -type d | sort
