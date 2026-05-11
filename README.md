# Sokra

**Sokra** は、自然な対話を通じて、率直なフィードバックを引き出す AI インタビューツールです。

ソクラテス式問答法（*maieutics*）に着想を得ています。真実はもともとその人の中にあり、Sokra の役割はそれを外に出しやすくすることです。

---

## 想定ユースケース

- セミナーやイベント後の感想収集
- エンジニア向けのデイリースタンドアップ代替
- プロジェクトのふりかえり
- 1on1 の事前準備
- 記述式フォームだと中身の薄い回答になりやすい場面全般

---

## コンセプト

従来のフィードバックフォームは、次のような傾向を持ちがちです。

- 質問する側の前提や期待を反映してしまう
- 「正しそうな答え」を書かせやすい
- 回答者を退屈させやすい
- 文章化が得意な人ほど有利になる

Sokra は代わりに、**感じのよい聞き手**として振る舞います。摩擦を減らし、雑談を許容し、構造化された答えを無理に求めません。

> 目的は「役立つフィードバックを生成すること」ではありません。率直な言葉を集めることです。

---

## 仕組み

1. **コンテキスト設定** — 主催者が事前にセミナーやイベントの前提情報を設定する
2. **ボタンフェーズ** — 数問のタップ式質問でウォームアップしつつ、基本情報を集める
3. **自由会話** — 直前の回答を受けて、相づちや自然な質問を返す
4. **ログ保存** — 生の会話を JSON として保存し、後で NotebookLM などで分析できるようにする

### 隠れたチェックポイント

Sokra は、会話の中で拾いたい論点を内部チェックリストとして持ちます。これは回答者には見えません。ただし、チェックポイントの順序は固定しません。直前の回答で自然に触れられた論点だけを記録し、返答は会話の流れに合わせて選びます。
チェックポイントは必達ノルマではなく観測点です。自然に寄れなかった論点が残っても、そのこと自体を「想定外の感想や関心があった」会話記録として扱います。

デフォルトのチェックポイント:

- 参加背景
- 全体の印象や温度感
- 記憶に残った場面
- 自然に出てきた引っかかりや違和感
- 実務や日常との接点

会話制御の基本は「直前のやり取りを受ける」ことです。未回収の論点を埋めるために、別の話題へ急に戻ることは避けます。
特に、参加者が面白さや便利さを話している流れで、こわさや違和感を前提にした質問はしません。

---

## AI のふるまい原則

**Sokra がしないこと**

- その場で要約や分析をしない
- 前向きな結論へ誘導しない
- 「インタビューされている感」を強く出さない
- 「つまりこういうことですね」のような分析的な言い換えをしない

**Sokra がすること**

- ラフな会話を演出するために、短い相づちをタイミングよく使う
- 具体例や面白がった理由が出たら、相づちで受けたあと、必要なら8秒程度待って自然に次の話題へ橋をかける
- 雑談や脱線を許容し、ときには促す
- 返答の長さやテンポに揺らぎを持たせる
- *評価* ではなく *記憶* を聞く
- 「特にない」も有効な答えとして受け止める

---

## 技術構成

- **フロントエンド**: 素の PHP/HTML/CSS/JS（`index.php`、`styles.css`、`app.js` + `src/` 配下の ES Modules。ビルド不要）
- **バックエンド**: PHP（`router.php`、`api/index.php`、`api/lib/*.php`）
- **AI**: Gemini API（自由会話の発話生成、終了判定、チェックポイント更新）
- **ログ形式**: `data/sessions/*.jsonl` へのサーバー側追記 + クライアント側 JSON ダウンロード
- **E2E**: Playwright（`tests/interview.spec.js`）
- **分析**: NotebookLM などでの後分析を想定

---

## セットアップ

```bash
git clone https://github.com/yourname/sokra.git
cd sokra
npm install
cp .env.example .env
# 自由会話フェーズで Gemini API を使うため設定
# ローカルで通常のインタビューを動かす場合も必要
npm start
```

ローカル開発では、`npm start` が `php -S 127.0.0.1:3000 router.php` を起動します。ブラウザで `http://127.0.0.1:3000` を開いてください。

`.env.example`:

```dotenv
# development のときだけ開発用表示を出します
APP_ENV=development

# 自由会話フェーズで Gemini API を使います。
# ローカルで通常のインタビューを動かす場合も設定してください。
GEMINI_API_KEY=
```

セッションログは `data/sessions/*.jsonl` に保存されます。`data/sessions/` が存在しない場合は、API 起動時に自動作成されます。

