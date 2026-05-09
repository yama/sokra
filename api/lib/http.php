<?php

declare(strict_types=1);

function send_json(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_body(): array
{
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > 1_000_000) {
        throw new RuntimeException('Request body too large');
    }

    $stream = fopen('php://input', 'rb');
    if ($stream === false) {
        return [];
    }

    $rawBody = stream_get_contents($stream, 1_000_001);
    fclose($stream);

    if ($rawBody === false || $rawBody === '') {
        return [];
    }

    if (strlen($rawBody) > 1_000_000) {
        throw new RuntimeException('Request body too large');
    }

    $decoded = json_decode($rawBody, true);
    if (!is_array($decoded)) {
        return [];
    }

    return $decoded;
}

function post_json(string $url, array $payload, array $headers = []): array
{
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        throw new RuntimeException('Failed to encode request body');
    }

    $requestHeaders = array_merge([
        'Content-Type: application/json',
        'Content-Length: ' . strlen($body),
    ], $headers);

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $requestHeaders),
            'content' => $body,
            'ignore_errors' => true,
            'timeout' => 30,
        ],
    ]);

    $responseBody = @file_get_contents($url, false, $context);
    $headers = $http_response_header ?? [];
    $status = 0;
    if (isset($headers[0]) && preg_match('#\s(\d{3})\s#', $headers[0], $matches) === 1) {
        $status = (int) $matches[1];
    }

    if ($responseBody === false) {
        throw new RuntimeException('Failed to connect to API');
    }

    return [
        'status' => $status,
        'body' => $responseBody,
    ];
}
