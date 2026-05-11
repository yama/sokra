<?php

declare(strict_types=1);

function app_env(): string
{
    $value = getenv('APP_ENV');
    if (!is_string($value) || $value === '') {
        return 'production';
    }

    return strtolower(trim($value));
}

function is_debug_enabled(): bool
{
    return app_env() === 'development';
}

function client_app_config(): array
{
    return [
        'debugEnabled' => is_debug_enabled(),
    ];
}

function app_url(): ?string
{
    $value = getenv('APP_URL');
    if (!is_string($value) || trim($value) === '') {
        return null;
    }

    return rtrim(trim($value), '/');
}

function request_origin(): string
{
    $appUrl = app_url();
    if ($appUrl !== null) {
        return $appUrl;
    }

    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $sanitizedHost = preg_replace('/[^A-Za-z0-9.:\-\[\]]/', '', $host);

    return $scheme . '://' . ($sanitizedHost !== '' ? $sanitizedHost : 'localhost');
}

function request_path(): string
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (!is_string($path) || $path === '') {
        return '/';
    }

    return '/' . ltrim(rawurldecode($path), '/');
}

function request_url(): string
{
    return request_origin() . request_path();
}

function asset_url(string $path): string
{
    return rtrim(request_origin(), '/') . '/' . ltrim($path, '/');
}
