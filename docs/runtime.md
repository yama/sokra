# Runtime Notes

Sokra の実行構成と、ローカル開発時 / 公開時のルーティングメモです。

## API とルーティング

ローカル開発では `router.php` がフロントエンド配信と API ルーティングを兼ねます。

- `GET /`: `index.php`
- `POST /api/session/start`: セッション開始
- `POST /api/session/{sessionId}/event`: セッションイベント追記
- `GET /api/session/{sessionId}`: 保存済みセッション取得
- `POST /api/gemini`: Gemini API 呼び出し中継

## ローカル開発

`npm start` は次を起動します。

```bash
php -S 127.0.0.1:3000 router.php
```

ブラウザでは `http://127.0.0.1:3000` を開きます。

## 公開時のメモ

Apache + PHP を前提にした一般的なレンタルサーバ構成で動かせます。

- `/api/...` は `api/.htaccess` で `api/index.php` にルーティング
- ルートの `.htaccess` でドット始まりファイルへの直アクセスを拒否
- `APP_ENV=development` のときだけ開発用表示を出す
- `data/sessions/*.jsonl` に書き込める権限が必要
