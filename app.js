let MODEL_NAME = "gemini-2.5-flash";
let SESSION_ID = null;
const FLOW = window.SokraInterviewFlow;
const VALID_CHECKPOINT_IDS = new Set(FLOW.CHECKPOINTS.map(cp => cp.id));
const SILENCE_TIMER_MS = window.__SOKRA_SILENCE_MS__ || 8000;
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
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0
};
let lastTypingAt = 0;
let lastUserMessage = "";
let silenceTimer = null;
let silenceToken = 0;
let typingIndicator = null;
let typingStartedAt = 0;
let sessionPhase = SESSION_PHASES.START;
let eventSeq = 0;
let persistQueue = Promise.resolve();
let logPersistenceError = "";
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

function showComposer() {
    document.getElementById("inputArea").style.display = "flex";
}

function hideComposer() {
    document.getElementById("inputArea").style.display = "none";
}

function isUserTyping() {
    const input = document.getElementById("userInput");
    if (!input) return false;
    if (!input.value.trim()) return false;
    return Date.now() - lastTypingAt < USER_TYPING_SETTLE_MS;
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
        btn.className = "choice-btn";
        btn.textContent = c.label;
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
    lastAI.appendChild(wrap);
    scrollDown();
}

// --- Checklist ---
function updateChecklist() {
    const el = document.getElementById("checkItems");
    el.innerHTML = checkpoints.map(c =>
        `<div class="check-item ${c.done ? "done" : ""}">${c.label}</div>`
    ).join("");

    const dots = document.getElementById("progressDots");
    dots.innerHTML = checkpoints.map(c =>
        `<div class="progress-dot ${c.done ? "done" : ""}"></div>`
    ).join("");
}

function markCheckpoints(ids) {
    ids.forEach(id => {
        const cp = checkpoints.find(c => c.id === id);
        if (cp && !cp.done) cp.done = true;
    });
    updateChecklist();
}

