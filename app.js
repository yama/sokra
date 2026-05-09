let MODEL_NAME = "gemini-2.5-flash";
let SESSION_ID = null;
const FLOW = window.SokraInterviewFlow;
const CHECKPOINTS = FLOW.CHECKPOINTS;
const VALID_CHECKPOINT_IDS = new Set(CHECKPOINTS.map(checkpoint => checkpoint.id));
const CORE_CHECKPOINT_IDS = ["background", "temperature", "impression", "practical"];
const BRIDGEABLE_CHECKPOINT_IDS = ["background"];
const MAX_TURNS_WITHOUT_CHECKPOINT = 10;
const DELAYED_CONTINUATION_MS = window.__SOKRA_DELAYED_CONTINUATION_MS__ || 8000;
const IDLE_CLOSING_MS = window.__SOKRA_IDLE_CLOSING_MS__ || 15000;
const GEMINI_REQUEST_TIMEOUT_MS = window.__SOKRA_GEMINI_TIMEOUT_MS__ || 30000;
const SESSION_PHASES = {
    START: "start",
    BUTTONS: "buttons",
    CHAT: "chat",
    CLOSING: "closing",
    ENDED: "ended"
};

let sessionContext = { format: null, timing: null, mood: null };
let checkpoints = FLOW.createCheckpoints();
let sessionLog = [];
let usageSummary = {
    requests: 0,
    retries: 0,
    fallbacks: 0,
    startFallbacks: 0,
    chatFallbacks: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0
};
let lastTypingAt = 0;
let lastUserMessage = "";
let userResists = false;
let turnsSinceCheckpoint = 0;
let bridgeAttemptCounts = {};
let delayedContinuationTimer = null;
let delayedContinuationToken = 0;
let idleClosingTimer = null;
let idleClosingToken = 0;
let typingIndicator = null;
let typingStartedAt = 0;
let sessionPhase = SESSION_PHASES.START;
let eventSeq = 0;
let persistQueue = Promise.resolve();
let logPersistenceError = "";
let closingContext = null;
let closingActionNode = null;

const USER_TYPING_SETTLE_MS = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- UI helpers ---
function scrollDown() {
    setTimeout(() => {
        const el = document.getElementById("messages");
        el.scrollTop = el.scrollHeight;
    }, 50);
}

function addMessage(role, text) {
    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    div.appendChild(bubble);
    msgs.appendChild(div);
    scrollDown();
    return div;
}

