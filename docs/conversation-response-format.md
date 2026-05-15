# 会話応答フォーマット

## この文書の位置づけ

Sokra の自由会話ターンで AI が返す JSON 応答の契約を定義する。

会話設計の意図やモードの意味は `docs/conversation-design.md` を参照する。
実行時にモデルへ渡す出力指示は `src/prompt.js`、受信後の検証と正規化は `src/gemini.js` を参照する。

この文書は、AI 応答 JSON の人間向け正本とする。

## 対象

この文書は、`requestKind: "interview_turn"` の通常会話ターンを主対象とする。

クロージング要約系の `closing_summary` と `closing_impression_summary` は別の簡易フォーマットを使うため、この文書の対象外とする。

## 基本構造

通常会話ターンでは、AI は次の JSON オブジェクトを返す。

```json
{
  "reaction": "それはよかったです",
  "text": "特に印象に残っている場面はありましたか？",
  "checkpoints_filled": ["impression"],
  "ready_to_close": false,
  "has_question": true
}
```

## フィールド定義

### `reaction`

- 型: string
- 必須性: 条件付き
- 役割: 相づちや短い反応

ルール:

- 自然なときだけ入れる
- 不要なら省略または空文字列にしてよい
- 通常モードでは、その発話でなければ成立しない具体性を優先する
- 単発の遊び入力では、語に対応する絵文字 1 つだけになることがある

### `text`

- 型: string
- 必須性: 原則必須
- 役割: 問いかけ、または受け止めとして返す本体メッセージ

ルール:

- 通常ターンでは空文字列にしない
- `reaction` と同じ内容を繰り返さない
- 相づちと問いかけを改行で連結しない
- `ready_to_close: true` のときは、別れの言葉を入れる

例外:

- 単発の 1 語ボケ、文脈外ワードの最初のターンだけは空文字列を許容する

### `checkpoints_filled`

- 型: string[]
- 必須性: 必須
- 役割: 今回の参加者発言で自然に拾えた論点 ID の配列

ルール:

- 複数可
- なければ `[]`
- 未知の ID は無効
- すでに回収済みの ID は無効

現時点で有効な論点 ID は、実装上は `CHECKPOINTS` に従う。

### `ready_to_close`

- 型: boolean
- 必須性: 必須
- 役割: このターンで終了準備が整ったか

ルール:

- `false` が通常
- `true` のときは `text` を必須とする
- `true` のときは `has_question` を `false` にする

### `has_question`

- 型: boolean
- 必須性: 条件付き
- 役割: `text` が問いかけで終わるかどうか

ルール:

- `text` が問いかけなら `true`
- 問いかけでなければ `false`
- `text` が空文字列なら `false`

実装上、`text` があるのに `has_question` が欠けていた場合は、受信側で `true` 扱いに補完される。
ただし運用上は、AI が明示的に返す前提で扱う。

## 必須性まとめ

| フィールド | 型 | 必須性 |
|---|---|---|
| `reaction` | string | 条件付き |
| `text` | string | 原則必須 |
| `checkpoints_filled` | string[] | 必須 |
| `ready_to_close` | boolean | 必須 |
| `has_question` | boolean | 条件付き |

## モードごとの許容形

会話モード自体の定義は `docs/conversation-design.md` に従う。
ここでは JSON 形状としての許容条件だけを整理する。

### `normal`

```json
{
  "reaction": "いいですね",
  "text": "どのあたりが印象に残りましたか？",
  "checkpoints_filled": [],
  "ready_to_close": false,
  "has_question": true
}
```

- `reaction` は省略可
- `text` は必須

### `single`

```json
{
  "reaction": "🍎",
  "text": "",
  "checkpoints_filled": [],
  "ready_to_close": false,
  "has_question": false
}
```

- `reaction` は必須
- `text` は空文字列
- `has_question` は `false`

### `short_probe_streak`

```json
{
  "reaction": "あはは！",
  "text": "すみません笑",
  "checkpoints_filled": [],
  "ready_to_close": false,
  "has_question": false
}
```

- `reaction` は必須
- `text` は必須

### `shiritori_streak`

```json
{
  "reaction": "ふふ",
  "text": "じゃあ次は ら ですね。",
  "checkpoints_filled": [],
  "ready_to_close": false,
  "has_question": false
}
```

- `reaction` は必須
- `text` は必須

## 受信側の検証ルール

`src/gemini.js` では、少なくとも次を検証する。

1. ルートが JSON オブジェクトであること
2. `reaction` または `text` のどちらかが存在すること
3. `reaction only` が許されないターンでは `text` があること
4. `ready_to_close: true` のとき `text` があること
5. `checkpoints_filled` は有効な未回収 ID だけに正規化されること

つまり、この文書は AI が守るべき契約であり、最終的な受理条件は `src/gemini.js` の検証に従う。

## プロンプト変更で済む範囲

次は、このフォーマットを維持したまま `src/prompt.js` の調整で変えられる。

- `reaction` の口調
- `text` の温度感
- 質問の強さ
- 遊び入力への乗り方
- クロージングの言い回し

## ロジック変更が必要な範囲

次を変えるときは、フォーマット文書だけでなくロジック変更も検討する。

- `reaction only` を許す条件
- モードごとの必須フィールド条件
- `has_question` の補完方針
- `checkpoints_filled` の検証条件

## 関連ファイル

- 会話設計: `docs/conversation-design.md`
- 用語: `docs/glossary.md`
- プロンプト: `src/prompt.js`
- 応答検証: `src/gemini.js`
