const { test, expect } = require("@playwright/test");

const SESSION_API_BASE = "http://127.0.0.1:3000";

async function choose(page, label) {
    await page.getByRole("button", { name: label, exact: true }).click();
}

async function sendMessage(page, text) {
    const input = page.locator("#userInput");
    await input.fill(text);
    await page.locator("#sendBtn").click();
}

async function waitForAiTurn(page, previousAiCount) {
    await expect
        .poll(async () => await page.locator(".msg.ai").count(), {
            message: "AI message count should increase"
        })
        .toBeGreaterThan(previousAiCount);
}

async function waitForAiTextChange(page, previousText) {
    await expect
        .poll(async () => await readLastAiText(page), {
            message: "last AI text should change"
        })
        .not.toBe(previousText);
}

async function sendAndReadReply(page, text) {
    const previousText = await readLastAiText(page);
    await sendMessage(page, text);
    await waitForAiTextChange(page, previousText);
    return await readLastAiText(page);
}

async function runInterview(page, answers) {
    await page.goto("/");
    await page.getByRole("button", { name: "開始する" }).click();

    await choose(page, "現地参加");
    await choose(page, "仕事終わり");
    await choose(page, "まあまあ");

    await expect(page.locator("#userInput")).toBeVisible();

    for (const answer of answers) {
        const aiCountBefore = await page.locator(".msg.ai").count();
        await sendMessage(page, answer);
        await waitForAiTurn(page, aiCountBefore);
        const ended = await page.locator("#endedNote").isVisible();
        if (ended) break;
    }

    await expect(page.locator("#endedNote")).toBeVisible();

    const usageText = await page.locator("#usageStats").innerText();
    const sessionMatch = usageText.match(/セッションID: (sess_[^\s]+)/);
    expect(sessionMatch, "session id should be shown in usage stats").not.toBeNull();
    expect(usageText).toContain("fallback: 0回");

    const sessionId = sessionMatch[1];
    const sessionUrl = `${SESSION_API_BASE}/api/session/${sessionId}`;
    let session = null;
    await expect
        .poll(async () => {
            const response = await page.request.get(sessionUrl);
            if (!response.ok()) return null;
            session = await response.json();
            return session?.session_id || null;
        }, {
            message: "session api should return the saved session"
        })
        .toBe(sessionId);

    const warningEvents = session.events.filter(event => event.type === "warning");
    expect(warningEvents, "session should not contain warning events").toEqual([]);

    const lastAiEvent = [...session.events].reverse().find(event => event.role === "ai");
    expect(lastAiEvent?.type).toBe("closing_message");

    return {
        usageText,
        sessionId,
        lastAiText: lastAiEvent?.text || "",
        events: session.events
    };
}

async function startInterview(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "開始する" }).click();
    await choose(page, "現地参加");
    await choose(page, "仕事終わり");
    await choose(page, "まあまあ");
    await expect(page.locator("#userInput")).toBeVisible();
    await expect(page.locator(".msg.ai .bubble").last()).toContainText("印象に残った話");
}

async function readLastAiText(page) {
    const count = await page.locator(".msg.ai .bubble").count();
    return await page.locator(".msg.ai .bubble").nth(count - 1).innerText();
}

