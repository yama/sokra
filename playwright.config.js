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
        command: "npm run start:e2e",
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 120000
    }
});
