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
