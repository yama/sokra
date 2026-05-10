<?php

declare(strict_types=1);

require_once __DIR__ . '/http.php';

final class GeminiResponseException extends RuntimeException
{
    public array $details;

    public function __construct(string $message, array $details = [])
    {
        parent::__construct($message);
        $this->details = $details;
    }
}

function to_gemini_contents($history, $userText): array
{
    $items = is_array($history) ? $history : [];
    $items[] = ['role' => 'user', 'content' => (string) ($userText ?? '')];

    $contents = [];
    foreach ($items as $item) {
        if (!is_array($item)) {
            continue;
        }

        $role = in_array($item['role'] ?? '', ['assistant', 'ai', 'model'], true) ? 'model' : 'user';
        $text = (string) ($item['content'] ?? $item['text'] ?? '');
        $contents[] = [
            'role' => $role,
            'parts' => [['text' => $text]],
        ];
    }

    return $contents;
}

function extract_candidate_text(?array $candidate): string
{
    $parts = $candidate['content']['parts'] ?? [];
    if (!is_array($parts)) {
        return '';
    }

    $text = '';
    foreach ($parts as $part) {
        if (is_array($part) && isset($part['text']) && is_string($part['text'])) {
            $text .= $part['text'];
        }
    }

    return trim($text);
}

function call_gemini(array $params): array
{
    $apiKey = getenv('GEMINI_API_KEY') ?: '';
    if ($apiKey === '') {
        throw new RuntimeException('GEMINI_API_KEY is not set in .env');
    }

    $modelName = (string) ($params['model'] ?? '');
    if ($modelName === '') {
        throw new RuntimeException('model is required');
    }
    $endpoint = sprintf(
        'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent',
        rawurlencode($modelName)
    );

    // flash: thinking 無効化でコスト削減 / pro: thinking 必須かつ thinking トークンが maxOutputTokens に含まれるため余裕を持たせる
    $isFlash = str_contains($modelName, 'flash');
    $generationConfig = ['maxOutputTokens' => $isFlash ? 512 : 8192];
    if ($isFlash) {
        $generationConfig['thinkingConfig'] = ['thinkingBudget' => 0];
    }
    if (!empty($params['responseMimeType'])) {
        $generationConfig['responseMimeType'] = (string) $params['responseMimeType'];
    }

    try {
        $response = post_json($endpoint, [
            'systemInstruction' => [
                'parts' => [['text' => (string) ($params['systemPrompt'] ?? '')]],
            ],
            'generationConfig' => $generationConfig,
            'contents' => to_gemini_contents($params['conversationHistory'] ?? [], $params['userText'] ?? ''),
        ], [
            'x-goog-api-key: ' . $apiKey,
        ]);
    } catch (RuntimeException $e) {
        throw new RuntimeException('Failed to connect to Gemini API', previous: $e);
    }

    if ($response['status'] < 200 || $response['status'] >= 300) {
        throw new GeminiResponseException(
            sprintf('Gemini API Error %d', $response['status']),
            ['responseBody' => substr($response['body'], 0, 1200)]
        );
    }

    $data = json_decode($response['body'], true);
    if (!is_array($data)) {
        throw new RuntimeException('Gemini API returned invalid JSON');
    }

    $candidate = $data['candidates'][0] ?? null;
    $raw = extract_candidate_text(is_array($candidate) ? $candidate : null);
    if ($raw === '') {
        $finishReason = is_array($candidate) ? (string) ($candidate['finishReason'] ?? '') : '';
        $error = new GeminiResponseException(
            $finishReason === ''
                ? 'Gemini response did not include any text candidate'
                : sprintf('Gemini response did not include any text candidate (finishReason=%s)', $finishReason),
            [
                'finishReason' => $finishReason,
                'modelVersion' => (string) ($data['modelVersion'] ?? ''),
                'candidateExcerpt' => substr(json_encode($candidate, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 0, 1200),
            ]
        );
        throw $error;
    }

    $usage = is_array($data['usageMetadata'] ?? null) ? $data['usageMetadata'] : [];

    return [
        'text' => $raw,
        'usage' => [
            'promptTokenCount' => (int) ($usage['promptTokenCount'] ?? 0),
            'outputTokenCount' => (int) ($usage['candidatesTokenCount'] ?? $usage['outputTokenCount'] ?? 0),
            'totalTokenCount' => (int) ($usage['totalTokenCount'] ?? 0),
        ],
        'finishReason' => (string) ($candidate['finishReason'] ?? ''),
        'modelVersion' => (string) ($data['modelVersion'] ?? ''),
    ];
}