function showTyping() {
    if (typingIndicator) return;

    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "msg ai";
    div.id = "typingIndicator";
    div.innerHTML = `<div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    msgs.appendChild(div);
    typingIndicator = div;
    typingStartedAt = Date.now();
    scrollDown();
}

async function holdTyping(minMs) {
    if (!typingIndicator) return;
    const elapsed = Date.now() - typingStartedAt;
    if (elapsed < minMs) {
        await sleep(minMs - elapsed);
    }
}

function removeTyping() {
    if (typingIndicator) {
        typingIndicator.remove();
        typingIndicator = null;
    }
    typingStartedAt = 0;
}

async function withTypingUntilMessage(task) {
    showTyping();
    try {
        return await task();
    } catch (e) {
        removeTyping();
        throw e;
    }
}

function clearUserResistance() {
    userResists = false;
}

function clearDelayedContinuation() {
    delayedContinuationToken += 1;
    if (delayedContinuationTimer) {
        clearTimeout(delayedContinuationTimer);
        delayedContinuationTimer = null;
    }
}

function clearIdleClosing() {
    idleClosingToken += 1;
    if (idleClosingTimer) {
        clearTimeout(idleClosingTimer);
        idleClosingTimer = null;
    }
}

function isUserTyping() {
    const input = document.getElementById("userInput");
    if (!input) return false;
    if (!input.value.trim()) return false;
    return Date.now() - lastTypingAt < USER_TYPING_SETTLE_MS;
}

function isConversationActive() {
    return sessionPhase === SESSION_PHASES.CHAT || sessionPhase === SESSION_PHASES.CLOSING;
}

function isClosingPhase() {
    return sessionPhase === SESSION_PHASES.CLOSING;
}

function removeClosingAction() {
    if (closingActionNode) {
        closingActionNode.remove();
        closingActionNode = null;
    }
}

function renderClosingAction(text = "") {
    removeClosingAction();
    const msgs = document.getElementById("messages");
    const row = document.createElement("div");
    row.className = "msg ai closing-action";

    const card = document.createElement("div");
    card.className = "closing-card";

    const note = document.createElement("div");
    note.className = "closing-note";
    note.textContent = text;

    const btn = document.createElement("button");
    btn.className = "finish-btn";
    btn.type = "button";
    btn.textContent = "会話を終了する";
    btn.addEventListener("click", async () => {
        await endSession({
            reason: closingContext?.reason || "normal",
            logEvent: {
                role: "system",
                type: "session_completed_by_user",
                closing_reason: closingContext?.reason || "normal"
            }
        });
    });

    card.append(note, btn);
    row.appendChild(card);
    msgs.appendChild(row);
    closingActionNode = row;
    scrollDown();
}

function setEndedNote(text = "") {
    const note = document.getElementById("endedNote");
    if (!note) return;
    note.textContent = text;
    note.style.display = text ? "block" : "none";
}

function showComposer() {
    document.getElementById("inputArea").style.display = "flex";
}

function hideComposer() {
    document.getElementById("inputArea").style.display = "none";
}

async function waitForUserTypingToSettle() {
    while (isUserTyping()) {
        await sleep(400);
    }
}

async function postAiMessage(text, options = {}) {
    await waitForUserTypingToSettle();
    if (options.typing !== false) {
        showTyping();
        await holdTyping(options.typingMinMs ?? 450);
    }
    removeTyping();
    addMessage("ai", text);

    if (options.logEvent) {
        if (options.allowLogFailure) {
            try {
                await pushSessionEvent(options.logEvent);
            } catch {
                // エラー表示は別経路で行うので、終了処理までは継続する。
            }
        } else {
            await pushSessionEvent(options.logEvent);
        }
    }
}

async function postAiPrompt(text, choices, onSelect) {
    await postAiMessage(text);
    await sleep(400);
    await waitForUserTypingToSettle();
    showChoices(choices, onSelect);
}

function showChoices(choices, onSelect) {
    const msgs = document.getElementById("messages");
    const lastAI = [...msgs.querySelectorAll(".msg.ai")].pop();
    if (!lastAI) return;
    const wrap = document.createElement("div");
    wrap.className = "choices";
    choices.forEach(c => {
        const btn = document.createElement("button");
        btn.className = "choice-btn"; btn.textContent = c.label;
        btn.onclick = async () => {
            wrap.querySelectorAll(".choice-btn").forEach(b => b.disabled = true);
            try {
                await onSelect(c);
            } catch (e) {
                wrap.querySelectorAll(".choice-btn").forEach(b => b.disabled = false);
                addMessage("ai", "少し接続が不安定でした。もう一度選んでください。");
                pushSessionEvent({ role: "system", type: "ui_action_error", message: e.message }).catch(() => { });
            }
        };
        wrap.appendChild(btn);
    });
    lastAI.appendChild(wrap); scrollDown();
}

function updateChecklist() {
    const el = document.getElementById("checkItems");
    el.innerHTML = checkpoints.map(c =>
        `<div class="check-item ${c.done ? "done" : ""}">${c.label}</div>`
    ).join("");

    // プログレスドット更新
    const dots = document.getElementById("progressDots");
    dots.innerHTML = checkpoints.map(c =>
        `<div class="progress-dot ${c.done ? "done" : ""}"></div>`
    ).join("");
}

function markCheckpoints(ids) {
    ids.forEach(id => {
        const cp = checkpoints.find(c => c.id === id);
        if (cp && !cp.done) {
            cp.done = true;
        }
    });
    updateChecklist();
}

function allDone() { return checkpoints.every(c => c.done); }

function coreCheckpointsDone() {
    return CORE_CHECKPOINT_IDS.every(id => checkpoints.some(checkpoint => checkpoint.id === id && checkpoint.done));
}

function missingBridgeableCheckpointIds() {
    return BRIDGEABLE_CHECKPOINT_IDS.filter(id =>
        checkpoints.some(checkpoint => checkpoint.id === id && !checkpoint.done)
    );
}

function nextBridgeTarget() {
    return missingBridgeableCheckpointIds().find(id => (bridgeAttemptCounts[id] || 0) < 1) || null;
}

function noteBridgeAttempt(id) {
    if (!id) return;
    bridgeAttemptCounts[id] = (bridgeAttemptCounts[id] || 0) + 1;
}

function checkpointLabel(id) {
    return checkpoints.find(checkpoint => checkpoint.id === id)?.label || id;
}

function bridgeGuidanceFor(id) {
    switch (id) {
        case "background":
            return [
                "参加背景へ向かうときは、「参加背景を教えてください」「なぜ参加したんですか？」のようにダイレクトに聞かないでください。",
                "今までの感想や実務の話の延長で、「もともとそのへん気になってたんですか？」「そういう話、来る前から少し関心あった感じでした？」のように軽く寄せてください。"
            ].join("\n");
        case "practical":
            return "仕事や日常とのつながりへ向かうときは、便利さや使いどころを前提にしすぎず、「使う場面が浮かびました？」「普段だとどこで触れそうですかね」くらいの温度で寄せてください。";
        case "impression":
            return "印象に残った場面へ向かうときは、広すぎる質問に戻さず、今の話題の少し手前にある具体例や場面に寄せてください。";
        default:
            return "";
    }
}

function buildClosingText(reason) {
    switch (reason) {
        case "turn_limit":
            return "このあたりで、だいたい雰囲気はつかめました。もし他に思い出したことがあれば、まだ気軽に書いてください。";
        default:
            return "いろいろ聞かせてもらって、だいたい雰囲気はつかめました。何か思い出したことがあれば、まだ気軽にどうぞ。";
    }
}

function detectClosingReason(turnLimitReached) {
    if (turnLimitReached) return "turn_limit";
    if (allDone()) return "all_done";
    if (coreCheckpointsDone()) return "core_done";
    return "llm_done";
}

function buildIdleClosingText(sourceType) {
    switch (sourceType) {
        case "delayed_continuation":
            return "無理に思い出さなくて大丈夫です。ここでいったん区切りにしておくので、何かあればまだ気軽に書いてください。";
        case "bridge_turn":
            return "ここでは無理に広げなくて大丈夫です。いったんこのへんまでにしておくので、何かあればまだどうぞ。";
        default:
            return "このあたりでいったん十分そうですね。もし他にあれば、まだ気軽に書いてください。";
    }
}

function buildClosingHint(reason) {
    switch (reason) {
        case "turn_limit":
            return "急がなくて大丈夫です。終わるときは下のボタンからどうぞ。";
        default:
            return "もう話すことがなければ、下のボタンで閉じられます。";
    }
}

function buildClosingPhasePrompt() {
    return "追加で思い出したことがあれば、短く受け止めてください。新しい話題は広げず、必要なら軽く相づちして終わりやすい空気を保ってください。checkpoints_filled は自然に拾えたものだけ、is_done は false にしてください。";
}

function buildEndedNoteText(reason) {
    switch (reason) {
        case "turn_limit":
            return "ありがとうございました。ここまでの話を受け取っておきます。";
        case "user_end":
            return "ありがとうございました。ここで会話を閉じました。";
        case "meta_abort":
            return "ここでいったん会話を閉じました。";
        case "failure_abort":
            return "処理を続けられなかったため、ここで会話を閉じました。";
        default:
            return "話してくれてありがとうございました。";
    }
}

function sanitizeCheckpointsFilled(filled, currentCheckpoints) {
    if (!Array.isArray(filled)) return [];
    const seen = new Set();
    return filled.filter(id => {
        if (typeof id !== "string") return false;
        if (seen.has(id)) return false;
        if (!VALID_CHECKPOINT_IDS.has(id)) return false;
        if (!currentCheckpoints.some(cp => cp.id === id && !cp.done)) return false;
        seen.add(id);
        return true;
    });
}

function formatSeminarContext() {
    const entries = [
        `参加形式: ${sessionContext.format || "未選択"}`,
        `参加タイミング: ${sessionContext.timing || "未選択"}`,
        `温度感: ${sessionContext.mood || "未選択"}`
    ];
    return entries.join("\n");
}

function buildSystemPrompt(retryReason = "", options = {}) {
    const retryInstruction = retryReason
        ? `\n## 直前の応答エラー\n前回の応答は ${retryReason} でした。今回は説明、前置き、コードフェンスを含めず、JSONオブジェクトだけを返してください。\n`
        : "";
    const bridgeInstruction = options.bridgeTo
        ? `\n## 終了前の橋渡し\n参加者への返答をすぐ終了にせず、未回収の論点「${checkpointLabel(options.bridgeTo)}」へ自然に寄る一言を返してください。\n次に渡される userText は参加者の発言ではなく内部指示です。\n今までの会話内容を踏まえて、その延長で話しやすそうな話題をひとつだけ差し出してください。\n${bridgeGuidanceFor(options.bridgeTo)}\ncheckpoints_filled は必ず [] にしてください。\nis_done は false にしてください。\n`
        : "";
    const continuationInstruction = options.continuation
        ? `\n## 今回の追加発話\n参加者は直前のあなたの返答から8秒ほどリアクションしていません。\n次に渡される userText は参加者の発言ではなく内部指示です。\n直前のあなたの返答が相づちだけで止まっている場合、短く一言だけ続けてください。\n自然にできるなら、未回収の論点へ軽く橋をかけてください。\n新しい分析やまとめはせず、押し付けがましい質問にしないでください。\ncheckpoints_filled は必ず [] にしてください。\nis_done は false にしてください。\n`
        : "";
    const closingPhaseInstruction = options.closingPhase
        ? `\n## 終了フェーズ\n参加者には、いつでも会話を閉じられるボタンが見えています。\n${buildClosingPhasePrompt()}\n`
        : "";

    return `あなたは、セミナー参加者と雑談しながら感想を聞く聞き手です。

## あなたがいる場面

${formatSeminarContext()}

参加者は今日のセミナーを終えたばかりです。
疲れているかもしれないし、まだ興奮しているかもしれない。

---

## 聞き手としての姿勢

- 感想を「引き出す」より、話しやすい空気を作ることを優先する
- 分析したり、まとめたり、ポジティブに変換したりしない
- 「つまりこういうことですね」のような言い換えをしない
- 毎回質問しなくていい。相づちだけで返すターンを意図的に作る
- ただし、参加者の発言が短く完結していて会話が止まりそうな場合は、相づちだけで止めず自然に次へ進める
- 参加者が具体例や面白がった理由を出した直後は、まず相づちだけで受けてもよい。リアクションがなければ、少し間を置いた追加発話で自然に橋をかける
- 脱線を許容する。少し付き合う
- 短い返答と少し長い返答を混ぜる。テンポを均一にしない
- 相手が先に熱くなるまで、こちらから先に熱くならない
- 「特にない」も有効な答えとして受け止める
- 参加者が面白さや便利さを話している流れで、こわさや違和感を前提にした質問をしない

## 言葉遣い

- 話し言葉、やや砕けた敬語
- 「あー、なるほど。」「うんうん。」のような相づちを自然に使う
- 分析的・評価的な言い回しを避ける
- AIであることを隠さないが、「実際に見た・聞いた」かのような表現はしない

## 質問しないターンの例

参加者:「なんか思ったより難しくて。AIって言葉だけは知ってたんですけど」
あなた:「あー、言葉だけ先に来てる感じ、ありますよね。」

参加者:「でも後半は少し分かってきた気がします」
あなた:「後半で変わったんですね。」

参加者:「仕事でも使えるのかなとは思って」
あなた:「ちょっと頭にありますよね、そういうの。」

## 少し間を置いて自然に橋をかける例

参加者:「『私もその色は好き』って返す話が面白かったです」
あなた:「へえー、主体性があるように聞こえる感じですね。」
少し間を置いた追加発話:「仕事で使う場面でも、そこはちょっと気になりそうですか？」

参加者:「人間みたいなリアクションをするところが印象に残りました」
あなた:「そこ、面白いですよね。」
少し間を置いた追加発話:「普段使うとしたら、その反応の仕方って便利そうですか？」

---

## 拾いたい論点

以下は順番ではなく、あくまで「拾えたらいい」論点です。
会話を無理にここへ誘導しないでください。
論点はノルマではありません。自然に寄れなかった論点が残っても、そのこと自体が「想定外の感想や関心があった」という有効な会話記録になります。

- background  : なぜ参加したか
- temperature : 全体的な印象・温度感（ボタン選択で取得済みの場合あり）
- impression  : 記憶に残っている場面や話
- difficulty  : 参加者の発言に自然に出てきた引っかかり、違和感、難しさ
- practical   : 仕事や日常とのつながり

difficulty は必ず質問して埋める項目ではありません。
面白かった、便利そうだった、楽しそうだったという流れで「こわさはありましたか？」のように聞くと誘導になります。
参加者が自分から「難しかった」「気になる」「ちょっと怖い」「引っかかった」などに触れた場合だけ checkpoints_filled に含めてください。

現在の状態:
${JSON.stringify(checkpoints, null, 2)}

---

## 返答フォーマット

必ずJSONで返してください。それ以外のテキストは含めないでください。

{
  "text": "参加者に返す言葉（そのまま表示されます）",
  "checkpoints_filled": ["impression", "practical"],
  "is_done": false
}

checkpoints_filled には、今回の参加者発言で拾えた論点のIDだけを入れてください。なければ [] にしてください。

is_done を true にするのは以下のいずれかの場合だけです。

- 会話として十分な記録が取れた
- 参加者が終わりたそうにしている
- 会話がこれ以上続かないと判断した

自然に拾えなかった論点を埋めるためだけに会話を続けないでください。
${bridgeInstruction}
${continuationInstruction}
${closingPhaseInstruction}
${retryInstruction}`;
}

