---
agent: 'agent'
description: '統一形式でプルリクエスト本文を作成する'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/pr-create/SKILL.md

次の方針で進めてください。

- `AGENTS.md` と `.github/copilot-instructions.md` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

現在の差分とレビュー状況を確認し、統一形式のプルリクエスト本文を作成してください。
