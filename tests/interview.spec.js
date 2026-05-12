const { test, expect } = require("@playwright/test");

const SESSION_API_BASE = `http://127.0.0.1:${process.env.SOKRA_TEST_PORT || "3000"}`;

async function choose(page, label) {
    await page.getByRole("button", { name: label, exact: true }).click();
}

async function sendMessage(page, text) {
    const input = page.locator("#userInput");
    await input.fill(text);
    await page.locator("#sendBtn").click();
}

async function readLastAiText(page) {
    // ストリーミング中は親要素に aria-hidden="true" が付く。完成済みバブルのみ対象にする
    return await page.locator(".msg.ai:not([aria-hidden]) .bubble").last().innerText();
}

async function waitForAiTextChange(page, previousText) {
    await expect
        .poll(async () => await readLastAiText(page), {
            message: "last AI text should change",
            timeout: 15000
        })
        .not.toBe(previousText);
}

async function sendAndReadReply(page, text) {
    const previousText = await readLastAiText(page);
    await sendMessage(page, text);
    await waitForAiTextChange(page, previousText);
    return await readLastAiText(page);
}

async function finishInterview(page) {
    const eventPersisted = page.waitForResponse(response =>
        response.request().method() === "POST"
        && /\/api\/session\/[^/]+\/event$/.test(response.url())
    );
    await page.getByRole("button", { name: "会話を終了する" }).click();
    await expect(page.locator("#endedNote")).toBeVisible();
    await eventPersisted;
}

async function startInterview(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "開始する" }).click();
    await choose(page, "現地参加");
    await choose(page, "仕事終わり");
    await choose(page, "まあまあ");
    await expect(page.locator("#userInput")).toBeVisible();
    await expect(page.locator(".msg.ai:not([aria-hidden]) .bubble").last()).toContainText("印象に残っていること");
}

async function currentSession(page) {
    const usageText = await page.locator("#usageStats").innerText();
    const sessionMatch = usageText.match(/セッションID: (sess_[^\s]+)/);
    expect(sessionMatch, "session id should be shown in usage stats").not.toBeNull();

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

    return { usageText, sessionId, events: session.events };
}