## API とルーティング

ローカル開発では `router.php` がフロントエンド配信と API ルーティングを兼ねます。

- `GET /`:
  `index.php` を返す
- `POST /api/session/start`:
  セッション開始。`sessionId` を発行する
- `POST /api/session/{sessionId}/event`:
  セッションイベントを JSONL に追記する
- `GET /api/session/{sessionId}`:
  保存済みセッションを JSON として返す
- `POST /api/gemini`:
  Gemini API 呼び出しを中継する

## 公開時の構成

レンタルサーバ向けの本番構成は、Apache + PHP を前提にしています。こちらは `3000` 固定ではなく、Web サーバー側の設定に従います。

- `/api/...` は `api/.htaccess` で `api/index.php` にルーティング
- ルートの `.htaccess` でドット始まりファイルへの直アクセスを拒否
- `.env` は `api/lib/bootstrap.php` 経由で読み込む
- `APP_ENV=development` のときだけ開発用表示を出す
- セッションログは `data/sessions/*.jsonl` に保存されるため、書き込み権限が必要

`.env` の例:

```dotenv
APP_ENV=production
GEMINI_API_KEY=your_api_key
```

## ヘッドレス E2E 確認

Playwright を使ったヘッドレスの UI 動作確認を用意しています。

```bash
npm run test:e2e
```

このテストは `http://127.0.0.1:3000` の画面を実際に開き、開始画面、ボタンフェーズ、自由会話、終了操作までを通します。終了時には `usageStats` と `data/sessions/*.jsonl` を照合し、`warning` や `chat_failure_abort` が出ていないことも確認します。

テストは古いローカルサーバーを再利用せず、現行コードで起動し直します。すでに `3000` 番ポートを使っている開発サーバーがある場合は、停止してから実行してください。

### `localhost` で CSS が 404 になるとき

`http://localhost/` は `:80` を向くため、別の Apache や PHP アプリに接続されることがあります。開発・自走確認は `http://127.0.0.1:3000` を正として確認してください。

```bash
# 3000 側の Sokra 起動確認
curl -I http://127.0.0.1:3000/styles.css

# localhost(:80) 側を使っているプロセス確認
curl -sv http://localhost/ -o /tmp/sokra_localhost_root.html 2>&1 | sed -n '1,20p'
ps -ef | rg "php -S 127.0.0.1:3000|npm start"
```

古い `php -S 127.0.0.1:3000` が残っている場合は停止してから、`npm start` で起動し直してください。

## AI コミット運用（Copilot / Claude / Codex）

このリポジトリでは、コミットメッセージ生成ルールを共通化しています。

- 規約本体: `docs/commit-convention.md`
- AI入力テンプレート: `docs/commit-prompt.md`
- クライアント向け設定:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.github/copilot-instructions.md`

任意で、gitのコミットテンプレートを有効化できます。

```bash
git config commit.template .gitmessage.txt
```

## リポジトリ内の補助資料

- `AGENTS.md`: AI 共通ルールの正本
- `CLAUDE.md`: Claude 向け補助ファイル
- `docs/commit-convention.md`: コミットメッセージ規約
- `docs/commit-prompt.md`: コミットメッセージ生成用プロンプト
- `skills/`: 共用スキル

## 共用スキル

共用スキルの正本は `skills/` 配下です。
3系統をまとめて同期する場合は、次を使います。

```bash
bash scripts/sync-all-skills.sh
```

個別に同期する場合は次のスクリプトを使います。

Codex で UI から使う場合は、次で `~/.codex/skills/sokra/` へコピーします。

```bash
bash scripts/install-skills.sh
```

Claude Code でプロジェクトスキルとして使う場合は、次で `.claude/skills/` へ同期します。

```bash
bash scripts/sync-claude-skills.sh
```

GitHub Copilot で再利用プロンプトとして使う場合は、次で `.github/prompts/` を生成します。

```bash
bash scripts/sync-copilot-prompts.sh
```

Copilot でプロンプトファイルを使うには、IDE 側で `chat.promptFiles` を有効にする必要があります。

---

## 今後の予定

- [ ] 主催者向け設定 UI（セミナー文脈、カスタムチェックポイント）
- [ ] 主催者向けの事前設定フロー
- [ ] 複数セッションのログ集約
- [ ] 配布タイミング制御（イベント直後ではなく後送するなど）
- [ ] セミナー以外への一般化

---

## ライセンス

MIT
