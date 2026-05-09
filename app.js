let MODEL_NAME = "gemini-2.5-flash";
let SESSION_ID = null;
const FLOW = window.SokraInterviewFlow;
const CHECKPOINTS = FLOW.CHECKPOINTS;

let sessionContext = { format: null, timing: null, mood: null };
let checkpoints = FLOW.createCheckpoints();
let sessionLog = [];
let usageSummary = {
    requests: 0,
    retries: 0,
    fallbacks: 0,
    startFallbacks: 0,
    chatFallbacks: 0
};
let followUpTimer = null;
let isWaitingForUser = false;
let followUpStep = 0;
let lastTypingAt = 0;
let lastUserMessage = "";
let lastAiMessage = "";
let userResists = false;
let activeCheckpointId = "impression";
let interviewStep = "impression";
let interviewStepStage = "entry";
let softCloseAfterBackground = false;
let lastCompletedCheckpointId = "";
let lastContentCheckpointId = "";
let eventSeq = 0;
let persistQueue = Promise.resolve();
let logPersistenceError = "";

const FOLLOW_UP_DELAYS_MS = [40000];
const FOLLOW_UP_TYPING_MS = 900;
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
    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "msg ai"; div.id = "typing";
    div.innerHTML = `<div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    msgs.appendChild(div); scrollDown();
}
function removeTyping() { const t = document.getElementById("typing"); if (t) t.remove(); }

function clearFollowUpTimer() {
    if (followUpTimer) {
        clearTimeout(followUpTimer);
        followUpTimer = null;
    }
}

function resetFollowUpSequence() {
    followUpStep = 0;
}

function clearUserResistance() {
    userResists = false;
}

function syncActiveCheckpoint() {
    activeCheckpointId = FLOW.syncActiveCheckpoint(checkpoints, activeCheckpointId);
}

function setInterviewStep(step, stage = "entry") {
    interviewStep = step;
    interviewStepStage = stage;
    activeCheckpointId = FLOW.checkpointForStep(step);
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
    lastAiMessage = text;
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

    if (options.usage) {
        updateUsageStats(options.usage);
    }

    if (options.resetFollowUp) {
        resetFollowUpSequence();
    }

    if (options.scheduleFollowUp) {
        scheduleFollowUp();
    }
}

async function postAiPrompt(text, choices, onSelect) {
    await postAiMessage(text);
    await sleep(400);
    await waitForUserTypingToSettle();
    showChoices(choices, onSelect);
}

function currentTopic() {
    return FLOW.currentTopic(checkpoints, activeCheckpointId);
}

function topicFollowUpOptions(topic) {
    switch (topic) {
        case "impression":
            return [
                "その話で残っていることがあれば、もう一言だけ聞かせてください。",
                "その場面で覚えていることがあれば、少しだけでも聞かせてください。",
                "その話の続きで、思い出せることがあれば一言だけ聞かせてください。"
            ];
        case "background":
            return [
                "来たきっかけの話で、もう少しだけあれば聞かせてください。",
                "その流れで来た理由に触れられることがあれば、一言だけ聞かせてください。",
                "その話の続きで、来てみようと思った理由があれば少しだけ聞かせてください。"
            ];
        case "difficulty":
            return [
                "引っかかったところがあれば、その部分だけ聞かせてください。",
                "その話で少しでも気になった点があれば、そこだけでも聞かせてください。",
                "言いにくくなければ、引っかかったところを一言だけ聞かせてください。"
            ];
        case "practical":
            return [
                "その話で、仕事や普段のことにつながる点があれば一言だけ聞かせてください。",
                "その流れで思い浮かぶ使いどころがあれば、少しだけでも聞かせてください。",
                "その話の続きで、実際に使えそうと思った場面があれば一言だけ聞かせてください。"
            ];
        default:
            return [];
    }
}

function buildFollowUpMessage() {
    if (userResists) {
        return "ここまででも十分です。最後に一言あればどうぞ。";
    }
    const lowEnergy = FLOW.isLowEnergyReply(lastUserMessage);
    const topic = currentTopic();
    const options = topic
        ? topicFollowUpOptions(topic)
        : [
            lowEnergy ? "ここまででも十分です。もし最後に一言だけあればどうぞ。" : "思い出せることが少しでもあれば、その話だけ聞かせてください。",
            lowEnergy ? "無理に広げなくて構いません。別の話が少しでもあれば、それを聞かせてください。" : "うまくまとまっていなくても、そのまま聞かせてください。",
            "ここまででも十分です。何か付け足したいことがあれば一言だけどうぞ。"
        ];
    return options[Math.floor(Math.random() * options.length)];
}

function emitFollowUpMessage() {
    if (!isWaitingForUser || allDone() || followUpStep >= FOLLOW_UP_DELAYS_MS.length || userResists) return;

    const text = buildFollowUpMessage();
    showTyping();
    followUpTimer = setTimeout(async () => {
        removeTyping();
        if (!isWaitingForUser || allDone()) return;
        addMessage("ai", text);
        try {
            await pushSessionEvent({ role: "ai", text, type: "follow_up" });
        } catch {
            return;
        }
        followUpStep += 1;
        scheduleFollowUp();
    }, FOLLOW_UP_TYPING_MS);
}

function scheduleFollowUp() {
    clearFollowUpTimer();
    if (allDone() || followUpStep >= FOLLOW_UP_DELAYS_MS.length || userResists) return;

    isWaitingForUser = true;
    const delay = FOLLOW_UP_DELAYS_MS[followUpStep];
    followUpTimer = setTimeout(() => {
        const input = document.getElementById("userInput");
        if (!isWaitingForUser || !input || allDone()) return;

        if (input.value.trim()) {
            scheduleFollowUp();
            return;
        }

        emitFollowUpMessage();
    }, delay);
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

function markCheckpoints(ids, options = {}) {
    ids.forEach(id => {
        const cp = checkpoints.find(c => c.id === id);
        if (cp && !cp.done) {
            cp.done = true;
            lastCompletedCheckpointId = id;
            if (id !== "background" && id !== "temperature") {
                lastContentCheckpointId = id;
            }
        }
    });
    if (typeof options.nextActiveId === "string") {
        activeCheckpointId = options.nextActiveId;
    } else if (!options.skipSync) {
        syncActiveCheckpoint();
    }
    updateChecklist();
}

function allDone() { return checkpoints.every(c => c.done); }

function formatInt(n) { return Number(n || 0).toLocaleString("ja-JP"); }
function updateUsageStats() {
    const el = document.getElementById("usageStats");
    if (!el) return;
    el.classList.toggle("error", Boolean(logPersistenceError));
    const lines = [
        "会話制御: ローカル",
        `生成補助モデル: ${MODEL_NAME}（通常経路では未使用）`,
        `セッションID: ${SESSION_ID || "-"}`,
        `外部生成リクエスト: ${formatInt(usageSummary.requests)}回`,
        `再試行: ${formatInt(usageSummary.retries)}回 / fallback: ${formatInt(usageSummary.fallbacks)}回（start ${formatInt(usageSummary.startFallbacks)} / chat ${formatInt(usageSummary.chatFallbacks)}）`
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
    isWaitingForUser = false;
    clearFollowUpTimer();
    removeTyping();
    lastUserMessage = text.trim();
    const userSignal = FLOW.getUserSignal(lastUserMessage);
    userResists = userSignal !== "none";
    const previousStep = interviewStep;
    const lowEnergyAnswer = FLOW.isLowEnergyReply(lastUserMessage);
    addMessage("user", text);
    document.getElementById("sendBtn").disabled = true;
    try {
        await pushSessionEvent({ role: "user", text });
        if (userSignal !== "none") {
            const aiText = FLOW.buildResistanceResponse(userSignal);
            await postAiMessage(aiText, {
                logEvent: { role: "ai", text: aiText, type: "resistance_guard", signal: userSignal },
                resetFollowUp: true,
                scheduleFollowUp: false
            });
            setTimeout(endSession, 400);
            document.getElementById("sendBtn").disabled = false;
            return;
        }

        if (FLOW.isMetaConversationReply(lastUserMessage)) {
            const closingText = FLOW.buildMetaConversationClosing();
            await postAiMessage(closingText, {
                logEvent: { role: "ai", text: closingText, type: "conversation_mismatch_guard" },
                addToHistory: true,
                resetFollowUp: true,
                scheduleFollowUp: false
            });
            setTimeout(endSession, 400);
            document.getElementById("sendBtn").disabled = false;
            return;
        }

        const answeredCheckpointIds = FLOW.detectAnsweredCheckpoints(lastUserMessage, previousStep);
        if (answeredCheckpointIds.length) {
            markCheckpoints(answeredCheckpointIds, { skipSync: true });
        }

        const nextStep = FLOW.chooseNextStep(
            { checkpoints, interviewStepStage, softCloseAfterBackground },
            answeredCheckpointIds,
            previousStep,
            { lowEnergy: lowEnergyAnswer }
        );
        softCloseAfterBackground = nextStep.softCloseAfterBackground;
        setInterviewStep(nextStep.step, nextStep.stage);

        const aiText = nextStep.step
            ? FLOW.buildPlannedTurn(answeredCheckpointIds, nextStep, { lowEnergy: lowEnergyAnswer, lastCompletedCheckpointId })
            : FLOW.buildClosingMessage(lastCompletedCheckpointId, lastContentCheckpointId);
        const eventType = nextStep.step ? "planned_turn" : "closing_message";

        await postAiMessage(aiText, {
            logEvent: {
                role: "ai",
                text: aiText,
                type: eventType,
                answered_checkpoints: answeredCheckpointIds,
                next_step: nextStep.step || "done",
                next_stage: nextStep.stage
            },
            addToHistory: true,
            resetFollowUp: true,
            scheduleFollowUp: Boolean(nextStep.step)
        });

        if (!nextStep.step || allDone()) setTimeout(endSession, 500);
    } catch (e) {
        removeTyping();
        pushSessionEvent({
            role: "system",
            type: "ui_action_error",
            message: e.message,
            details: e.details || e.message
        }).catch(() => { });
        await postAiMessage("処理が止まりました。ここでいったん終了します。", {
            logEvent: { role: "ai", text: "処理が止まりました。ここでいったん終了します。", type: "ui_failure_abort" },
            allowLogFailure: true,
            addToHistory: true,
            resetFollowUp: true,
            scheduleFollowUp: false
        });
        setTimeout(endSession, 400);
    } finally {
        document.getElementById("sendBtn").disabled = false;
    }
}

function endSession() {
    isWaitingForUser = false;
    clearFollowUpTimer();
    resetFollowUpSequence();
    document.getElementById("inputArea").style.display = "none";
    document.getElementById("endedNote").style.display = "block";
    document.getElementById("logBtn").style.display = "inline-block";
}

// --- チャット開始 ---
async function startChatPhase() {
    document.getElementById("inputArea").style.display = "flex";
    clearUserResistance();
    setInterviewStep("impression", "entry");
    softCloseAfterBackground = false;
    lastCompletedCheckpointId = "temperature";
    lastContentCheckpointId = "";
    const openingText = FLOW.buildOpeningMessage(sessionContext);
    await postAiMessage(openingText, {
        logEvent: { role: "ai", text: openingText, type: "start_chat_opening" },
        addToHistory: true,
        resetFollowUp: true,
        scheduleFollowUp: true
    });
}

// --- ボタン選択フェーズ ---
async function runButtonPhase() {
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
        await startServerSession();
        document.getElementById("startScreen").style.display = "none";
        document.getElementById("mainScreen").style.display = "flex";
        updateChecklist();
        updateUsageStats();
        await pushSessionEvent({
            role: "system",
            type: "session_started",
            model: MODEL_NAME,
            generation_mode: "local_interview_flow"
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
        scheduleFollowUp();
    } else {
        scheduleFollowUp();
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