function parseCheckpoints(systemPrompt) {
    const match = systemPrompt.match(/現在の状態:\n([\s\S]+?)\n\n---/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch { return []; }
}

function inferCheckpoints(text) {
    const ids = new Set();
    if (/きっかけ|案内|誘われ|参加した|参加しました|来ました|来た/.test(text)) ids.add("background");
    if (/印象|残った|覚えて|話|デモ|資料|特にない|特にはない/.test(text)) ids.add("impression");
    if (/難し|分から|わから|こわ|怖|不安|引っかか|違和感|品質/.test(text)) ids.add("difficulty");
    if (/仕事|使える|使えそう|便利|普段|日常|業務|問い合わせ|対応|提案書|レシピ|ホームページ/.test(text)) ids.add("practical");
    return [...ids];
}

function defaultGeminiTurn(body) {
    const userText = String(body.userText || "");

    // クロージングサマリー呼び出しの検出（インタビュー用プロンプトを含まない）
    if (body.requestKind === "closing_summary") {
        return {
            text: "話してくれた内容がとても参考になりました。ありがとうございました。",
            checkpoints_filled: [],
            ready_to_close: false
        };
    }
    if (body.requestKind === "closing_impression_summary") {
        return {
            text: "今日の話には、ちゃんと伝えたいことを持って来てくれた感じがありました。落ち着いた温度で話せたのが印象に残ります。",
            checkpoints_filled: [],
            ready_to_close: false
        };
    }

    const checkpoints = parseCheckpoints(String(body.systemPrompt || ""));
    const filled = inferCheckpoints(userText).filter(id =>
        checkpoints.some(cp => cp.id === id && !cp.done)
    );
    const checkpointsAfter = checkpoints.map(cp => ({
        ...cp,
        done: cp.done || filled.includes(cp.id)
    }));

    const coreDone = ["background", "temperature", "impression", "practical"]
        .every(id => checkpointsAfter.some(cp => cp.id === id && cp.done));
    const conversationHistory = body.conversationHistory || [];
    const allUserTexts = [
        ...conversationHistory.filter(e => e.role === "user").map(e => e.content),
        userText
    ].join("\n");
    const lowEnergy = /特にない|特にはない/.test(allUserTexts);
    const backgroundDone = checkpointsAfter.some(cp => cp.id === "background" && cp.done);
    const isDone = coreDone || (lowEnergy && backgroundDone);

    const missing = ["impression", "practical", "background"].find(id =>
        !checkpointsAfter.some(cp => cp.id === id && cp.done)
    );
    const nextText = {
        impression: "あー、なるほど。印象に残っている話があれば、そこから聞かせてください。",
        practical: "へー、そこが面白かったんですね。仕事や普段の場面にもつながりそうですか？",
        background: "ちょっと頭にありますよね。参加したきっかけも、一言だけ聞いてもいいですか？"
    };

    return {
        text: isDone
            ? "ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。"
            : lowEnergy && !backgroundDone
            ? "そうなんですね。無理に広げなくて大丈夫です。参加したきっかけだけ、一言聞いてもいいですか？"
            : nextText[missing] || "ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。",
        checkpoints_filled: filled,
        ready_to_close: isDone
    };
}

async function mockGemini(page, responder = defaultGeminiTurn) {
    const calls = [];
    await page.route("**/api/gemini", async route => {
        const requestBody = route.request().postDataJSON();
        calls.push(requestBody);
        const responseText = await responder(requestBody, calls.length);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                text: typeof responseText === "string" ? responseText : JSON.stringify(responseText),
                usage: {
                    promptTokenCount: 10,
                    outputTokenCount: 5,
                    totalTokenCount: 15
                },
                finishReason: "STOP",
                modelVersion: "mock"
            })
        });
    });
    return calls;
}

