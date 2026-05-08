---
agent: 'agent'
description: 'AI向け文書の整合と曖昧さをレビューする'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/ai-doc-review/SKILL.md

次の方針で進めてください。

- `AGENTS.md` と `.github/copilot-instructions.md` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

AI向け文書の変更について、SSOT、参照整合、重複、曖昧表現、更新漏れを優先度順にレビューしてください。
