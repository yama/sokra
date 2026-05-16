const { test, expect } = require("@playwright/test");

async function choose(page, label) {
    await page.getByRole("button", { name: label, exact: true }).click();
}

async function sendMessage(page, text) {
    const input = page.locator("#userInput");
    await expect(input).toBeVisible();
    await input.fill(text);
    await expect(page.locator("#sendBtn")).toBeEnabled();
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

async function sendAndWaitForAiBubble(page, text) {
    const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
    const beforeCount = await aiBubbles.count();
    await sendMessage(page, text);
    await expect
        .poll(async () => await aiBubbles.count(), {
            message: "AI bubble count should increase",
            timeout: 15000
        })
        .toBeGreaterThan(beforeCount);
    return await aiBubbles.last().innerText();
}

async function sendAndWaitForAiBubbles(page, text, expectedIncrease) {
    const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
    const beforeCount = await aiBubbles.count();
    await sendMessage(page, text);
    await expect
        .poll(async () => await aiBubbles.count(), {
            message: "AI bubble count should increase by the expected amount",
            timeout: 15000
        })
        .toBeGreaterThanOrEqual(beforeCount + expectedIncrease);
    return aiBubbles;
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

async function currentSession(page, requireEvent = null) {
    const usageText = await page.locator("#usageStats").innerText();
    const sessionMatch = usageText.match(/セッションID: (sess_[^\s]+)/);
    expect(sessionMatch, "session id should be shown in usage stats").not.toBeNull();

    const sessionId = sessionMatch[1];
    const sessionUrl = `/api/session/${sessionId}`;
    let session = null;
    await expect
        .poll(async () => {
            const response = await page.request.get(sessionUrl);
            if (!response.ok()) return null;
            session = await response.json();
            if (requireEvent && !session.events?.some(e => e.type === requireEvent)) return null;
            return session?.session_id || null;
        }, {
            message: "session api should return the saved session",
            timeout: 15000
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
    const readyToClose = coreDone || (lowEnergy && backgroundDone);

    const missing = ["impression", "practical", "background"].find(id =>
        !checkpointsAfter.some(cp => cp.id === id && cp.done)
    );
    const nextText = {
        impression: "あー、なるほど。印象に残っている話があれば、そこから聞かせてください。",
        practical: "へー、そこが面白かったんですね。仕事や普段の場面にもつながりそうですか？",
        background: "ちょっと頭にありますよね。参加したきっかけも、一言だけ聞いてもいいですか？"
    };

    return {
        reactions: readyToClose
            ? ["ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。"]
            : [],
        question: readyToClose
            ? undefined
            : lowEnergy && !backgroundDone
            ? "そうなんですね。無理に広げなくて大丈夫です。参加したきっかけだけ、一言聞いてもいいですか？"
            : nextText[missing] || "ここまで聞かせてもらえれば十分です。今日はこのあたりで終わりにしましょう。",
        checkpoints_filled: filled,
        ready_to_close: readyToClose
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
        expect(geminiCalls[0].systemPrompt).toContain("人柄がよく");
        expect(geminiCalls[0].systemPrompt).toContain("参加者がふざけていてもノリに付き合い");
        expect(geminiCalls[0].systemPrompt).toContain("現在の状態");
        expect(geminiCalls[0].systemPrompt).toContain("論点はノルマではありません");

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("会話制御: Gemini 委任");
        expect(events.filter(event => event.type === "warning")).toEqual([]);
        const firstReadyToCloseTurn = events.find(event =>
            event.role === "ai"
            && event.type === "generated_turn"
            && event.ready_to_close === true
        );
        expect(firstReadyToCloseTurn?.answered_checkpoints).toEqual(["background"]);
        expect(firstReadyToCloseTurn?.ready_to_close).toBe(true);
        expect(events.some(event => event.type === "closing_summary")).toBe(true);
        expect(events.some(event => event.type === "closing_impression_summary")).toBe(true);
        expect(events.some(event => event.type === "closing_guide")).toBe(true);
        expect(events.some(event => event.type === "session_completed_by_user")).toBe(true);
    });

    test("unknown and completed checkpoint ids from Gemini are ignored", async ({ page }) => {
        await mockGemini(page, body => ({
            question: "うんうん。どんな感じがしました？",
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
                question: "うんうん。どんな感じがしました？",
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
                question: "あー、なるほど。印象に残っている話があれば、そこから聞かせてください。",
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
        expect(geminiCalls[0].systemPrompt).toContain("こわさや違和感を前提にした質問をしないでください");
    });

    test("emoji burst can be limited to reaction bubble only", async ({ page }) => {
        await mockGemini(page, () => ({
            reactions: ["豚カツ、ですか！😳😳😳"],
            question: "セミナーの内容で、具体的に豚カツを連想させるような話があったんでしょうか？🍚🍚🍚",
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        const aiBubbles = await sendAndWaitForAiBubbles(page, "豚カツみたいな例えが出てきて面白かったです", 2);
        const bubbleCount = await aiBubbles.count();
        const reaction = await aiBubbles.nth(bubbleCount - 2).innerText();
        const followup = await aiBubbles.nth(bubbleCount - 1).innerText();
        expect(reaction).toContain("😳😳😳");
        expect(followup).toContain("豚カツ");
        expect(followup).not.toContain("🍚");
        expect(followup).not.toContain("😳😳😳");
    });

    test("single short probe waits on single-emoji reaction-only, then short-probe streak can continue with reactions only", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_FOLLOWUP_MS__ = 200;
        });
        const geminiCalls = await mockGemini(page, (_body, callCount) => ({
            reactions: callCount === 1 ? ["😳"] : ["あはは！", "なんだか面白くなってきましたね。"],
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        const firstReply = await sendAndWaitForAiBubble(page, "りんご");
        expect(firstReply).toBe("😳");
        const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
        const beforeWait = await aiBubbles.count();
        await page.waitForTimeout(1200);
        await expect
            .poll(async () => await aiBubbles.count(), {
                message: "single emoji reaction-only should not add a followup bubble",
                timeout: 1500
            })
            .toBe(beforeWait);
        let session = await currentSession(page);
        expect(session.events.some(event => event.type === "followup_question")).toBe(false);

        const beforeSecond = await aiBubbles.count();
        await sendAndWaitForAiBubbles(page, "ぱんだ", 2);
        const afterSecond = await aiBubbles.count();
        expect(afterSecond).toBeGreaterThanOrEqual(beforeSecond + 2);
        const reaction = await aiBubbles.nth(afterSecond - 2).innerText();
        const secondReaction = await aiBubbles.nth(afterSecond - 1).innerText();
        expect(reaction).toBe("あはは！");
        expect(secondReaction).toContain("なんだか面白くなってきましたね");

        session = await currentSession(page);
        expect(session.events.filter(event => event.type === "generated_turn")).toHaveLength(0);
        expect(session.events.filter(event => event.type === "reaction")).toHaveLength(3);
        expect(geminiCalls[1].systemPrompt).toContain("会話モード: playful");
        expect(geminiCalls[1].systemPrompt).toContain("どうにか質問しようとせず、まず相手に合わせてください");
    });

    test("simple kana run can start with a single reaction-only probe", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_FOLLOWUP_MS__ = 200;
        });
        const geminiCalls = await mockGemini(page, () => ({
            reactions: ["😳"],
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        const firstReply = await sendAndWaitForAiBubble(page, "あいうえお");
        expect(firstReply).toBe("😳");
        const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
        const beforeWait = await aiBubbles.count();
        await page.waitForTimeout(1200);
        await expect
            .poll(async () => await aiBubbles.count(), {
                message: "simple kana probe should stay reaction-only without followup",
                timeout: 1500
            })
            .toBe(beforeWait);
        const session = await currentSession(page);
        expect(session.events.some(event => event.type === "followup_question")).toBe(false);
        expect(geminiCalls[0].systemPrompt).toContain("単発の文脈外入力");
    });

    test("playful no-question turn shows choice buttons and can request a normal followup", async ({ page }) => {
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    reactions: ["🍎"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            if (callCount === 2) {
                return {
                    reactions: ["らっぱ"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            return {
                question: "今日のセミナーで印象に残っていることがあれば、そこから聞かせてください。",
                checkpoints_filled: [],
                ready_to_close: false
            };
        });
        await startInterview(page);

        await sendAndWaitForAiBubble(page, "りんご");
        await sendAndWaitForAiBubble(page, "ごりら");

        await expect(page.getByRole("button", { name: "質問して" })).toBeVisible();
        await expect(page.getByRole("button", { name: "このままで" })).toBeVisible();
        await expect(page.getByRole("button", { name: "このくらいで" })).toBeVisible();

        await page.getByRole("button", { name: "質問して" }).click();
        await expect(page.locator(".msg.ai:not([aria-hidden]) .bubble").last()).toContainText("印象に残っていること");
        expect(geminiCalls).toHaveLength(3);
        expect(geminiCalls[2].conversationHistory.some(entry => entry.content.includes("質問して"))).toBe(false);
    });

    test("playful keep choice cancels pending followup", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_FOLLOWUP_MS__ = 200;
        });
        const geminiCalls = await mockGemini(page, () => ({
            reactions: ["🍎"],
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        await sendAndWaitForAiBubble(page, "りんご");
        await expect(page.getByRole("button", { name: "このままで" })).toBeVisible();
        await page.getByRole("button", { name: "このままで" }).click();
        await page.waitForTimeout(800);

        const { events } = await currentSession(page);
        expect(events.some(event => event.type === "followup_question")).toBe(false);
        expect(geminiCalls).toHaveLength(1);
    });

    test("topic switch without question still logs topic_switch", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_EARLY_CLOSE_TURNS__ = 1;
        });
        await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    question: "今日のセミナーで印象に残っていることがあれば、そこから聞かせてください。",
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            return {
                reactions: ["わかりました。"],
                checkpoints_filled: [],
                ready_to_close: false
            };
        });
        await startInterview(page);

        await sendAndWaitForAiBubble(page, "特にないです");
        await page.getByRole("button", { name: "話題を変えて" }).click();

        const { events } = await currentSession(page, "topic_switch");
        expect(events.some(event => event.type === "topic_switch" && !("text" in event))).toBe(true);
    });

    test("single short probe with emoji burst reaction-only schedules a followup", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_FOLLOWUP_MS__ = 200;
        });
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    reactions: ["😳😳😳"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            return {
                question: "その一言、ちょっと気になります。もう少しだけ聞かせてもらえますか？",
                checkpoints_filled: [],
                ready_to_close: false
            };
        });
        await startInterview(page);

        await sendAndWaitForAiBubble(page, "りんご");
        await expect(page.getByRole("button", { name: "質問して" })).toHaveCount(0);
        const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
        const beforeFollowupCount = await aiBubbles.count();
        await expect
            .poll(async () => await aiBubbles.count(), {
                message: "single short probe should continue when reaction-only is not a single emoji",
                timeout: 15000
            })
            .toBeGreaterThan(beforeFollowupCount);

        const { events } = await currentSession(page, "followup_question");
        expect(events.some(event => event.type === "followup_question")).toBe(true);
        expect(geminiCalls).toHaveLength(2);
    });

    test("short-probe streak accepts reactions-only without retry", async ({ page }) => {
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    reactions: ["😳"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            if (callCount === 2) {
                return {
                    reactions: ["🦍！", "なんだか面白くなってきましたね。"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
        });
        await startInterview(page);

        const reactionOnly = await sendAndWaitForAiBubble(page, "りんご");
        expect(reactionOnly).toContain("😳");
        const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
        const beforeSecond = await aiBubbles.count();
        await sendAndWaitForAiBubbles(page, "ぱんだ", 2);
        const afterSecond = await aiBubbles.count();
        expect(afterSecond).toBeGreaterThanOrEqual(beforeSecond + 2);
        expect(await aiBubbles.nth(afterSecond - 2).innerText()).toBe("🦍！");
        expect(await aiBubbles.nth(afterSecond - 1).innerText()).toContain("なんだか面白くなってきましたね");

        const { usageText, events } = await currentSession(page);
        expect(usageText).toContain("再試行: 0回");
        expect(events.some(event => event.type === "ai_turn_retry")).toBe(false);
        expect(geminiCalls).toHaveLength(2);
    });

    test("internal followup retries when reaction-only is returned", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_FOLLOWUP_MS__ = 200;
        });
        const geminiCalls = await mockGemini(page, (_body, callCount) => {
            if (callCount === 1) {
                return {
                    reactions: ["😳😳😳"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            if (callCount === 2) {
                return {
                    reactions: ["あはは！"],
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            return {
                question: "前の言葉をそのまま広げなくて大丈夫です。印象に残ったことがあれば、そこから聞かせてください。",
                checkpoints_filled: [],
                ready_to_close: false
            };
        });
        await startInterview(page);

        await sendAndWaitForAiBubble(page, "りんご");
        const aiBubbles = page.locator(".msg.ai:not([aria-hidden]) .bubble");
        const beforeFollowupCount = await aiBubbles.count();
        await expect
            .poll(async () => await aiBubbles.count(), {
                message: "followup bubble should appear after retrying an invalid reaction-only followup",
                timeout: 15000
            })
            .toBeGreaterThan(beforeFollowupCount);

        const { usageText, events } = await currentSession(page, "followup_question");
        expect(usageText).toContain("再試行: 1回");
        expect(events.some(event => event.type === "ai_turn_retry")).toBe(true);
        expect(events.some(event => event.type === "followup_question")).toBe(true);
        expect(geminiCalls).toHaveLength(3);
    });

    test("abandon timer ends session after prolonged inactivity", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_ABANDON_MS__ = 1000;
        });
        await mockGemini(page, () => ({
            question: "うんうん、なるほど。どんなところが印象に残りましたか？",
            checkpoints_filled: [],
            ready_to_close: false
        }));
        await startInterview(page);

        // ユーザーが応答しなければ abandonタイマーがセッションを終了する
        await expect(page.locator("#endedNote")).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole("button", { name: "もう一度はじめる" })).toBeVisible();
        await expect(page.getByRole("button", { name: "今回は終了" })).toBeVisible();
        const { events } = await currentSession(page, "session_timeout_chat");
        expect(events.some(event => event.type === "session_timeout_chat")).toBe(true);
    });

    test("abandon timer in closing phase records a closing timeout without restart action", async ({ page }) => {
        await page.addInitScript(() => {
            window.__SOKRA_ABANDON_MS__ = 2500;
        });
        await mockGemini(page, body => {
            if (body.requestKind === "closing_summary") {
                return {
                    text: "ここで終わりにして大丈夫です。ありがとうございました。",
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            return {
                reactions: ["今日はこのあたりで大丈夫そうです。"],
                checkpoints_filled: ["impression"],
                ready_to_close: true
            };
        });
        await startInterview(page);

        await sendAndReadReply(page, "社内で案内があったので来ました");
        await expect(page.locator(".closing-action")).toBeVisible();

        await expect(page.locator("#endedNote")).toContainText("終了として記録しました", { timeout: 8000 });
        await expect(page.getByRole("button", { name: "もう一度はじめる" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "今回は終了" })).toHaveCount(0);
        const { events } = await currentSession(page, "session_timeout_closing");
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
                        question: "遅すぎる返答ですか？",
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
        const geminiCalls = await mockGemini(page, (body, callCount) => {
            if (body.requestKind === "closing_summary") {
                return {
                    text: "ゆっくりどうぞ。終わりにするときは下のボタンで終了できます。ありがとうございました。",
                    checkpoints_filled: [],
                    ready_to_close: false
                };
            }
            if (callCount === 1) {
                return {
                    question: "仕事や普段の場面にもつながりそうですか？",
                    checkpoints_filled: ["impression"],
                    ready_to_close: false
                };
            }
            return {
                reactions: ["噛み合っていない感じになってしまいましたね。ここでいったん止めます。"],
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
        expect(geminiCalls[1].systemPrompt).toContain("## クロージング");

        const { events } = await currentSession(page);
        const lastGeneratedTurn = [...events].reverse().find(event => event.role === "ai" && event.type === "generated_turn");
        expect(lastGeneratedTurn?.ready_to_close).toBe(true);
    });
});
