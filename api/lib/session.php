<?php

declare(strict_types=1);

const ROOT_DIR = __DIR__ . '/../..';
const SESSIONS_DIR = ROOT_DIR . '/data/sessions';

function ensure_sessions_dir(): void
{
    if (is_dir(SESSIONS_DIR)) {
        return;
    }

    if (!mkdir(SESSIONS_DIR, 0777, true) && !is_dir(SESSIONS_DIR)) {
        throw new RuntimeException('Failed to create sessions directory');
    }
}

function make_session_id(): string
{
    return sprintf('sess_%d_%s', (int) round(microtime(true) * 1000), bin2hex(random_bytes(4)));
}

function session_file_path(string $sessionId): string
{
    $safe = preg_replace('/[^a-zA-Z0-9_-]/', '', $sessionId) ?? '';
    if ($safe === '' || strlen($safe) < 8) {
        throw new InvalidArgumentException(sprintf('Invalid session id: %s', $sessionId));
    }

    return SESSIONS_DIR . '/' . $safe . '.jsonl';
}

function append_jsonl(string $filePath, array $payload): void
{
    $line = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    if (file_put_contents($filePath, $line, FILE_APPEND | LOCK_EX) === false) {
        throw new RuntimeException('Failed to append session log');
    }
}

function parse_session_file(string $filePath): array
{
    $lines = file($filePath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        throw new RuntimeException('Failed to read session log');
    }

    $meta = null;
    $events = [];

    foreach ($lines as $line) {
        $item = json_decode($line, true);
        if (!is_array($item)) {
            continue;
        }

        if (($item['type'] ?? null) === 'meta') {
            $meta = $item;
            continue;
        }

        $events[] = $item;
    }

    return [
        'session_id' => basename($filePath, '.jsonl'),
        'meta' => $meta,
        'events' => $events,
    ];
}
