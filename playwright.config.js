const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    workers: 1,
    timeout: 120000,
    expect: {
        timeout: 10000
    },
    use: {
        baseURL: "http://127.0.0.1:3000",
        headless: true,
        trace: "on-first-retry"
    },
    webServer: {
        command: "npm start",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: false,
        timeout: 120000
    }
});