function buildConversationHistory() {
    const historyEvents = sessionLog.slice();
    const last = historyEvents[historyEvents.length - 1];
    if (last?.role === "user" && last.text === lastUserMessage) {
        historyEvents.pop();
    }
    return historyEvents
        .filter(event => (event.role === "user" || event.role === "ai") && typeof event.text === "string")
        .map(event => ({
            role: event.role === "ai" ? "assistant" : "user",
            content: event.text
        }));
}

function parseInterviewTurn(rawText) {
    const parsed = JSON.parse(String(rawText || "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not a JSON object");
    }

    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) {
        throw new Error("response.text is required");
    }

    return {
        text,
        checkpoints_filled: sanitizeCheckpointsFilled(parsed.checkpoints_filled, checkpoints),
        is_done: parsed.is_done === true
    };
}

function recordUsage(usage) {
    if (!usage) return;
    usageSummary.promptTokens += Number(usage.promptTokenCount || 0);
    usageSummary.outputTokens += Number(usage.outputTokenCount || 0);
    usageSummary.totalTokens += Number(usage.totalTokenCount || 0);
}

async function requestGeminiInterviewTurn(userText, retryReason = "", options = {}) {
    usageSummary.requests += 1;
    updateUsageStats();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
    let res;
    try {
        res = await fetch("/api/gemini", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model: MODEL_NAME,
                systemPrompt: buildSystemPrompt(retryReason, options),
                conversationHistory: buildConversationHistory(),
                userText,
                responseMimeType: "application/json",
                checkpoints
            })
        });
    } catch (e) {
        if (e?.name === "AbortError") {
            throw new Error(`Gemini API request timed out after ${GEMINI_REQUEST_TIMEOUT_MS}ms`);
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }

    const bodyText = await res.text();
    let data = {};
    try {
        data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
        throw new Error(`Gemini API returned non-JSON response: ${bodyText.slice(0, 120)}`);
    }

    if (!res.ok) {
        throw new Error(data.error || `Gemini API request failed: ${res.status}`);
    }

    recordUsage(data.usage);
    updateUsageStats();
    return String(data.text || "");
}

