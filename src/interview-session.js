import { CONTEXT_QUESTIONS, createCheckpoints } from "../interview-flow.js";
import { startServerSession, pushSessionEvent, getSessionId, getSessionLog, getPersistenceError } from "./session.js";
import { generateInterviewTurn, getUsageSummary } from "./gemini.js";
import {
    addMessage, speak, withTypingUntilMessage, removeTyping,
    showComposer, hideComposer, waitForChoice,
    renderChecklist, renderClosingAction, removeClosingAction,
    setSessionEndedNote, renderUsageStats
} from "./ui.js";

const ABANDON_TIMER_MS = window.__SOKRA_ABANDON_MS__ || 5 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PHASES = { START: "start", BUTTONS: "buttons", CHAT: "chat", CLOSING: "closing", ENDED: "ended" };

export class InterviewSession {
    constructor() {
        this.model = "";
        this.sessionContext = { format: null, timing: null, mood: null };
        this.checkpoints = createCheckpoints();
        this._phase = PHASES.START;
        this._lastUserMessage = "";
        this._abandonTimer = null;
        this._abandonToken = 0;
    }

    // --- Stats ---

    refreshStats() {
        renderUsageStats({
            model: this.model,
            sessionId: getSessionId(),
            usageSummary: getUsageSummary(),
            persistenceError: getPersistenceError(),
        });
    }

    // --- Checkpoint tracking ---

    markCheckpoints(ids) {
        ids.forEach(id => {
            const cp = this.checkpoints.find(c => c.id === id);
            if (cp && !cp.done) cp.done = true;
        });
        renderChecklist(this.checkpoints);
    }

    // --- Abandon timer（長時間放置の自動終了） ---

    _stopAbandonTimer() {
        this._abandonToken++;
        if (this._abandonTimer) { clearTimeout(this._abandonTimer); this._abandonTimer = null; }
    }

    _resetAbandonTimer() {
        this._stopAbandonTimer();
        if (this._phase !== PHASES.CHAT && this._phase !== PHASES.CLOSING) return;
        const token = this._abandonToken;
        this._abandonTimer = setTimeout(() => { this._abandonTimer = null; this._onAbandon(token); }, ABANDON_TIMER_MS);
    }

    async _onAbandon(token) {
        if (token !== this._abandonToken || (this._phase !== PHASES.CHAT && this._phase !== PHASES.CLOSING)) return;
        await this._concludeSession({ logEvent: { role: "system", type: "session_timeout" } });
    }

    // --- AI speaking with logging ---

    async _speakAndLog(text, logEvent, { allowLogFailure = false } = {}) {
        await speak(text);
        if (logEvent) {
            try {
                await pushSessionEvent(logEvent);
            } catch (e) {
                if (!allowLogFailure) throw e;
            }
        }
        this.refreshStats();
    }

    // --- Phase transitions ---

    async _beginClosingPhase() {
        this._stopAbandonTimer();
        this._phase = PHASES.CLOSING;
        hideComposer();

        await sleep(500);

        // Message 2: 会話内容を踏まえた個別メッセージ
        const closingPrompt = "内部指示: クロージングメッセージを生成してください。";
        try {
            const turn = await withTypingUntilMessage(() =>
                generateInterviewTurn(closingPrompt, {
                    model: this.model,
                    sessionContext: this.sessionContext,
                    checkpoints: this.checkpoints,
                    lastUserMessage: this._lastUserMessage,
                    inClosingSummary: true,
                })
            );
            if (this._phase === PHASES.CLOSING) {
                await this._speakAndLog(turn.text, {
                    role: "ai", text: turn.text, type: "closing_summary",
                }, { allowLogFailure: true });
            }
        } catch (e) {
            pushSessionEvent({ role: "system", type: "closing_summary_error", message: e.message }).catch(() => {});
        }

        await sleep(400);

        // Message 3: 固定の案内文 + 終了ボタン
        if (this._phase === PHASES.CLOSING) {
            const guideText = "ゆっくりどうぞ。終わりにするときは下のボタンで終了できます。ありがとうございました。";
            await this._speakAndLog(guideText, {
                role: "ai", text: guideText, type: "closing_guide",
            }, { allowLogFailure: true });
            showComposer();
            renderClosingAction(() => this._concludeSession({ logEvent: { role: "system", type: "session_completed_by_user" } }));
            this._resetAbandonTimer();
        }
    }

