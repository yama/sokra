# Commit Convention (Japanese)

このリポジトリでは、コミットメッセージを Conventional Commits 形式で記述します。

## 形式

`type(scope): subject`

- scope は任意
- subject は日本語
- subject は50文字以内を目安
- subject の末尾に句点（。）、感嘆符（!）を付けない
- 絵文字は使わない

## type 一覧

- feat: 新機能
- fix: バグ修正
- refactor: 振る舞いを変えないリファクタ
- docs: ドキュメント変更
- test: テスト追加・修正
- chore: 雑務、設定、メンテ
- perf: パフォーマンス改善
- build: ビルド関連
- ci: CI設定

## body の方針

必要なときだけ追加します。追加する場合は日本語の箇条書きで記述します。

例:

- 会話ログ保存をサーバー側へ移行
- Gemini呼び出しをバックエンド経由に変更

## footer の方針

破壊的変更がある場合のみ次を追記します。

BREAKING CHANGE: 互換性がない変更内容

## 生成時の判断基準

1. 変更の主目的を1つ選ぶ
2. 主目的に合う type を選ぶ
3. 影響範囲が明確なら scope を付ける
4. subject は「何をしたか」を短く具体的に書く
5. body には「なぜ/何を」を補足し、過剰説明しない

## 禁止事項

- 実際に変更していない内容を書く
- あいまいな subject（例: 更新、修正対応）
- 複数の異なる目的を1つの subject に詰め込む