async function generateInterviewTurn(userText, options = {}) {
    try {
        const raw = await requestGeminiInterviewTurn(userText, "", options);
        return parseInterviewTurn(raw);
    } catch (firstError) {
        usageSummary.retries += 1;
        updateUsageStats();
        pushSessionEvent({
            role: "system",
            type: "ai_turn_retry",
            reason: firstError.message
        }).catch(() => { });

        try {
            const retryRaw = await requestGeminiInterviewTurn(userText, firstError.message, options);
            return parseInterviewTurn(retryRaw);
        } catch (secondError) {
            throw new Error(`Gemini interview turn failed after retry: ${secondError.message}`);
        }
    }
}

function shouldScheduleDelayedContinuation(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    return !/[?？]\s*$/.test(trimmed);
}

async function postDelayedContinuation(token) {
    if (token !== delayedContinuationToken || sessionPhase !== SESSION_PHASES.CHAT || userResists) return;
    if (allDone() || coreCheckpointsDone()) return;

    const input = document.getElementById("userInput");
    if (input?.value.trim()) return;

    try {
        const turn = await withTypingUntilMessage(() => generateInterviewTurn("内部指示: 参加者が8秒ほどリアクションしていません。直前の返答に自然な一言を続けてください。", {
            continuation: true
        }));
        if (token !== delayedContinuationToken || sessionPhase !== SESSION_PHASES.CHAT) {
            removeTyping();
            return;
        }
        if (input?.value.trim()) {
            removeTyping();
            return;
        }

        await postAiMessage(turn.text, {
            logEvent: {
                role: "ai",
                text: turn.text,
                type: "delayed_continuation",
                answered_checkpoints: [],
                delay_ms: DELAYED_CONTINUATION_MS
            }
        });
        scheduleIdleClosing("delayed_continuation");
    } catch (e) {
        pushSessionEvent({
            role: "system",
            type: "delayed_continuation_error",
            message: e.message,
            details: e.details || e.message
        }).catch(() => { });
    }
}

