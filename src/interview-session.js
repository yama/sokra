import { CONTEXT_QUESTIONS, createCheckpoints } from "../interview-flow.js";
import { startServerSession, pushSessionEvent, getSessionId, getSessionLog, getPersistenceError } from "./session.js";
import { generateInterviewTurn, getUsageSummary } from "./gemini.js";
import {
    addMessage, speak, withTypingUntilMessage, removeTyping,
    showComposer, hideComposer, waitForChoice,
    renderChecklist, renderClosingAction, removeClosingAction,
    setSessionEndedNote, renderUsageStats
} from "./ui.js";

const SILENCE_TIMER_MS = window.__SOKRA_SILENCE_MS__ || 8000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PHASES = { START: "start", BUTTONS: "buttons", CHAT: "chat", CLOSING: "closing", ENDED: "ended" };

export class InterviewSession {
    constructor() {
        this.model = "";
        this.sessionContext = { format: null, timing: null, mood: null };
        this.checkpoints = createCheckpoints();
        this._phase = PHASES.START;
        this._lastUserMessage = "";
        this._silenceTimer = null;
        this._silenceToken = 0;
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

    // --- Silence timer ---

    pauseSilenceTimer() {
        this._silenceToken++;
        if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    }

    resumeSilenceTimer() {
        this.pauseSilenceTimer();
        if (this._phase !== PHASES.CHAT) return;
        const token = this._silenceToken;
        this._silenceTimer = setTimeout(() => { this._silenceTimer = null; this._onSilence(token); }, SILENCE_TIMER_MS);
    }

    async _onSilence(token) {
        if (token !== this._silenceToken || this._phase !== PHASES.CHAT) return;
        const input = document.getElementById("userInput");
        if (input?.value.trim()) return;

        const silencePrompt = "内部指示: ユーザーが沈黙中です。会話として十分な内容があれば is_done: true にしてください。";
        try {
            const turn = await withTypingUntilMessage(() =>
                generateInterviewTurn(silencePrompt, {
                    model: this.model,
                    sessionContext: this.sessionContext,
                    checkpoints: this.checkpoints,
                    lastUserMessage: this._lastUserMessage,
                })
            );
            if (token !== this._silenceToken || this._phase !== PHASES.CHAT || input?.value.trim()) {
                removeTyping();
                return;
            }
            pushSessionEvent({ role: "internal", text: silencePrompt, type: "silence_trigger" }).catch(() => {});
            await this._speakAndLog(turn.text, { role: "ai", text: turn.text, type: "silence_turn", is_done: turn.is_done });
            turn.is_done ? this._beginClosingPhase() : this.resumeSilenceTimer();
        } catch (e) {
            pushSessionEvent({ role: "system", type: "silence_turn_error", message: e.message }).catch(() => {});
            this.resumeSilenceTimer();
        }
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

    _beginClosingPhase() {
        this.pauseSilenceTimer();
        this._phase = PHASES.CLOSING;
        renderClosingAction(() => this._concludeSession({ logEvent: { role: "system", type: "session_completed_by_user" } }));
    }

    async _concludeSession({ logEvent } = {}) {
        if (this._phase === PHASES.ENDED) return;
        this._phase = PHASES.ENDED;
        this.pauseSilenceTimer();
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
        if (!text.trim() || !this.isActive()) return;
        this.pauseSilenceTimer();
        this._lastUserMessage = text.trim();
        addMessage("user", text);
        document.getElementById("sendBtn").disabled = true;
        try {
            await pushSessionEvent({ role: "user", text });
            const context = {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: this._phase === PHASES.CLOSING,
            };
            const turn = await withTypingUntilMessage(() => generateInterviewTurn(this._lastUserMessage, context));
            if (!this.isActive()) { removeTyping(); return; }
            this.markCheckpoints(turn.checkpoints_filled);
            await this._speakAndLog(turn.text, {
                role: "ai", text: turn.text, type: "generated_turn",
                answered_checkpoints: turn.checkpoints_filled, is_done: turn.is_done,
            });
            if (turn.is_done && this._phase === PHASES.CHAT) {
                this._beginClosingPhase();
            } else if (!turn.is_done) {
                this.resumeSilenceTimer();
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
        this.pauseSilenceTimer();
        this._lastUserMessage = "";
        const openingText = "今日はありがとうございました。印象に残っていることがあれば、そこから聞かせてください。";
        await this._speakAndLog(openingText, { role: "ai", text: openingText, type: "start_chat_opening" });
        this.resumeSilenceTimer();
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
