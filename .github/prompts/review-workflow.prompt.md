---
agent: 'agent'
description: 'コードや設定変更の一般レビューを行う'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/review-workflow/SKILL.md

次の方針で進めてください。

- `AGENTS.md` と `.github/copilot-instructions.md` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

変更差分をレビューし、問題点、退行リスク、変更漏れ、テスト不足を重要度順に整理してください。