test.describe("interview runtime", () => {
    test("standard interview uses Gemini turns and ends with closing action", async ({ page }) => {
        const geminiCalls = await mockGemini(page);
        await startInterview(page);

        let reply = await sendAndReadReply(page, "文章を自動で整えるデモの話が印象的でした");
        expect(reply).toContain("仕事や普段");
        expect(reply).not.toContain("こわ");
        expect(reply).not.toContain("違和感");

        reply = await sendAndReadReply(page, "社内の問い合わせ対応みたいな場面では使えるかもと思いました");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("終わりにしましょう");
        await expect(page.locator(".closing-action")).toBeVisible();
        await page.getByRole("button", { name: "要約を表示する" }).click();
        await expect(page.locator("#typingIndicator")).toHaveCount(0);
        await expect(page.locator("#closingSummaryModal")).toBeVisible();
        await expect(page.locator("#closingSummaryText")).toContainText("印象");
        await page.locator("#summaryModalClose").click();
        await expect(page.locator("#closingSummaryModal")).toBeHidden();
        await expect(page.getByRole("button", { name: "要約を表示する" })).toBeFocused();
        reply = await sendAndReadReply(page, "そう言ってもらえると少し安心しました");
        expect(reply).not.toEqual("");
        await expect(page.locator(".closing-action")).toBeVisible();
        await expect(page.locator(".closing-action")).toHaveCount(1);
        await expect(page.locator("#endedNote")).toBeHidden();
        await finishInterview(page);

        expect(geminiCalls).toHaveLength(6); // 3 conversation turns + 1 closing summary + 1 impression summary + 1 closing-phase reply
        expect(geminiCalls[0].responseMimeType).toBe("application/json");
        expect(geminiCalls[0].systemPrompt).toContain("相づちについて");
        expect(geminiCalls[0].systemPrompt).toContain("現在の状態");
        expect(geminiCalls[0].systemPrompt).toContain("論点はノルマではありません");

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("会話制御: Gemini 委任");
        expect(events.filter(event => event.type === "warning")).toEqual([]);
        const lastGeneratedTurn = [...events].reverse().find(event => event.role === "ai" && event.type === "generated_turn");
        expect(lastGeneratedTurn?.answered_checkpoints).toEqual(["background"]);
        expect(lastGeneratedTurn?.ready_to_close).toBe(true);
        expect(events.some(event => event.type === "closing_summary")).toBe(true);
        expect(events.some(event => event.type === "closing_impression_summary")).toBe(true);
        expect(events.some(event => event.type === "closing_guide")).toBe(true);
        expect(events.some(event => event.type === "session_completed_by_user")).toBe(true);
    });

    test("unknown and completed checkpoint ids from Gemini are ignored", async ({ page }) => {
        await mockGemini(page, body => ({
            text: "うんうん。どんな感じがしました？",
            checkpoints_filled: ["temperature", "unknown", "impression", "impression"],
            ready_to_close: false
        }));
        await startInterview(page);

        await sendAndReadReply(page, "資料整理のデモが印象に残りました");

        const { events } = await currentSession(page);
        const generatedTurn = events.find(event => event.type === "generated_turn");
        expect(generatedTurn.answered_checkpoints).toEqual(["impression"]);
    });

    test("typing indicator is shown while a Gemini turn is pending", async ({ page }) => {
        await mockGemini(page, async () => {
            await new Promise(resolve => setTimeout(resolve, 300));
            return {
                text: "うんうん。どんな感じがしました？",
                checkpoints_filled: ["impression"],
                ready_to_close: false
            };
        });
        await startInterview(page);

        const previousText = await readLastAiText(page);
        await sendMessage(page, "資料整理のデモが印象に残りました");
        await expect(page.locator("#typingIndicator .typing")).toBeVisible();
        await waitForAiTextChange(page, previousText);
        await expect(page.locator("#typingIndicator")).toHaveCount(0);
    });

    test("invalid Gemini JSON is retried once before accepting the repaired turn", async ({ page }) => {
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) return "これはJSONではありません";
            return {
                text: "あー、なるほど。印象に残っている話があれば、そこから聞かせてください。",
                checkpoints_filled: ["background"],
                ready_to_close: false
            };
        });
        await startInterview(page);

        const reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("印象");
        expect(geminiCalls).toHaveLength(2);
        expect(geminiCalls[1].systemPrompt).toContain("直前の応答エラー");

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("再試行: 1回");
        expect(events.some(event => event.type === "ai_turn_retry")).toBe(true);
        expect(events.some(event => event.type === "chat_failure_abort")).toBe(false);
    });

    test("positive impression does not force a difficulty question", async ({ page }) => {
        const geminiCalls = await mockGemini(page);
        await startInterview(page);

        const reply = await sendAndReadReply(page, "人間みたいなリアクションをするという話が面白かった");
        expect(reply).toContain("仕事や普段");
        expect(reply).not.toContain("こわ");
        expect(reply).not.toContain("違和感");

        expect(geminiCalls[0].systemPrompt).toContain("difficulty は必ず質問して埋める項目ではありません");
        expect(geminiCalls[0].systemPrompt).toContain("誘導になります");
    });

    test("abandon timer ends session after prolonged inactivity", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_ABANDON_MS__ = 1000;
        });
        await mockGemini(page, () => ({
            text: "うんうん、なるほど。どんなところが印象に残りましたか？",
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        // ユーザーが応答しなければ abandonタイマーがセッションを終了する
        await expect(page.locator("#endedNote")).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole("button", { name: "もう一度はじめる" })).toBeVisible();
        await expect(page.getByRole("button", { name: "今回は終了" })).toBeVisible();
        await page.waitForTimeout(500); // session_timeout イベントの永続化を待つ

        const { events } = await currentSession(page);
        expect(events.some(event => event.type === "session_timeout_chat")).toBe(true);
    });

    test("abandon timer in closing phase records a closing timeout without restart action", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_ABANDON_MS__ = 1200;
        });
        await mockGemini(page);
        await startInterview(page);

        await sendAndReadReply(page, "文章を自動で整えるデモの話が印象的でした");
        await sendAndReadReply(page, "社内の問い合わせ対応みたいな場面では使えるかもと思いました");
        await sendAndReadReply(page, "社内で案内があったので来ました");
        await expect(page.locator(".closing-action")).toBeVisible();

        await expect(page.locator("#endedNote")).toContainText("終了として記録しました", { timeout: 5000 });
        await expect(page.getByRole("button", { name: "もう一度はじめる" })).toHaveCount(0);
        await page.waitForTimeout(500);

        const { events } = await currentSession(page);
        expect(events.some(event => event.type === "session_timeout_closing")).toBe(true);
    });

    test("Gemini timeout retries once and then aborts the chat", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_GEMINI_TIMEOUT_MS__ = 100;
        });
        let callCount = 0;
        await page.route("**/api/gemini", async route => {
            callCount += 1;
            await new Promise(resolve => setTimeout(resolve, 300));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    text: JSON.stringify({
                        text: "遅すぎる返答です",
                        checkpoints_filled: [],
                        ready_to_close: false
                    }),
                    usage: { promptTokenCount: 10, outputTokenCount: 5, totalTokenCount: 15 },
                    finishReason: "STOP",
                    modelVersion: "mock"
                })
            });
        });
        await startInterview(page);

        const previousText = await readLastAiText(page);
        await sendMessage(page, "資料整理のデモが印象に残りました");
        await expect(page.locator("#typingIndicator .typing")).toBeVisible();
        await waitForAiTextChange(page, previousText);

        const reply = await readLastAiText(page);
        expect(reply).toContain("処理が止まりました");
        await expect(page.locator("#typingIndicator")).toHaveCount(0);
        await expect(page.locator("#endedNote")).toBeVisible();
        expect(callCount).toBe(2);

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("再試行: 1回");
        expect(events.some(event => event.type === "ai_turn_retry")).toBe(true);
        expect(events.some(event => event.type === "chat_failure_abort")).toBe(true);
    });

    test("low-energy answer can end via Gemini ready_to_close without all checkpoints", async ({ page }) => {
        await mockGemini(page);
        await startInterview(page);

        let reply = await sendAndReadReply(page, "特にないです");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("終わりにしましょう");
        await expect(page.locator(".closing-action")).toBeVisible();

        const { events } = await currentSession(page);
        const lastGeneratedTurn = [...events].reverse().find(event => event.role === "ai" && event.type === "generated_turn");
        expect(lastGeneratedTurn?.ready_to_close).toBe(true);
    });

    test("meta complaint is sent to Gemini and can trigger closing", async ({ page }) => {
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    text: "仕事や普段の場面にもつながりそうですか？",
                    checkpoints_filled: ["impression"],
                    ready_to_close: false
                };
            }
            return {
                text: "噛み合っていない感じになってしまいましたね。ここでいったん止めます。",
                checkpoints_filled: [],
                ready_to_close: true
            };
        });
        await startInterview(page);

        await sendAndReadReply(page, "資料作成のデモかな");
        expect(geminiCalls).toHaveLength(1);

        const reply = await sendAndReadReply(page, "会話が噛み合ってません");
        expect(reply).toContain("噛み合っていない");
        await expect(page.locator(".closing-action")).toBeVisible();
        expect(geminiCalls).toHaveLength(3); // 2 conversation turns + 1 closing summary
        expect(geminiCalls[1].systemPrompt).toContain("クロージングの流れ");

        const { events } = await currentSession(page);
        const lastGeneratedTurn = [...events].reverse().find(event => event.role === "ai" && event.type === "generated_turn");
        expect(lastGeneratedTurn?.ready_to_close).toBe(true);
    });
});