test.describe("interview runtime", () => {
    test("standard interview ends with closing_message and no warnings", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("参加のきっかけ");
        expect(reply).toContain("印象");
        expect(reply).not.toContain("使えそう");

        reply = await sendAndReadReply(page, "文章を自動で整える話が印象的でした");
        expect(reply).toContain("どんな感じ");

        reply = await sendAndReadReply(page, "文章が整うところが面白かったです");
        expect(reply).toContain("こわさ");

        reply = await sendAndReadReply(page, "でも少しこわい気もしました");
        expect(reply).toContain("使えそう");

        reply = await sendAndReadReply(page, "社内の問い合わせ対応みたいな場面では使えるかもと思いました");
        expect(reply).toContain("ありがとうございました");
        expect(reply).toContain("使えそう");
        await expect(page.locator("#endedNote")).toBeVisible();

        const usageText = await page.locator("#usageStats").innerText();
        expect(usageText).toContain("fallback: 0回");
    });

    test("short topic flow still reaches normal closing", async ({ page }) => {
        const result = await runInterview(page, [
            "資料作成のデモなど",
            "箇条書きから文章を作る話が面白かった",
            "少しこわさもありました",
            "問い合わせ対応なら使えるかもと思いました",
            "社内で案内があったので来ました"
        ]);

        expect(result.lastAiText).toContain("終わりにします");
    });

    test("core interview does not depend on Gemini calls and stops on meta complaint", async ({ page }) => {
        let geminiCallCount = 0;
        await page.route("**/api/gemini", async route => {
            geminiCallCount += 1;
            await route.continue();
        });

        await startInterview(page);

        let lastAiText = await sendAndReadReply(page, "資料作成のデモかな");
        expect(lastAiText).toContain("どのあたり");
        expect(lastAiText).not.toContain("きっかけ");

        lastAiText = await sendAndReadReply(page, "入力した文章が整理される話です");
        expect(lastAiText).toContain("どんな感じ");
        expect(lastAiText).not.toContain("印象に残った話");
        expect(lastAiText).not.toContain("きっかけ");

        lastAiText = await sendAndReadReply(page, "会話が噛み合ってません");
        await expect(page.locator("#endedNote")).toBeVisible();
        expect(lastAiText).toContain("噛み合っていない");
        expect(geminiCallCount).toBe(0);

        const usageText = await page.locator("#usageStats").innerText();
        const sessionMatch = usageText.match(/セッションID: (sess_[^\s]+)/);
        expect(sessionMatch).not.toBeNull();
        const sessionId = sessionMatch[1];
        const sessionUrl = `${SESSION_API_BASE}/api/session/${sessionId}`;
        let session = null;
        await expect
            .poll(async () => {
                const response = await page.request.get(sessionUrl);
                if (!response.ok()) return null;
                session = await response.json();
                return session?.session_id || null;
            })
            .toBe(sessionId);

        const warningCodes = session.events.filter(event => event.type === "warning").map(event => event.warning_code);
        expect(warningCodes).toEqual([]);
        const lastAiEvent = [...session.events].reverse().find(event => event.role === "ai");
        expect(lastAiEvent?.type).toBe("conversation_mismatch_guard");
    });

    test("low-energy answer is accepted without pretending a topic was given", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "特にないです");
        expect(reply).not.toContain("その話");
        expect(reply).not.toContain("残っていた");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();

        const usageText = await page.locator("#usageStats").innerText();
        expect(usageText).toContain("fallback: 0回");
    });

    test("answers can arrive out of checkpoint order without ending early", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "問い合わせ対応で使えそうでした");
        expect(reply).toContain("印象");
        expect(reply).not.toContain("ありがとうございました");

        reply = await sendAndReadReply(page, "少し怖さもありました");
        expect(reply).toContain("印象");
        expect(reply).not.toContain("ありがとうございました");

        reply = await sendAndReadReply(page, "文章を自動で整える話です");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });

    test("enthusiastic answer covering multiple points is not re-asked mechanically", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(
            page,
            "文章を自動で整える話が印象的でした。面白い一方で少し怖さもあって、社内の問い合わせ対応なら便利に使えそうだと思いました。"
        );
        expect(reply).toContain("きっかけ");
        expect(reply).not.toContain("どんな感じ");
        expect(reply).not.toContain("仕事や普段");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });

    test("varied event topics are handled without product-specific assumptions", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "NotebookLMで資料を読み込む話が印象的でした");
        expect(reply).toContain("どんな感じ");
        expect(reply).not.toContain("Claude");

        reply = await sendAndReadReply(page, "非エンジニアでもホームページを作れそうなのは便利だと思いました");
        expect(reply).toContain("こわさ");

        reply = await sendAndReadReply(page, "少し難しそうな感じもありました");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "知人に誘われて参加しました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });

    test("business-role topic such as sales material creation stays generic", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "営業担当者向けにAIで営業資料を作る話が印象的でした");
        expect(reply).toContain("どんな感じ");

        reply = await sendAndReadReply(page, "提案書のたたき台を作れそうなのが面白かったです");
        expect(reply).toContain("こわさ");

        reply = await sendAndReadReply(page, "品質の確認は少し難しそうでした");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "上司に案内されて参加しました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });

    test("participant background can vary by age and role", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "学校で先生が見せてくれた話が印象に残りました");
        expect(reply).toContain("どんな感じ");

        reply = await sendAndReadReply(page, "宿題のヒントを出してくれるのは便利そうでした");
        expect(reply).toContain("こわさ");

        reply = await sendAndReadReply(page, "答えをそのまま写してしまいそうなのは少し不安です");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "家族に誘われて参加しました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });

    test("private-life use case such as dinner recipes is accepted", async ({ page }) => {
        await startInterview(page);

        let reply = await sendAndReadReply(page, "晩ごはんのレシピを考える話が印象的でした");
        expect(reply).toContain("どんな感じ");

        reply = await sendAndReadReply(page, "冷蔵庫にあるもので候補を出せるのは便利そうでした");
        expect(reply).toContain("こわさ");

        reply = await sendAndReadReply(page, "間違った提案が出るのは少し不安です");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "家族に誘われて参加しました");
        expect(reply).toContain("ありがとうございました");
        await expect(page.locator("#endedNote")).toBeVisible();
    });
});