async function maybeBridgeBeforeEnding(turn, answeredCheckpointIds, turnLimitReached) {
    if (allDone() || coreCheckpointsDone()) return false;
    if (!turn.is_done && !turnLimitReached) return false;

    const bridgeTarget = nextBridgeTarget();
    if (!bridgeTarget) return false;

    noteBridgeAttempt(bridgeTarget);
    const bridgeTurn = await withTypingUntilMessage(() => generateInterviewTurn(
        `内部指示: 会話を終える前に、未回収の「${checkpointLabel(bridgeTarget)}」へ自然に寄る一言を返してください。`,
        { bridgeTo: bridgeTarget }
    ));

    await postAiMessage(bridgeTurn.text, {
        logEvent: {
            role: "ai",
            text: bridgeTurn.text,
            type: "bridge_turn",
            bridge_target: bridgeTarget,
            answered_checkpoints: answeredCheckpointIds,
            is_done_signal: turn.is_done,
            turn_limit_reached: turnLimitReached
        }
    });

    scheduleIdleClosing("bridge_turn");
    scheduleDelayedContinuation(bridgeTurn.text);
    return true;
}

async function postIdleClosing(token, sourceType) {
    if (token !== idleClosingToken || sessionPhase !== SESSION_PHASES.CHAT || userResists) return;
    const input = document.getElementById("userInput");
    if (input?.value.trim()) return;

    try {
        const closingText = buildIdleClosingText(sourceType);
        await enterClosingPhase(closingText, {
            type: "idle_closing_message",
            closing_reason: "idle",
            source_type: sourceType,
            idle_ms: IDLE_CLOSING_MS
        });
    } catch (e) {
        pushSessionEvent({
            role: "system",
            type: "idle_closing_error",
            source_type: sourceType,
            idle_ms: IDLE_CLOSING_MS,
            message: e.message,
            details: e.details || e.message
        }).catch(() => { });
    }
}

