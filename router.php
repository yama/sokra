<?php

declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$filePath = __DIR__ . $path;
$baseName = basename($path);

if ($baseName !== '' && $baseName[0] === '.') {
    http_response_code(404);
    return true;
}

if ($path !== '/' && is_file($filePath)) {
    return false;
}

if ($path === '/api' || str_starts_with($path, '/api/')) {
    require __DIR__ . '/api/index.php';
    return true;
}

require __DIR__ . '/index.html';
