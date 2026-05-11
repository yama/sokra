const USER_TYPING_SETTLE_MS = 2500;
const STREAM_CHAR_MS = 35;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let typingIndicator = null;
let typingStartedAt = 0;
let lastTypingAt = 0;

export function onUserTypingInput() {
    lastTypingAt = Date.now();
}

function scrollDown() {
    setTimeout(() => {
        const el = document.getElementById("messages");
        el.scrollTop = el.scrollHeight;
    }, 50);
}

export function addMessage(role, text) {
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
    div.innerHTML = `<div class="typing" role="status" aria-label="AIが入力中"><div class="dot" aria-hidden="true"></div><div class="dot" aria-hidden="true"></div><div class="dot" aria-hidden="true"></div></div>`;
    msgs.appendChild(div);
    typingIndicator = div;
    typingStartedAt = Date.now();
    scrollDown();
}

async function holdTyping(minMs) {
    if (!typingIndicator) return;
    const elapsed = Date.now() - typingStartedAt;
    if (elapsed < minMs) await sleep(minMs - elapsed);
}

export function removeTyping() {
    if (typingIndicator) { typingIndicator.remove(); typingIndicator = null; }
    typingStartedAt = 0;
}

function isUserTyping() {
    const input = document.getElementById("userInput");
    return Boolean(input?.value.trim()) && (Date.now() - lastTypingAt < USER_TYPING_SETTLE_MS);
}

async function waitForUserTypingToSettle() {
    while (isUserTyping()) await sleep(400);
}

export async function withTypingUntilMessage(task) {
    showTyping();
    try {
        return await task();
    } catch (e) {
        removeTyping();
        throw e;
    }
}

function streamDelay(char) {
    const jitter = Math.random() * 12;
    if ('。！？!?'.includes(char)) return STREAM_CHAR_MS + jitter + 120 + Math.random() * 80;
    if ('、，,'.includes(char)) return STREAM_CHAR_MS + jitter + 40 + Math.random() * 30;
    return STREAM_CHAR_MS + jitter;
}

async function streamMessage(role, text) {
    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    div.appendChild(bubble);
    msgs.appendChild(div);
    if (prefersReducedMotion()) {
        bubble.textContent = text;
        msgs.scrollTop = msgs.scrollHeight;
    } else {
        for (let i = 0; i < text.length; i++) {
            bubble.textContent += text[i];
            if (i % 8 === 0) msgs.scrollTop = msgs.scrollHeight;
            await sleep(streamDelay(text[i]));
        }
        msgs.scrollTop = msgs.scrollHeight;
    }
    return div;
}

export async function speak(text, { minTypingMs = 450 } = {}) {
    await waitForUserTypingToSettle();
    showTyping();
    await holdTyping(minTypingMs);
    removeTyping();
    await streamMessage("ai", text);
}

export async function waitForChoice(prompt, choices) {
    await speak(prompt);
    await sleep(400);

    return new Promise(resolve => {
        const msgs = document.getElementById("messages");
        const lastAI = [...msgs.querySelectorAll(".msg.ai")].pop();
        const wrap = document.createElement("div");
        wrap.className = "choices";
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", "選択肢");
        choices.forEach(c => {
            const btn = document.createElement("button");
            btn.className = "choice-btn";
            btn.textContent = c.label;
            btn.onclick = () => {
                wrap.querySelectorAll(".choice-btn").forEach(b => b.disabled = true);
                resolve(c);
            };
            wrap.appendChild(btn);
        });
        lastAI.appendChild(wrap);
        scrollDown();
    });
}

export function showComposer() { document.getElementById("inputArea").style.display = "flex"; }
export function hideComposer() { document.getElementById("inputArea").style.display = "none"; }

export function renderChecklist(checkpoints) {
    document.getElementById("checkItems").innerHTML = checkpoints
        .map(c => `<div class="check-item ${c.done ? "done" : ""}">${c.label}</div>`)
        .join("");
    document.getElementById("progressDots").innerHTML = checkpoints
        .map(c => `<div class="progress-dot ${c.done ? "done" : ""}" aria-hidden="true"></div>`)
        .join("");
}

let closingActionNode = null;

export function renderClosingAction(onFinish) {
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
    btn.addEventListener("click", onFinish);
    card.append(hint, btn);
    row.appendChild(card);
    msgs.appendChild(row);
    closingActionNode = row;
    scrollDown();
}

export function removeClosingAction() {
    if (closingActionNode) { closingActionNode.remove(); closingActionNode = null; }
}

export function setSessionEndedNote(text = "") {
    const note = document.getElementById("endedNote");
    if (!note) return;
    note.textContent = text;
    note.style.display = text ? "block" : "none";
}

export function renderUsageStats({ model, sessionId, usageSummary, persistenceError }) {
    const el = document.getElementById("usageStats");
    if (!el) return;
    el.classList.toggle("error", Boolean(persistenceError));
    const fmt = n => Number(n || 0).toLocaleString("ja-JP");
    const lines = [
        "会話制御: Gemini 委任",
        `生成モデル: ${model}`,
        `セッションID: ${sessionId || "-"}`,
        `外部生成リクエスト: ${fmt(usageSummary.requests)}回`,
        `再試行: ${fmt(usageSummary.retries)}回`,
        `トークン: prompt ${fmt(usageSummary.promptTokens)} / output ${fmt(usageSummary.outputTokens)} / total ${fmt(usageSummary.totalTokens)}`
    ];
    if (persistenceError) lines.push(`ログ保存エラー: ${persistenceError}`);
    el.replaceChildren(...lines.map(line => {
        const row = document.createElement("div");
        row.textContent = line;
        return row;
    }));
}