function scheduleIdleClosing(sourceType) {
    clearIdleClosing();
    if (sessionPhase !== SESSION_PHASES.CHAT || userResists) return;

    const token = idleClosingToken;
    idleClosingTimer = setTimeout(() => {
        idleClosingTimer = null;
        postIdleClosing(token, sourceType);
    }, IDLE_CLOSING_MS);
}

function scheduleDelayedContinuation(text) {
    clearDelayedContinuation();
    if (sessionPhase !== SESSION_PHASES.CHAT || userResists || allDone() || coreCheckpointsDone()) return;
    if (!shouldScheduleDelayedContinuation(text)) return;

    const token = delayedContinuationToken;
    delayedContinuationTimer = setTimeout(() => {
        delayedContinuationTimer = null;
        postDelayedContinuation(token);
    }, DELAYED_CONTINUATION_MS);
}

async function enterClosingPhase(text, eventData = {}) {
    clearDelayedContinuation();
    clearIdleClosing();
    closingContext = {
        reason: eventData.closing_reason || closingContext?.reason || "normal",
        sourceType: eventData.source_type || closingContext?.sourceType || ""
    };
    sessionPhase = SESSION_PHASES.CLOSING;
    await postAiMessage(text, {
        logEvent: {
            role: "ai",
            text,
            ...eventData
        }
    });
    renderClosingAction(buildClosingHint(closingContext.reason));
}

function formatInt(n) { return Number(n || 0).toLocaleString("ja-JP"); }
function updateUsageStats() {
    const el = document.getElementById("usageStats");
    if (!el) return;
    el.classList.toggle("error", Boolean(logPersistenceError));
    const lines = [
        "会話制御: LLM生成 + アプリ側検証",
        `生成モデル: ${MODEL_NAME}`,
        `セッションID: ${SESSION_ID || "-"}`,
        `外部生成リクエスト: ${formatInt(usageSummary.requests)}回`,
        `再試行: ${formatInt(usageSummary.retries)}回 / fallback: ${formatInt(usageSummary.fallbacks)}回（start ${formatInt(usageSummary.startFallbacks)} / chat ${formatInt(usageSummary.chatFallbacks)}）`,
        `トークン: prompt ${formatInt(usageSummary.promptTokens)} / output ${formatInt(usageSummary.outputTokens)} / total ${formatInt(usageSummary.totalTokens)}`
    ];
    if (logPersistenceError) {
        lines.push(`ログ保存エラー: ${logPersistenceError}`);
    }
    el.replaceChildren(
        ...lines.map(line => {
            const row = document.createElement("div");
            row.textContent = line;
            return row;
        })
    );
}

function setLogPersistenceError(message) {
    logPersistenceError = message;
    updateUsageStats();
}

async function startServerSession() {
    const res = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL_NAME, client: "web" })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`セッション開始に失敗しました: ${text}`);
    }
    const data = await res.json();
    SESSION_ID = data.sessionId;
}

