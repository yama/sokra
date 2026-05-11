<?php

declare(strict_types=1);

require_once __DIR__ . '/api/lib/bootstrap.php';

$clientConfig = client_app_config();
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = $_SERVER['HTTP_HOST'] ?? 'localhost';
$origin = $scheme . '://' . $host;
$pageUrl = $origin . ($_SERVER['REQUEST_URI'] ?? '/');
$ogImageUrl = $origin . '/assets/images/ogp/default.png';
?>
<!DOCTYPE html>
<html lang="ja">

<head>
    <meta charset="UTF-8">
    <meta name="viewport"
          content="width=device-width, initial-scale=1.0">
    <title>セミナーインタビュー</title>
    <meta name="description" content="AI活用セミナーの参加者に、ソクラテスのように問いを重ねながら率直な感想を引き出しやすくするインタビューツールです。">
    <link rel="icon" href="/favicon.ico" sizes="any">
    <meta property="og:type" content="website">
    <meta property="og:title" content="セミナーインタビュー">
    <meta property="og:description" content="AI活用セミナーの参加者に、ソクラテスのように問いを重ねながら率直な感想を引き出しやすくするインタビューツールです。">
    <meta property="og:url" content="<?= htmlspecialchars($pageUrl, ENT_QUOTES, 'UTF-8') ?>">
    <meta property="og:image" content="<?= htmlspecialchars($ogImageUrl, ENT_QUOTES, 'UTF-8') ?>">
    <meta property="og:locale" content="ja_JP">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="セミナーインタビュー">
    <meta name="twitter:description" content="AI活用セミナーの参加者に、ソクラテスのように問いを重ねながら率直な感想を引き出しやすくするインタビューツールです。">
    <meta name="twitter:image" content="<?= htmlspecialchars($ogImageUrl, ENT_QUOTES, 'UTF-8') ?>">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/styles.css">
</head>

<body>

    <!-- 開始画面 -->
    <div id="startScreen">
        <div class="start-hero">
            <h1>セミナーインタビュー</h1>
            <p>会話進行・終了判定はGeminiに委任します。</p>
        </div>
        <div class="start-body">
            <div class="model-select-wrap">
                <label for="modelSelect">モデル</label>
                <select id="modelSelect">
                    <option value="gemini-2.5-flash"
                            selected>gemini-2.5-flash（高速・低コスト）</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro（高品質・高コスト）</option>
                </select>
            </div>
            <button id="startBtn">開始する</button>
            <div class="start-error"
                 id="startError"
                 role="alert"
                 aria-live="assertive">開始できませんでした</div>
        </div>
    </div>

    <!-- メイン画面 -->
    <div id="mainScreen">
        <div class="chat-header">
            <div>
                <div class="chat-header-title">AI活用セミナー</div>
                <div class="chat-header-sub">インタビュー</div>
            </div>
            <div class="progress-wrap"
                 id="progressDots"
                 aria-hidden="true"></div>
        </div>

        <div class="messages"
             id="messages"
             role="log"
             aria-live="polite"
             aria-label="会話"
             tabindex="-1"></div>

        <div id="earlyCloseHint" class="early-close-hint"></div>

        <div class="input-area"
             id="inputArea">
            <textarea id="userInput"
                      placeholder="気軽に話してください"></textarea>
            <button class="send-btn"
                    id="sendBtn"
                    aria-label="送信">
                <svg viewBox="0 0 24 24"
                     fill="none"
                     stroke="currentColor"
                     stroke-width="2.5"
                     stroke-linecap="round"
                     stroke-linejoin="round">
                    <line x1="12"
                          y1="19"
                          x2="12"
                          y2="5"></line>
                    <polyline points="5 12 12 5 19 12"></polyline>
                </svg>
            </button>
        </div>

        <div class="debug-panel"
             id="debugPanel"
             <?= $clientConfig['debugEnabled'] ? '' : 'hidden' ?>>
            <div class="debug-title">通過地点（開発用表示）</div>
            <div class="check-items"
                 id="checkItems"></div>
            <div class="usage-stats"
                 id="usageStats"></div>
            <div class="ended-note"
                 id="endedNote">会話が完了しました</div>
            <button class="log-btn"
                    id="logBtn">JSONログをダウンロード</button>
        </div>
    </div>

    <script>
        window.__SOKRA_CONFIG__ = <?= json_encode(
            $clientConfig,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        ) ?>;
    </script>
    <script type="module" src="/app.js"></script>
</body>

</html>