// --- Silence timer ---
function clearSilenceCheck() {
    silenceToken++;
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

function scheduleSilenceCheck() {
    clearSilenceCheck();
    if (sessionPhase !== SESSION_PHASES.CHAT) return;
    const token = silenceToken;
    silenceTimer = setTimeout(() => {
        silenceTimer = null;
        handleSilenceTurn(token);
    }, SILENCE_TIMER_MS);
}

async function handleSilenceTurn(token) {
    if (token !== silenceToken || sessionPhase !== SESSION_PHASES.CHAT) return;
    const input = document.getElementById("userInput");
    if (input?.value.trim()) return;

    const instructionText = "内部指示: ユーザーが沈黙中です。会話として十分な内容があれば is_done: true にしてください。";
    try {
        const turn = await withTypingUntilMessage(() => generateInterviewTurn(instructionText));
        if (token !== silenceToken || sessionPhase !== SESSION_PHASES.CHAT) {
            removeTyping();
            return;
        }
        if (input?.value.trim()) {
            removeTyping();
            return;
        }
        pushSessionEvent({ role: "internal", text: instructionText, type: "silence_trigger" }).catch(() => { });
        await postAiMessage(turn.text, {
            logEvent: { role: "ai", text: turn.text, type: "silence_turn", is_done: turn.is_done }
        });
        if (turn.is_done) {
            transitionToClosing();
        } else {
            scheduleSilenceCheck();
        }
    } catch (e) {
        pushSessionEvent({ role: "system", type: "silence_turn_error", message: e.message }).catch(() => { });
        scheduleSilenceCheck();
    }
}

// --- Closing ---
function removeClosingAction() {
    if (closingActionNode) {
        closingActionNode.remove();
        closingActionNode = null;
    }
}

function renderClosingAction() {
    removeClosingAction();
    const msgs = document.getElementById("messages");
    const row = document.createElement("div");
    row.className = "msg ai closing-action";

    const card = document.createElement("div");
    card.className = "closing-card";

    const hint = document.createElement("div");
    hint.className = "closing-note";
    hint.textContent = "もう話すことがなければ、下のボタンで閉じられます。";

    const btn = document.createElement("button");
    btn.className = "finish-btn";
    btn.type = "button";
    btn.textContent = "会話を終了する";
    btn.addEventListener("click", () => {
        endSession({ logEvent: { role: "system", type: "session_completed_by_user" } });
    });

    card.append(hint, btn);
    row.appendChild(card);
    msgs.appendChild(row);
    closingActionNode = row;
    scrollDown();
}

function transitionToClosing() {
    clearSilenceCheck();
    sessionPhase = SESSION_PHASES.CLOSING;
    renderClosingAction();
}

function setEndedNote(text = "") {
    const note = document.getElementById("endedNote");
    if (!note) return;
    note.textContent = text;
    note.style.display = text ? "block" : "none";
}

async function endSession(options = {}) {
    if (sessionPhase === SESSION_PHASES.ENDED) return;
    sessionPhase = SESSION_PHASES.ENDED;
    clearSilenceCheck();
    removeTyping();
    removeClosingAction();
    hideComposer();
    setEndedNote("話してくれてありがとうございました。");
    document.getElementById("logBtn").style.display = "inline-block";
    if (options.logEvent) {
        try {
            await pushSessionEvent(options.logEvent);
        } catch {
            // ログ失敗は usageStats に表示される。
        }
    }
}

// --- System prompt ---
function formatSeminarContext() {
    return [
        `参加形式: ${sessionContext.format || "未選択"}`,
        `参加タイミング: ${sessionContext.timing || "未選択"}`,
        `温度感: ${sessionContext.mood || "未選択"}`
    ].join("\n");
}

function buildSystemPrompt(retryReason = "", options = {}) {
    const retryInstruction = retryReason
        ? `\n## 直前の応答エラー\n前回の応答は ${retryReason} でした。今回は説明、前置き、コードフェンスを含めず、JSONオブジェクトだけを返してください。\n`
        : "";
    const closingInstruction = options.inClosingPhase
        ? `\n## 終了フェーズ\n参加者には終了ボタンが見えています。追加の発言があれば軽く受け止めてください。新しい話題は始めず、is_done は false にしてください。\n`
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

## 内部指示への対応

userText が「内部指示:」で始まるメッセージは、参加者の発言ではなく運営からの指示です。
指示に従って text と is_done を返してください。

「内部指示: ユーザーが沈黙中」の場合:
- 会話として十分な記録が取れていれば、自然な締めの一言を text に入れて is_done: true にしてください
- まだ続けられる話題や流れがあれば、自然な一言を返して is_done: false にしてください
- 無理に話を引き出そうとしないでください
checkpoints_filled は必ず [] にしてください。

---

## 会話を終わらせるべき場面

以下のいずれかに当てはまれば is_done: true にしてください。

- 会話として十分な記録が取れた
- 参加者が「もう終わりにしたい」「やめたい」「そうしてください」など終了の意思を示した
- 「噛み合っていない」「意味が分からない」「変」などメタな発言があり会話の継続が難しい
- 会話がこれ以上自然に続かないと判断した

is_done: true のとき、text には終わりにふさわしい一言を入れてください（例：「今日はありがとうございました。」）。
自然に拾えなかった論点を埋めるためだけに会話を続けないでください。

---

## 返答フォーマット

必ずJSONで返してください。それ以外のテキストは含めないでください。

{
  "text": "参加者に返す言葉（そのまま表示されます）",
  "checkpoints_filled": ["impression", "practical"],
  "is_done": false
}

checkpoints_filled には、今回の参加者発言で拾えた論点のIDだけを入れてください。なければ [] にしてください。
${closingInstruction}${retryInstruction}`;
}

// --- Gemini API ---
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

function buildConversationHistory() {
    const historyEvents = sessionLog.slice();
    const last = historyEvents[historyEvents.length - 1];
    if (last?.role === "user" && last.text === lastUserMessage) {
        historyEvents.pop();
    }
    return historyEvents
        .filter(e => ["user", "ai", "internal"].includes(e.role) && typeof e.text === "string")
        .map(e => ({
            role: e.role === "ai" ? "assistant" : "user",
            content: e.text
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
                responseMimeType: "application/json"
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

// --- Usage stats ---
function formatInt(n) { return Number(n || 0).toLocaleString("ja-JP"); }

function updateUsageStats() {
    const el = document.getElementById("usageStats");
    if (!el) return;
    el.classList.toggle("error", Boolean(logPersistenceError));
    const lines = [
        "会話制御: Gemini 委任",
        `生成モデル: ${MODEL_NAME}`,
        `セッションID: ${SESSION_ID || "-"}`,
        `外部生成リクエスト: ${formatInt(usageSummary.requests)}回`,
        `再試行: ${formatInt(usageSummary.retries)}回`,
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

// --- Session persistence ---
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

// --- Conversation ---
function isConversationActive() {
    return sessionPhase === SESSION_PHASES.CHAT || sessionPhase === SESSION_PHASES.CLOSING;
}

async function sendUserMessage(text) {
    if (!text.trim() || !isConversationActive()) return;
    clearSilenceCheck();
    lastUserMessage = text.trim();
    addMessage("user", text);
    document.getElementById("sendBtn").disabled = true;
    try {
        await pushSessionEvent({ role: "user", text });
        const options = sessionPhase === SESSION_PHASES.CLOSING ? { inClosingPhase: true } : {};
        const turn = await withTypingUntilMessage(() => generateInterviewTurn(lastUserMessage, options));
        if (!isConversationActive()) {
            removeTyping();
            return;
        }
        markCheckpoints(turn.checkpoints_filled);
        await postAiMessage(turn.text, {
            logEvent: {
                role: "ai",
                text: turn.text,
                type: "generated_turn",
                answered_checkpoints: turn.checkpoints_filled,
                is_done: turn.is_done
            }
        });
        if (turn.is_done && sessionPhase === SESSION_PHASES.CHAT) {
            transitionToClosing();
        } else if (!turn.is_done) {
            scheduleSilenceCheck();
        }
    } catch (e) {
        pushSessionEvent({
            role: "system",
            type: "ai_turn_error",
            message: e.message
        }).catch(() => { });
        await postAiMessage("処理が止まりました。ここでいったん終了します。", {
            logEvent: { role: "ai", text: "処理が止まりました。ここでいったん終了します。", type: "chat_failure_abort" },
            allowLogFailure: true
        });
        await endSession();
    } finally {
        document.getElementById("sendBtn").disabled = false;
    }
}

// --- Start ---
async function startChatPhase() {
    showComposer();
    removeClosingAction();
    setEndedNote("");
    sessionPhase = SESSION_PHASES.CHAT;
    clearSilenceCheck();
    lastUserMessage = "";
    const openingText = "今日はありがとうございました。印象に残っていることがあれば、そこから聞かせてください。";
    await postAiMessage(openingText, {
        logEvent: { role: "ai", text: openingText, type: "start_chat_opening" }
    });
    scheduleSilenceCheck();
}

async function runButtonPhase() {
    sessionPhase = SESSION_PHASES.BUTTONS;
    await sleep(500);
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

// --- Events ---
let isStartingSession = false;

document.getElementById("startBtn").addEventListener("click", async () => {
    if (isStartingSession) return;
    const startBtn = document.getElementById("startBtn");
    isStartingSession = true;
    startBtn.disabled = true;
    try {
        MODEL_NAME = document.getElementById("modelSelect").value;
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
            generation_mode: "gemini_driven"
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
        clearSilenceCheck();
    } else {
        scheduleSilenceCheck();
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
    const a = document.createElement("a");
    a.href = url;
    a.download = "interview_log.json";
    a.click();
    URL.revokeObjectURL(url);
});
