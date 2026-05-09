const { test, expect } = require("@playwright/test");

const SESSION_API_BASE = "http://127.0.0.1:3000";
const CONTENT_CHECKPOINT_ORDER = ["impression", "difficulty", "practical", "background"];
const CORE_CHECKPOINT_IDS = ["background", "temperature", "impression", "practical"];

async function choose(page, label) {
    await page.getByRole("button", { name: label, exact: true }).click();
}

async function sendMessage(page, text) {
    const input = page.locator("#userInput");
    await input.fill(text);
    await page.locator("#sendBtn").click();
}

async function readLastAiText(page) {
    const count = await page.locator(".msg.ai .bubble").count();
    return await page.locator(".msg.ai .bubble").nth(count - 1).innerText();
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
    await page.getByRole("button", { name: "会話を終了する" }).click();
    await expect(page.locator("#endedNote")).toBeVisible();
}

async function startInterview(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "開始する" }).click();
    await choose(page, "現地参加");
    await choose(page, "仕事終わり");
    await choose(page, "まあまあ");
    await expect(page.locator("#userInput")).toBeVisible();
    await expect(page.locator(".msg.ai .bubble").last()).toContainText("印象に残っていること");
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

function checkpointDone(checkpoints, id) {
    return checkpoints.some(checkpoint => checkpoint.id === id && checkpoint.done);
}

function coreCheckpointsDone(checkpoints) {
    return CORE_CHECKPOINT_IDS.every(id => checkpointDone(checkpoints, id));
}

function inferCheckpoints(text) {
    const ids = new Set();
    if (/特にない|特にはない/.test(text)) ids.add("impression");
    if (/きっかけ|案内|誘われ|参加した|参加しました|来ました|来た/.test(text)) ids.add("background");
    if (/印象|残った|覚えて|話|デモ|資料/.test(text)) ids.add("impression");
    if (/難し|分から|わから|こわ|怖|不安|引っかか|違和感|品質/.test(text)) ids.add("difficulty");
    if (/仕事|使える|使えそう|便利|普段|日常|業務|問い合わせ|対応|提案書|レシピ|ホームページ/.test(text)) ids.add("practical");
    return [...ids];
}

function nextMissingPrompt(checkpointsAfterTurn) {
    const missing = CONTENT_CHECKPOINT_ORDER.find(id => {
        if (id === "difficulty") return false;
        return !checkpointDone(checkpointsAfterTurn, id);
    });
    switch (missing) {
        case "impression":
            return "あー、なるほど。印象に残っている話があれば、そこから聞かせてください。";
        case "practical":
            return "へー、そこが面白かったんですね。仕事や普段の場面にもつながりそうですか？";
        case "background":
            return "ちょっと頭にありますよね。参加したきっかけも、一言だけ聞いてもいいですか？";
        default:
            return "ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。";
    }
}