async function persistSessionEvent(event) {
    if (!SESSION_ID) return;
    const res = await fetch(`/api/session/${SESSION_ID}/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
        keepalive: true
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`イベント保存に失敗しました: ${res.status} ${text}`);
    }
}

function pushSessionEvent(event) {
    const entry = { seq: ++eventSeq, ...event };
    sessionLog.push(entry);
    const task = persistQueue.then(() => persistSessionEvent(entry));
    persistQueue = task.catch(() => { });
    return task.catch(err => {
        setLogPersistenceError(err.message);
        throw err;
    });
}

// --- 送信 ---
async function sendUserMessage(text) {
    if (!text.trim()) return;
    if (!isConversationActive()) return;
    clearDelayedContinuation();
    clearIdleClosing();
    lastUserMessage = text.trim();
    const userSignal = FLOW.getUserSignal(lastUserMessage);
    userResists = userSignal !== "none";
    addMessage("user", text);
    document.getElementById("sendBtn").disabled = true;
    try {
        await pushSessionEvent({ role: "user", text });
        if (userSignal !== "none") {
            const aiText = FLOW.buildResistanceResponse(userSignal);
            if (userSignal === "end") {
                await enterClosingPhase(aiText, {
                    type: "closing_message",
                    closing_reason: "user_end",
                    signal: userSignal
                });
            } else {
                await postAiMessage(aiText, {
                    logEvent: { role: "ai", text: aiText, type: "resistance_guard", signal: userSignal }
                });
                await endSession({ reason: "user_end" });
            }
            document.getElementById("sendBtn").disabled = false;
            return;
        }

        if (FLOW.isMetaConversationReply(lastUserMessage)) {
            const closingText = FLOW.buildMetaConversationClosing();
            await postAiMessage(closingText, {
                logEvent: { role: "ai", text: closingText, type: "conversation_mismatch_guard" }
            });
            await endSession({ reason: "meta_abort" });
            document.getElementById("sendBtn").disabled = false;
            return;
        }

        const turn = await withTypingUntilMessage(() => generateInterviewTurn(
            lastUserMessage,
            isClosingPhase() ? { closingPhase: true } : {}
        ));
        if (!isConversationActive()) {
            removeTyping();
            return;
        }
        const answeredCheckpointIds = turn.checkpoints_filled;
        if (answeredCheckpointIds.length) {
            markCheckpoints(answeredCheckpointIds);
            turnsSinceCheckpoint = 0;
        } else {
            turnsSinceCheckpoint += 1;
        }

        const turnLimitReached = !isClosingPhase() && turnsSinceCheckpoint >= MAX_TURNS_WITHOUT_CHECKPOINT;
        const shouldEnd = isClosingPhase() || allDone() || coreCheckpointsDone() || turn.is_done || turnLimitReached;
        const closingReason = !shouldEnd
            ? ""
            : isClosingPhase()
            ? (closingContext?.reason || "normal")
            : detectClosingReason(turnLimitReached);
        if (!isClosingPhase() && shouldEnd && await maybeBridgeBeforeEnding(turn, answeredCheckpointIds, turnLimitReached)) {
            return;
        }

        const eventType = shouldEnd ? "closing_message" : "generated_turn";
        const aiText = shouldEnd && !turn.is_done && !isClosingPhase()
            ? buildClosingText(closingReason)
            : turn.text;
        if (shouldEnd) {
            await enterClosingPhase(aiText, {
                type: eventType,
                answered_checkpoints: answeredCheckpointIds,
                is_done_signal: turn.is_done,
                turn_limit_reached: turnLimitReached,
                closing_reason: closingReason
            });
        } else {
            await postAiMessage(aiText, {
                logEvent: {
                    role: "ai",
                    text: aiText,
                    type: eventType,
                    answered_checkpoints: answeredCheckpointIds,
                    is_done_signal: turn.is_done,
                    turn_limit_reached: turnLimitReached,
                    closing_reason: shouldEnd ? closingReason : undefined
                }
            });
            scheduleDelayedContinuation(turn.text);
        }
    } catch (e) {
        pushSessionEvent({
            role: "system",
            type: "ai_turn_error",
            message: e.message,
            details: e.details || e.message
        }).catch(() => { });
        await postAiMessage("処理が止まりました。ここでいったん終了します。", {
            logEvent: { role: "ai", text: "処理が止まりました。ここでいったん終了します。", type: "chat_failure_abort" },
            allowLogFailure: true
        });
        await endSession({ reason: "failure_abort" });
    } finally {
        document.getElementById("sendBtn").disabled = false;
    }
}

async function endSession(options = {}) {
    if (sessionPhase === SESSION_PHASES.ENDED) return;
    sessionPhase = SESSION_PHASES.ENDED;
    closingContext = null;
    removeTyping();
    clearDelayedContinuation();
    clearIdleClosing();
    hideComposer();
    removeClosingAction();
    setEndedNote(buildEndedNoteText(options.reason));
    document.getElementById("logBtn").style.display = "inline-block";
    if (options.logEvent) {
        try {
            await pushSessionEvent(options.logEvent);
        } catch {
            // ログ失敗は usageStats に表示される。
        }
    }
}

// --- チャット開始 ---
async function startChatPhase() {
    showComposer();
    removeClosingAction();
    setEndedNote("");
    sessionPhase = SESSION_PHASES.CHAT;
    clearDelayedContinuation();
    clearIdleClosing();
    clearUserResistance();
    turnsSinceCheckpoint = 0;
    bridgeAttemptCounts = {};
    const openingText = "今日はありがとうございました。印象に残っていることがあれば、そこから聞かせてください。";
    await postAiMessage(openingText, {
        logEvent: { role: "ai", text: openingText, type: "start_chat_opening" }
    });
}

// --- ボタン選択フェーズ ---
async function runButtonPhase() {
    sessionPhase = SESSION_PHASES.BUTTONS;
    await sleep(500);
    clearUserResistance();
    await postAiPrompt(
        "今日はありがとうございました。少しだけ話聞かせてもらえますか？",
        [{ label: "現地参加", value: "現地" }, { label: "オンライン参加", value: "オンライン" }],
        async (c) => {
            await pushSessionEvent({ role: "user", text: c.label, type: "button" });
            sessionContext.format = c.value;
            lastUserMessage = c.label;
            addMessage("user", c.label);
            await sleep(700);
            await postAiPrompt(
                "そうなんですね。仕事終わりでした？",
                [{ label: "仕事終わり", value: "仕事終わり" }, { label: "休日", value: "休日" }, { label: "その他", value: "その他" }],
                async (c2) => {
                    await pushSessionEvent({ role: "user", text: c2.label, type: "button" });
                    sessionContext.timing = c2.value;
                    lastUserMessage = c2.label;
                    addMessage("user", c2.label);
                    await sleep(700);
                    await postAiPrompt(
                        "今日のセミナー、全体的にどうでした？",
                        [
                            { label: "よかった", value: "よかった" },
                            { label: "まあまあ", value: "まあまあ" },
                            { label: "難しかった", value: "難しかった" },
                            { label: "よく分からなかった", value: "よく分からなかった" }
                        ],
                        async (c3) => {
                            await pushSessionEvent({ role: "user", text: c3.label, type: "button" });
                            sessionContext.mood = c3.value;
                            lastUserMessage = c3.label;
                            addMessage("user", c3.label);
                            markCheckpoints(["temperature"]);
                            await sleep(800);
                            await startChatPhase();
                        }
                    );
                }
            );
        }
    );
}

// --- イベント ---
let isStartingSession = false;

document.getElementById("startBtn").addEventListener("click", async () => {
    if (isStartingSession) return;
    const startBtn = document.getElementById("startBtn");
    isStartingSession = true;
    startBtn.disabled = true;
    try {
        MODEL_NAME = document.getElementById("modelSelect").value;
        clearUserResistance();
        removeClosingAction();
        setEndedNote("");
        await startServerSession();
        document.getElementById("startScreen").style.display = "none";
        document.getElementById("mainScreen").style.display = "flex";
        updateChecklist();
        updateUsageStats();
        await pushSessionEvent({
            role: "system",
            type: "session_started",
            model: MODEL_NAME,
            generation_mode: "llm_interview_turn"
        });
        await runButtonPhase();
    } catch (e) {
        document.getElementById("startError").textContent = e.message;
        document.getElementById("startError").style.display = "block";
    } finally {
        isStartingSession = false;
        if (document.getElementById("startScreen").style.display !== "none") {
            startBtn.disabled = false;
        }
    }
});

document.getElementById("sendBtn").addEventListener("click", () => {
    const ta = document.getElementById("userInput");
    const text = ta.value.trim();
    if (text) { ta.value = ""; ta.style.height = "42px"; sendUserMessage(text); }
});

document.getElementById("userInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("sendBtn").click(); }
});

document.getElementById("userInput").addEventListener("input", function () {
    lastTypingAt = Date.now();
    if (this.value.trim()) {
        clearDelayedContinuation();
        clearIdleClosing();
    }
    this.style.height = "42px";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

document.getElementById("logBtn").addEventListener("click", () => {
    const log = {
        session_id: SESSION_ID || ("proto_" + Date.now()),
        model: MODEL_NAME,
        seminar_context: sessionContext,
        usage_summary: usageSummary,
        checkpoints: checkpoints,
        conversation: sessionLog
    };
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "interview_log.json"; a.click();
    URL.revokeObjectURL(url);
});
