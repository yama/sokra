<?php

declare(strict_types=1);

require_once __DIR__ . '/lib/env.php';
require_once __DIR__ . '/lib/http.php';
require_once __DIR__ . '/lib/session.php';
require_once __DIR__ . '/lib/gemini.php';

load_env(__DIR__ . '/../.env');

ensure_sessions_dir();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

try {
    if ($method === 'POST' && $path === '/api/session/start') {
        $body = read_json_body();
        $sessionId = make_session_id();

        append_jsonl(session_file_path($sessionId), [
            'type' => 'meta',
            'ts' => gmdate('c'),
            'model' => $body['model'] ?? 'gemini-2.5-flash',
            'client' => $body['client'] ?? 'web',
        ]);

        send_json(200, ['sessionId' => $sessionId]);
    }

    if ($method === 'POST' && preg_match('#^/api/session/([^/]+)/event$#', $path, $matches) === 1) {
        $sessionId = $matches[1];
        $filePath = session_file_path($sessionId);
        if (!is_file($filePath)) {
            send_json(404, ['error' => 'Session not found']);
        }

        $body = read_json_body();
        if (!array_key_exists('event', $body) || !is_array($body['event'])) {
            send_json(400, ['error' => 'event is required']);
        }

        append_jsonl($filePath, array_merge($body['event'], ['ts' => gmdate('c')]));
        send_json(200, ['ok' => true]);
    }

    if ($method === 'GET' && preg_match('#^/api/session/([^/]+)$#', $path, $matches) === 1) {
        $sessionId = $matches[1];
        $filePath = session_file_path($sessionId);
        if (!is_file($filePath)) {
            send_json(404, ['error' => 'Session not found']);
        }

        send_json(200, parse_session_file($filePath));
    }

    if ($method === 'POST' && $path === '/api/gemini') {
        $body = read_json_body();
        try {
            send_json(200, call_gemini([
                'model' => $body['model'] ?? null,
                'systemPrompt' => $body['systemPrompt'] ?? null,
                'conversationHistory' => $body['conversationHistory'] ?? null,
                'userText' => $body['userText'] ?? null,
                'responseMimeType' => $body['responseMimeType'] ?? null,
            ]));
        } catch (Throwable $e) {
            send_json(502, [
                'error' => $e->getMessage(),
                'code' => $e->getCode() ? (string) $e->getCode() : '',
                'details' => property_exists($e, 'details') ? $e->details : null,
            ]);
        }
    }

    send_json(404, ['error' => 'Not found']);
} catch (Throwable $e) {
    send_json(500, ['error' => $e->getMessage() ?: 'Internal Server Error']);
}
