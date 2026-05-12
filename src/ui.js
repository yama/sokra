const USER_TYPING_SETTLE_MS = 2500;
const STREAM_CHAR_MS = 35;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let typingIndicator = null;
let typingStartedAt = 0;
let lastTypingAt = 0;
let closingActionNode = null;
let closingSummaryModalNode = null;
let closingSummaryTextNode = null;
let closingSummaryCloseBtn = null;
let closingSummaryPrimaryCloseBtn = null;
let closingSummaryReturnFocus = null;
let earlyCloseHintButtons = [];
let timeoutActionNode = null;

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
    div.setAttribute("aria-hidden", "true"); // ストリーム中は live region に通知させない
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
    div.removeAttribute("aria-hidden"); // 完了後に公開して全文を一度だけアナウンス
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

export function setDebugPanelVisible(isVisible) {
    const panel = document.getElementById("debugPanel");
    if (!panel) return;
    panel.hidden = !isVisible;
}

export function showEarlyCloseHint(onSwitchTopic, onClose) {
    const el = document.getElementById("earlyCloseHint");
    if (!el || el.children.length) return;
    const mkBtn = (label, cb, { hideOnClick = false } = {}) => {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.type = "button";
        btn.textContent = label;
        btn.addEventListener("click", () => {
            if (hideOnClick) removeEarlyCloseHint();
            Promise.resolve(cb()).catch(() => {});
        });
        earlyCloseHintButtons.push(btn);
        return btn;
    };
    el.append(
        mkBtn("話題を変えて", onSwitchTopic),
        mkBtn("このくらいで", onClose, { hideOnClick: true })
    );
    el.style.display = "flex";
}

export function removeEarlyCloseHint() {
    const el = document.getElementById("earlyCloseHint");
    if (!el) return;
    el.style.display = "none";
    el.innerHTML = "";
    earlyCloseHintButtons = [];
}

export function setEarlyCloseHintDisabled(isDisabled) {
    earlyCloseHintButtons.forEach(btn => {
        btn.disabled = isDisabled;
    });
}

export function renderChecklist(checkpoints) {
    document.getElementById("checkItems").innerHTML = checkpoints
        .map(c => `<div class="check-item ${c.done ? "done" : ""}">${c.label}</div>`)
        .join("");
    document.getElementById("progressDots").innerHTML = checkpoints
        .map(c => `<div class="progress-dot ${c.done ? "done" : ""}" aria-hidden="true"></div>`)
        .join("");
}

function ensureClosingSummaryModal() {
    if (closingSummaryModalNode) return;
    const modal = document.createElement("div");
    modal.className = "summary-modal";
    modal.id = "closingSummaryModal";
    modal.hidden = true;
    modal.innerHTML = `
        <div class="summary-modal__backdrop" data-close-summary-modal="true"></div>
        <div class="summary-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="closingSummaryTitle">
            <button class="summary-modal__icon-close" id="summaryModalIconClose" type="button" aria-label="閉じる">×</button>
            <h2 class="summary-modal__title" id="closingSummaryTitle">聞き手の感想</h2>
            <p class="summary-modal__body" id="closingSummaryText"></p>
            <button class="summary-modal__close-btn" id="summaryModalClose" type="button">閉じる</button>
        </div>
    `;
    document.body.appendChild(modal);
    closingSummaryModalNode = modal;
    closingSummaryTextNode = modal.querySelector("#closingSummaryText");
    closingSummaryCloseBtn = modal.querySelector("#summaryModalIconClose");
    closingSummaryPrimaryCloseBtn = modal.querySelector("#summaryModalClose");
    const close = () => closeClosingSummaryModal();
    closingSummaryCloseBtn.addEventListener("click", close);
    closingSummaryPrimaryCloseBtn.addEventListener("click", close);
    modal.addEventListener("click", event => {
        const target = event.target;
        if (target instanceof HTMLElement && target.dataset.closeSummaryModal === "true") close();
    });
    document.addEventListener("keydown", event => {
        if (!closingSummaryModalNode || closingSummaryModalNode.hidden) return;
        if (event.key === "Escape") {
            close();
            return;
        }
        if (event.key !== "Tab") return;
        const focusables = [...closingSummaryModalNode.querySelectorAll("button")]
            .filter(el => !el.disabled);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
            last.focus();
            event.preventDefault();
        } else if (!event.shiftKey && active === last) {
            first.focus();
            event.preventDefault();
        }
    });
}

