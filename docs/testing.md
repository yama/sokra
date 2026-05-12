# Testing

Sokra の E2E テスト実行メモです。

## 実行コマンド

```bash
npm run test:e2e
```

Playwright が開始画面、ボタンフェーズ、自由会話、終了操作までを確認します。

## 失敗時チェックリスト（最小）

`Failed to listen on 127.0.0.1:3000` が出たら、次の順に切り分ける。

1. ポート競合を確認する: `lsof -i :3000`
2. 既存プロセスがあれば停止する（古い `php -S` など）
3. `npm run test:e2e` を再実行する
4. AI 自走テスト時のみ一時的にポートを切り替える: `SOKRA_TEST_PORT=3100 npm run test:e2e`（手動運用の既定は 3000 のまま）
5. それでも失敗する場合は sandbox の listen 制約を疑い、ローカル端末側で実行して切り分ける
