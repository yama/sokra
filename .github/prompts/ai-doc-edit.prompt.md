---
agent: 'agent'
description: 'AI向け文書の改修と追従更新を行う'
---

このプロンプトでは、まず次の文書を参照してください。

- リポジトリ共通ルール: #file:../copilot-instructions.md
- 正本の共用スキル定義: #file:../../skills/ai-doc-edit/SKILL.md

次の方針で進めてください。

- `AGENTS.md` と `.github/copilot-instructions.md` を優先する
- 上記の共用スキル定義にある手順と判断基準に従う
- 差分や一次情報を確認せずに推測で進めない
- 問題隠しのためのフォールバックを追加しない

依頼:

AI向け文書を改修し、正本、参照先、関連スキルまで含めて整合が取れるように更新してください。