export function showClosingSummaryModal(text) {
    ensureClosingSummaryModal();
    closingSummaryReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closingSummaryTextNode.textContent = text;
    closingSummaryModalNode.hidden = false;
    closingSummaryCloseBtn.focus();
}

export function closeClosingSummaryModal() {
    if (!closingSummaryModalNode) return;
    closingSummaryModalNode.hidden = true;
    if (closingSummaryReturnFocus && document.contains(closingSummaryReturnFocus)) {
        closingSummaryReturnFocus.focus();
    }
    closingSummaryReturnFocus = null;
}

export function renderClosingAction(onFinish, onShowSummary) {
    removeClosingAction();
    const msgs = document.getElementById("messages");
    const row = document.createElement("div");
    row.className = "msg ai closing-action";
    const card = document.createElement("div");
    card.className = "closing-card";
    const hint = document.createElement("div");
    hint.className = "closing-note";
    hint.textContent = "もう話すことがなければ、下のボタンで閉じられます。";
    const actions = document.createElement("div");
    actions.className = "closing-actions";
    const summaryBtn = document.createElement("button");
    summaryBtn.className = "finish-btn secondary";
    summaryBtn.type = "button";
    summaryBtn.textContent = "要約を表示する";
    summaryBtn.addEventListener("click", onShowSummary);
    const finishBtn = document.createElement("button");
    finishBtn.className = "finish-btn";
    finishBtn.type = "button";
    finishBtn.textContent = "会話を終了する";
    finishBtn.addEventListener("click", onFinish);
    actions.append(summaryBtn, finishBtn);
    card.append(hint, actions);
    row.appendChild(card);
    msgs.appendChild(row);
    closingActionNode = row;
    scrollDown();
}

export function removeClosingAction() {
    if (closingActionNode) { closingActionNode.remove(); closingActionNode = null; }
    closeClosingSummaryModal();
}

export function renderTimeoutAction({ message, primaryLabel, secondaryLabel, onPrimary, onSecondary }) {
    removeTimeoutAction();
    const msgs = document.getElementById("messages");
    const row = document.createElement("div");
    row.className = "msg ai timeout-action";
    const card = document.createElement("div");
    card.className = "closing-card";
    const hint = document.createElement("div");
    hint.className = "closing-note";
    hint.textContent = message;
    const actions = document.createElement("div");
    actions.className = "closing-actions";

    const primaryBtn = document.createElement("button");
    primaryBtn.className = "finish-btn";
    primaryBtn.type = "button";
    primaryBtn.textContent = primaryLabel;
    primaryBtn.addEventListener("click", onPrimary);

    const secondaryBtn = document.createElement("button");
    secondaryBtn.className = "finish-btn secondary";
    secondaryBtn.type = "button";
    secondaryBtn.textContent = secondaryLabel;
    secondaryBtn.addEventListener("click", onSecondary);

    actions.append(secondaryBtn, primaryBtn);
    card.append(hint, actions);
    row.appendChild(card);
    msgs.appendChild(row);
    timeoutActionNode = row;
    primaryBtn.focus();
    scrollDown();
}

export function removeTimeoutAction() {
    if (!timeoutActionNode) return;
    if (timeoutActionNode.contains(document.activeElement)) {
        const logBtn = document.getElementById("logBtn");
        ((logBtn && logBtn.offsetParent !== null) ? logBtn : document.getElementById("messages"))?.focus();
    }
    timeoutActionNode.remove();
    timeoutActionNode = null;
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
