---
agent: 'agent'
description: '差分からコミットメッセージを作成する'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/commit-message/SKILL.md

次の方針で進めてください。

- `AGENTS.md` と `.github/copilot-instructions.md` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

現在の差分を確認し、日本語の Conventional Commits 形式でコミットメッセージ本文のみを作成してください。
