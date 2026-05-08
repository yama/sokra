#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/.github/prompts"

mkdir -p "${TARGET_DIR}"

for prompt_name in \
  github-workflow \
  commit-message \
  review-workflow \
  ai-doc-review \
  ai-doc-edit \
  pr-create
do
  rm -f "${TARGET_DIR}/${prompt_name}.prompt.md"
done

write_prompt() {
  local filename="$1"
  local description="$2"
  local skill_name="$3"
  local task="$4"

  cat > "${TARGET_DIR}/${filename}.prompt.md" <<EOF
---
agent: 'agent'
description: '${description}'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/${skill_name}/SKILL.md

次の方針で進めてください。

- \`AGENTS.md\` と \`.github/copilot-instructions.md\` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

${task}
EOF
}

write_prompt \
  "github-workflow" \
  "GitHub関連作業の共通フローを使う" \
  "github-workflow" \
  "GitHub 上の対象特定、証拠収集、アクセス手段の選択、結果報告までを整理して実行してください。"

write_prompt \
  "commit-message" \
  "差分からコミットメッセージを作成する" \
  "commit-message" \
  "現在の差分を確認し、日本語の Conventional Commits 形式でコミットメッセージ本文のみを作成してください。"

write_prompt \
  "review-workflow" \
  "コードや設定変更の一般レビューを行う" \
  "review-workflow" \
  "変更差分をレビューし、問題点、退行リスク、変更漏れ、テスト不足を重要度順に整理してください。"

write_prompt \
  "ai-doc-review" \
  "AI向け文書の整合と曖昧さをレビューする" \
  "ai-doc-review" \
  "AI向け文書の変更について、SSOT、参照整合、重複、曖昧表現、更新漏れを優先度順にレビューしてください。"

write_prompt \
  "ai-doc-edit" \
  "AI向け文書の改修と追従更新を行う" \
  "ai-doc-edit" \
  "AI向け文書を改修し、正本、参照先、関連スキルまで含めて整合が取れるように更新してください。"

write_prompt \
  "pr-create" \
  "統一形式でプルリクエスト本文を作成する" \
  "pr-create" \
  "現在の差分とレビュー状況を確認し、統一形式のプルリクエスト本文を作成してください。"

echo "Synced Copilot prompt files to ${TARGET_DIR}"