function defaultGeminiTurn(body) {
    const userText = String(body.userText || "");
    const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
    const filled = inferCheckpoints(userText).filter(id => !checkpointDone(checkpoints, id));
    const checkpointsAfterTurn = checkpoints.map(checkpoint => ({
        ...checkpoint,
        done: checkpoint.done || filled.includes(checkpoint.id)
    }));
    const lowEnergySoftClose = /特にない|特にはない/.test(userText);
    const backgroundAfterLowEnergy = filled.includes("background")
        && checkpointDone(checkpoints, "impression")
        && !checkpointDone(checkpoints, "difficulty")
        && !checkpointDone(checkpoints, "practical");
    const isDone = checkpointsAfterTurn.every(checkpoint => checkpoint.done)
        || coreCheckpointsDone(checkpointsAfterTurn)
        || lowEnergySoftClose && checkpointDone(checkpoints, "background")
        || backgroundAfterLowEnergy;

    return {
        text: lowEnergySoftClose && !checkpointDone(checkpointsAfterTurn, "background")
            ? "そうなんですね。無理に広げなくて大丈夫です。参加したきっかけだけ、一言聞いてもいいですか？"
            : isDone
            ? "ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。"
            : nextMissingPrompt(checkpointsAfterTurn),
        checkpoints_filled: filled,
        is_done: isDone
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
    test("standard interview uses Gemini turns and ends with closing_message", async ({ page }) => {
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
        await expect(page.locator("#endedNote")).toBeHidden();
        await finishInterview(page);

        expect(geminiCalls).toHaveLength(3);
        expect(geminiCalls[0].responseMimeType).toBe("application/json");
        expect(geminiCalls[0].systemPrompt).toContain("質問しないターンの例");
        expect(geminiCalls[0].systemPrompt).toContain("現在の状態");
        expect(geminiCalls[0].systemPrompt).toContain("論点はノルマではありません");

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("会話制御: LLM生成 + アプリ側検証");
        expect(usageText).toContain("fallback: 0回");
        expect(events.filter(event => event.type === "warning")).toEqual([]);
        const lastAiEvent = [...events].reverse().find(event => event.role === "ai");
        expect(lastAiEvent?.type).toBe("closing_message");
        expect(lastAiEvent?.answered_checkpoints).toEqual(["background"]);
        expect(events.some(event => event.type === "session_completed_by_user")).toBe(true);
    });

    test("unknown and completed checkpoint ids from Gemini are ignored", async ({ page }) => {
        await mockGemini(page, body => ({
            text: "うんうん。どんな感じがしました？",
            checkpoints_filled: ["temperature", "unknown", "impression", "impression"],
            is_done: false
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
                is_done: false
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
                is_done: false
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

    test("specific interesting example gets a delayed bridge toward practical", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_DELAYED_CONTINUATION_MS__ = 100;
        });
        const geminiCalls = await mockGemini(page, (body, callCount) => {
            if (callCount === 1) {
                return {
                    text: "へえー、主体性があるように聞こえる感じですね。",
                    checkpoints_filled: [],
                    is_done: false
                };
            }
            expect(body.userText).toContain("内部指示");
            expect(body.systemPrompt).toContain("今回の追加発話");
            return {
                text: "仕事で使う場面でも、そこはちょっと気になりそうですか？",
                checkpoints_filled: [],
                is_done: false
            };
        });
        await startInterview(page);

        let reply = await sendAndReadReply(page, "私もその色は好きとか、主体性のある発言をすることがあるらしい。意志があるみたい");
        expect(reply).toContain("主体性");
        expect(reply).not.toContain("仕事で使う場面");
        expect(reply).not.toContain("こわ");
        expect(reply).not.toContain("違和感");
        expect(geminiCalls[0].systemPrompt).toContain("少し間を置いて自然に橋をかける例");

        await waitForAiTextChange(page, reply);
        reply = await readLastAiText(page);
        expect(reply).toContain("仕事で使う場面");
        expect(geminiCalls).toHaveLength(2);
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
                        is_done: false
                    }),
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

    test("delayed continuation with no reply eventually closes the conversation", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_DELAYED_CONTINUATION_MS__ = 50;
            window.__SOKRA_IDLE_CLOSING_MS__ = 1200;
        });
        await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    text: "へえー、主体性があるように聞こえる感じですね。",
                    checkpoints_filled: [],
                    is_done: false
                };
            }
            return {
                text: "仕事で使う場面でも、そこはちょっと気になりそうですか？",
                checkpoints_filled: [],
                is_done: false
            };
        });
        await startInterview(page);

        await sendMessage(page, "私もその色は好きとか、主体性のある発言をすることがあるらしい。意志があるみたい");

        await expect
            .poll(async () => await readLastAiText(page), {
                message: "delayed continuation should appear"
            })
            .toContain("仕事で使う場面");

        let reply = await readLastAiText(page);
        await waitForAiTextChange(page, reply);
        reply = await readLastAiText(page);
        expect(reply).toContain("無理に思い出さなくて大丈夫");
        await expect(page.locator(".closing-action")).toBeVisible();
        await expect(page.locator("#endedNote")).toBeHidden();

        const { events } = await currentSession(page);
        const lastAiEvent = [...events].reverse().find(event => event.role === "ai");
        expect(lastAiEvent?.type).toBe("idle_closing_message");
        expect(lastAiEvent?.source_type).toBe("delayed_continuation");
    });

    test("low-energy answer can end via Gemini is_done without all checkpoints", async ({ page }) => {
        await mockGemini(page);
        await startInterview(page);

        let reply = await sendAndReadReply(page, "特にないです");
        expect(reply).toContain("きっかけ");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("終わりにしましょう");
        await expect(page.locator(".closing-action")).toBeVisible();

        const { events } = await currentSession(page);
        const lastAiEvent = [...events].reverse().find(event => event.role === "ai");
        expect(lastAiEvent.type).toBe("closing_message");
        expect(lastAiEvent.is_done_signal).toBe(true);
    });

    test("ending signal is replaced with a natural bridge toward background when it is still missing", async ({ page }) => {
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    text: "ここまで聞ければ十分そうです。今日はこのあたりで。",
                    checkpoints_filled: ["impression", "practical"],
                    is_done: true
                };
            }
            if (callCount === 2) {
                return {
                    text: "もともとそのへん、少し気になっていて来られた感じでした？",
                    checkpoints_filled: [],
                    is_done: false
                };
            }
            return {
                text: "そうだったんですね。今日はこのあたりで終わりにしましょう。",
                checkpoints_filled: ["background"],
                is_done: true
            };
        });
        await startInterview(page);

        let reply = await sendAndReadReply(page, "文章を整えるデモが印象に残りました。社内の問い合わせ対応でも使えそうでした");
        expect(reply).toContain("気になっていて来られた");
        expect(reply).not.toContain("終わりにしましょう");
        await expect(page.locator("#endedNote")).toBeHidden();
        expect(geminiCalls[1].systemPrompt).toContain("終了前の橋渡し");
        expect(geminiCalls[1].systemPrompt).toContain("ダイレクトに聞かないでください");

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("終わりにしましょう");
        await expect(page.locator(".closing-action")).toBeVisible();

        const { events } = await currentSession(page);
        const bridgeEvent = events.find(event => event.type === "bridge_turn");
        expect(bridgeEvent?.bridge_target).toBe("background");
    });

    test("app-side ending does not show a follow-up question as the final message", async ({ page }) => {
        await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    text: "もともとそのへん、少し気になっていて来られた感じでした？",
                    checkpoints_filled: ["impression", "practical"],
                    is_done: true
                };
            }
            return {
                text: "業務で何かAIに関わる部分があったりするんですか？",
                checkpoints_filled: ["background"],
                is_done: false
            };
        });
        await startInterview(page);

        let reply = await sendAndReadReply(page, "文章を整えるデモが印象に残りました。社内の問い合わせ対応でも使えそうでした");
        expect(reply).toContain("関わる部分");
        await expect(page.locator("#endedNote")).toBeHidden();

        reply = await sendAndReadReply(page, "社内で案内があったので来ました");
        expect(reply).toContain("だいたい雰囲気はつかめました");
        expect(reply).not.toContain("関わる部分");
        await expect(page.locator(".closing-action")).toBeVisible();

        const { events } = await currentSession(page);
        const lastAiEvent = [...events].reverse().find(event => event.role === "ai");
        expect(lastAiEvent?.type).toBe("closing_message");
        expect(lastAiEvent?.closing_reason).toBe("core_done");
    });

    test("meta complaint stops without sending that turn to Gemini", async ({ page }) => {
        const geminiCalls = await mockGemini(page);
        await startInterview(page);

        let reply = await sendAndReadReply(page, "資料作成のデモかな");
        expect(reply).toContain("仕事や普段");
        expect(geminiCalls).toHaveLength(1);

        reply = await sendAndReadReply(page, "会話が噛み合ってません");
        expect(reply).toContain("噛み合っていない");
        await expect(page.locator("#endedNote")).toBeVisible();
        expect(geminiCalls).toHaveLength(1);

        const { events } = await currentSession(page);
        expect([...events].reverse().find(event => event.role === "ai")?.type).toBe("conversation_mismatch_guard");
    });
});
