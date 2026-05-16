# 会話応答フォーマット

## この文書の位置づけ

Sokra の自由会話ターンで AI が返す JSON 応答の契約を定義する。

会話設計の意図やモードの意味は `docs/conversation-design.md` を参照する。
実行時にモデルへ渡す出力指示は `src/prompt.js`、受信後の検証と正規化は `src/gemini.js` を参照する。

この文書は、通常会話ターンの AI 応答 JSON の人間向け正本とする。

## 対象

この文書は、`requestKind: "interview_turn"` の通常会話ターンを対象とする。

クロージング要約系の `closing_summary` と `closing_impression_summary` は別の簡易フォーマットを使うため、この文書の対象外とする。

## 基本構造

通常会話ターンでは、AI はそのターンで意味を持つ要素だけを JSON オブジェクトで返す。

```json
{
  "reactions": ["それはよかったです"],
  "question": "特に印象に残っている場面はありましたか？",
  "checkpoints_filled": ["impression"],
  "ready_to_close": false
}
```

## フィールド定義

### `reactions`

- 型: string[]
- 必須性: 必須
- 役割: 相手の発話を受け止める短いリアクション候補

ルール:

- 0 件でもよい
- 各要素は短い文とし、空文字列を入れない
- 自然なときだけ入れる
- 通常モードでは、その発話でなければ成立しない具体性を優先する
- 遊び入力では、絵文字だけ、笑いだけ、ひとことだけの短い返しになることがある
- `question` と同じ内容を不自然に繰り返さない
- `ready_to_close: true` のときは、別れの言葉や締めの余韻をここに入れる

### `question`

- 型: string
- 必須性: 任意
- 役割: 次に相手へ投げる明示的な問い

ルール:

- 問いがある場合にのみ含める
- 問いがない場合は `null` を入れず、キーごと省略する
- 一度に 1 つだけにする
- 相づちと問いかけを 1 つの文字列へ混ぜない
- `ready_to_close: true` のときは含めない

### `checkpoints_filled`

- 型: string[]
- 必須性: 必須
- 役割: 今回の参加者発言で自然に拾えた論点 ID の配列

ルール:

- 複数可
- なければ `[]`
- 未知の ID は無効
- すでに回収済みの ID は無効
- 重複は無効

現時点で有効な論点 ID は、実装上は `CHECKPOINTS` に従う。

### `ready_to_close`

- 型: boolean
- 必須性: 必須
- 役割: このターンで追加の問いを出さずに会話を閉じに行けるか

ルール:

- `false` が通常
- `true` のときは `question` を含めない
- `true` のときは `reactions` に短い締めの言葉を入れてよい

## 必須性まとめ

| フィールド | 型 | 必須性 |
|---|---|---|
| `reactions` | string[] | 必須 |
| `question` | string | 任意 |
| `checkpoints_filled` | string[] | 必須 |
| `ready_to_close` | boolean | 必須 |

## モードごとの許容形

会話モード自体の定義は `docs/conversation-design.md` に従う。
ここでは JSON 形状としての許容条件だけを整理する。

### `normal`

```json
{
  "reactions": ["いいですね"],
  "question": "どのあたりが印象に残りましたか？",
  "checkpoints_filled": [],
  "ready_to_close": false
}
```

- `reactions` は 0 件可
- `question` は必要なときだけ含める

### `playful`

```json
{
  "reactions": ["🍎"],
  "checkpoints_filled": [],
  "ready_to_close": false
}
```

- `reactions` は必須
- `question` は出さない
- 返し方は固定しない。短い笑い、軽い一言、絵文字などがありうる

### `shiritori`

```json
{
  "reactions": ["ぱんだ"],
  "checkpoints_filled": [],
  "ready_to_close": false
}
```

- `reactions` は必須
- `question` は出さない
- 基本は次の語を 1 語だけ返す

## 受信側の検証ルール

`src/gemini.js` では、少なくとも次を検証する。

1. ルートが JSON オブジェクトであること
2. `reactions` は非配列なら `[]` に正規化されること
3. `question` または `reactions` の少なくとも一方に内容があること
4. `question` が必須のターンでは `question` があること
5. `ready_to_close: true` のとき `question` がないこと
6. `checkpoints_filled` は有効な未回収 ID だけに正規化されること

つまり、この文書は AI が守るべき契約であり、最終的な受理条件は `src/gemini.js` の検証に従う。

## プロンプト変更で済む範囲

次は、このフォーマットを維持したまま `src/prompt.js` の調整で変えられる。

- 聞き手の人柄
- `reactions` の口調
- `question` の温度感
- 質問の強さ
- 遊び入力への乗り方
- クロージングの言い回し

## ロジック変更が必要な範囲

次を変えるときは、フォーマット文書だけでなくロジック変更も検討する。

- `question` を必須にするターン条件
- モードごとの `reactions` / `question` の必須条件
- 自動フォローの発火条件
- `checkpoints_filled` の検証条件

## 関連ファイル

- 会話設計: `docs/conversation-design.md`
- 用語: `docs/glossary.md`
- プロンプト: `src/prompt.js`
- 応答検証: `src/gemini.js`