    async _concludeSession({ logEvent } = {}) {
        if (this._phase === PHASES.ENDED) return;
        this._phase = PHASES.ENDED;
        this._stopAbandonTimer();
        removeTyping();
        removeClosingAction();
        hideComposer();
        setSessionEndedNote("話してくれてありがとうございました。");
        document.getElementById("logBtn").style.display = "inline-block";
        if (logEvent) {
            try { await pushSessionEvent(logEvent); } catch { /* ログ失敗は usageStats に表示される */ }
        }
        this.refreshStats();
    }

    // --- Conversation ---

    isActive() {
        return this._phase === PHASES.CHAT || this._phase === PHASES.CLOSING;
    }

    async onUserMessage(text) {
        const normalizedText = text.trim();
        if (!normalizedText || !this.isActive()) return;
        this._resetAbandonTimer();
        this._lastUserMessage = normalizedText;
        addMessage("user", normalizedText);
        document.getElementById("sendBtn").disabled = true;
        try {
            await pushSessionEvent({ role: "user", text: normalizedText });
            const context = {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: this._phase === PHASES.CLOSING,
            };
            const turn = await withTypingUntilMessage(() => generateInterviewTurn(normalizedText, context));
            if (!this.isActive()) { removeTyping(); return; }
            this.markCheckpoints(turn.checkpoints_filled);
            await this._speakAndLog(turn.text, {
                role: "ai", text: turn.text, type: "generated_turn",
                answered_checkpoints: turn.checkpoints_filled, is_done: turn.is_done,
            });
            if (turn.is_done && this._phase === PHASES.CHAT) {
                this._beginClosingPhase().catch(e => {
                    pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                });
            }
        } catch (e) {
            pushSessionEvent({ role: "system", type: "ai_turn_error", message: e.message }).catch(() => {});
            await this._speakAndLog(
                "処理が止まりました。ここでいったん終了します。",
                { role: "ai", text: "処理が止まりました。ここでいったん終了します。", type: "chat_failure_abort" },
                { allowLogFailure: true }
            );
            await this._concludeSession();
        } finally {
            document.getElementById("sendBtn").disabled = false;
        }
    }

    // --- Session flow ---

    async _beginFreeConversation() {
        showComposer();
        removeClosingAction();
        setSessionEndedNote("");
        this._phase = PHASES.CHAT;
        this._lastUserMessage = "";
        const openingText = "今日はありがとうございました。印象に残っていることがあれば、そこから聞かせてください。";
        await this._speakAndLog(openingText, { role: "ai", text: openingText, type: "start_chat_opening" });
        this._resetAbandonTimer();
    }

    async _collectParticipantContext() {
        this._phase = PHASES.BUTTONS;
        await sleep(500);
        for (let i = 0; i < CONTEXT_QUESTIONS.length; i++) {
            const question = CONTEXT_QUESTIONS[i];
            const choice = await waitForChoice(question.prompt, question.choices);
            this.sessionContext[question.key] = choice.value ?? choice.label;
            addMessage("user", choice.label);
            this._lastUserMessage = choice.label;
            if (question.checkpointId) this.markCheckpoints([question.checkpointId]);
            pushSessionEvent({ role: "user", text: choice.label, type: "button" }).catch(() => {});
            await sleep(i < CONTEXT_QUESTIONS.length - 1 ? 700 : 800);
        }
    }

    async start(model) {
        this.model = model;
        removeClosingAction();
        setSessionEndedNote("");

        await startServerSession(this.model);

        document.getElementById("startScreen").style.display = "none";
        document.getElementById("mainScreen").style.display = "flex";
        document.getElementById("messages").focus();
        renderChecklist(this.checkpoints);
        this.refreshStats();

        await pushSessionEvent({ role: "system", type: "session_started", model: this.model, generation_mode: "gemini_driven" });
        await this._collectParticipantContext();
        await this._beginFreeConversation();
    }

    getLog() {
        return {
            session_id: getSessionId() || ("proto_" + Date.now()),
            model: this.model,
            seminar_context: this.sessionContext,
            checkpoints: this.checkpoints,
            conversation: getSessionLog(),
        };
    }
}
