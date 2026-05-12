const { defineConfig } = require("@playwright/test");
const _rawPort = parseInt(process.env.SOKRA_TEST_PORT, 10);
const TEST_PORT = (_rawPort >= 1 && _rawPort <= 65535) ? _rawPort : 3000;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

module.exports = defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    workers: 1,
    timeout: 120000,
    expect: {
        timeout: 10000
    },
    use: {
        baseURL: BASE_URL,
        headless: true,
        trace: "on-first-retry"
    },
    webServer: {
        // 既定は 3000 固定。AI 自走テスト時のみ SOKRA_TEST_PORT で一時的に上書き可能
        command: `php -S 127.0.0.1:${TEST_PORT} router.php`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 120000
    }
});
