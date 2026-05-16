import { CONTEXT_QUESTIONS, createCheckpoints } from "../interview-flow.js";
import { startServerSession, pushSessionEvent, getSessionId, getSessionLog, getPersistenceError } from "./session.js";
import {
    generateInterviewTurn,
    getUsageSummary,
    shouldScheduleFollowupOnReactionOnly,
    shouldWaitOnReactionOnly
} from "./gemini.js";
import {
    addMessage, speak, withTypingUntilMessage, removeTyping,
    showComposer, hideComposer, waitForChoice,
    renderChecklist, renderClosingAction, removeClosingAction,
    renderTimeoutAction, removeTimeoutAction, setSessionEndedNote, renderUsageStats,
    showEarlyCloseHint, removeEarlyCloseHint, setEarlyCloseHintDisabled,
    showClosingSummaryModal,
    showPlayfulHint, removePlayfulHint, setPlayfulHintDisabled
} from "./ui.js";

const ABANDON_TIMER_MS = window.__SOKRA_ABANDON_MS__ || 5 * 60 * 1000;
const FOLLOWUP_DELAY_MS = window.__SOKRA_FOLLOWUP_MS__ || 4000;
const EARLY_CLOSE_TURNS = window.__SOKRA_EARLY_CLOSE_TURNS__ || 5;

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
        this._followupToken = 0;
        this._isBusy = false;
        this._userTurnCount = 0;
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
        if (this._phase === PHASES.CLOSING) {
            await this._concludeSession({
                logEvent: { role: "system", type: "session_timeout_closing" },
                endedNote: "会話を終了として記録しました。ありがとうございました。"
            });
            return;
        }
        await this._concludeSession({
            logEvent: { role: "system", type: "session_timeout_chat" },
            endedNote: "会話が中断されました。ここまでの記録は保存されています。",
            showRestartAction: true
        });
    }

    // --- Follow-up timer（相づちのみで終わったとき問いかけを追加） ---

    _cancelFollowup() {
        this._followupToken++;
    }

    _scheduleFollowup(hasQuestion) {
        if (hasQuestion) return;
        this._cancelFollowup();
        const token = this._followupToken;
        setTimeout(() => this._sendFollowup(token), FOLLOWUP_DELAY_MS);
    }

    _showPlayfulHint() {
        if (this._phase !== PHASES.CHAT) return;
        showPlayfulHint(
            () => this._requestPlayfulFollowup(),
            () => {
                this._cancelFollowup();
                this._resetAbandonTimer();
            },
            () => this._beginClosingPhase().catch(e => {
                pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
            })
        );
    }

    async _requestPlayfulFollowup() {
        if (!this.isActive() || this._isBusy) return;
        removePlayfulHint();
        this._cancelFollowup();
        this._resetAbandonTimer();
        this._isBusy = true;
        document.getElementById("sendBtn").disabled = true;
        setPlayfulHintDisabled(true);
        try {
            await pushSessionEvent({ role: "user", text: "質問して", type: "button" });
            const prompt = "内部指示: 直前までは遊びの流れでした。ここから通常会話へやわらかく戻すため、参加者に負担の少ない短い問いかけを1文だけ送ってください。reactions は空配列にし、question だけを返してください。";
            const context = {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: false,
                forceNormalTurn: true,
                requireQuestion: true,
            };
            const turn = await withTypingUntilMessage(() => generateInterviewTurn(prompt, context));
            if (!this.isActive()) { removeTyping(); return; }
            this.markCheckpoints(turn.checkpoints_filled);
            await this._speakReactions(turn.reactions);
            if (turn.question) {
                await this._speakAndLog(turn.question, {
                    role: "ai", text: turn.question, type: "followup_question",
                    answered_checkpoints: turn.checkpoints_filled, ready_to_close: turn.ready_to_close,
                });
            }
        } catch (e) {
            pushSessionEvent({ role: "system", type: "playful_followup_error", message: e.message }).catch(() => {});
        } finally {
            this._isBusy = false;
            document.getElementById("sendBtn").disabled = false;
            setPlayfulHintDisabled(false);
        }
    }

    async _speakReactions(reactions) {
        for (const reaction of reactions) {
            await this._speakAndLog(reaction, { role: "ai", text: reaction, type: "reaction" });
        }
    }

    async _logTurnWithoutQuestion(type, turn) {
        await pushSessionEvent({
            role: "ai",
            type,
            answered_checkpoints: turn.checkpoints_filled,
            ready_to_close: turn.ready_to_close,
        });
        this.refreshStats();
    }

    async _sendFollowup(token) {
        if (token !== this._followupToken || this._phase !== PHASES.CHAT || this._isBusy) return;
        const input = document.getElementById("userInput");
        if (input?.value.trim()) return;
        this._isBusy = true;
        removePlayfulHint();
        document.getElementById("sendBtn").disabled = true;
        setPlayfulHintDisabled(true);
        try {
            const prompt = "内部指示: 直前の応答が相づちのみになってしまいました。直前のAIのreactionsやquestionと同じ評価語・感嘆・言い回しを繰り返さず、参加者に続きを促す短い問いかけを1文だけ送ってください。reactions は空配列にし、question だけを返してください。";
            const context = {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: false,
                forceNormalTurn: true,
                requireQuestion: true,
            };
            const turn = await withTypingUntilMessage(() => generateInterviewTurn(prompt, context));
            if (!this.isActive() || token !== this._followupToken) { removeTyping(); return; }
            this.markCheckpoints(turn.checkpoints_filled);
            await this._speakReactions(turn.reactions);
            await this._speakAndLog(turn.question, {
                role: "ai", text: turn.question, type: "followup_question",
                answered_checkpoints: turn.checkpoints_filled, ready_to_close: turn.ready_to_close,
            });
            if (turn.ready_to_close && this._phase === PHASES.CHAT) {
                this._beginClosingPhase().catch(e => {
                    pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                });
            }
        } catch (e) {
            pushSessionEvent({ role: "system", type: "followup_error", message: e.message }).catch(() => {});
        } finally {
            // token が変わっていれば別の処理が _isBusy を引き継いでいる
            if (token === this._followupToken) {
                this._isBusy = false;
                document.getElementById("sendBtn").disabled = false;
                setPlayfulHintDisabled(false);
            }
        }
    }

    // --- Topic switch（「話題を変えて」ボタン） ---

    async _switchTopic() {
        if (!this.isActive()) return;
        if (this._isBusy) {
            if (this._userTurnCount >= EARLY_CLOSE_TURNS) {
                showEarlyCloseHint(
                    () => this._switchTopic(),
                    () => this._beginClosingPhase().catch(e => {
                        pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                    })
                );
            }
            return;
        }
        this._cancelFollowup();
        this._isBusy = true;
        document.getElementById("sendBtn").disabled = true;
        setEarlyCloseHintDisabled(true);
        setPlayfulHintDisabled(true);
        try {
            const prompt = "内部指示: 参加者が話題の切り替えを希望しています。未収集の論点があれば自然に移ってください。なければ別の角度から聞いてみてください。";
            const context = {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: false,
                forceNormalTurn: true,
            };
            const turn = await withTypingUntilMessage(() => generateInterviewTurn(prompt, context));
            if (!this.isActive()) { removeTyping(); return; }
            this.markCheckpoints(turn.checkpoints_filled);
            await this._speakReactions(turn.reactions);
            if (turn.question) {
                await this._speakAndLog(turn.question, {
                    role: "ai", text: turn.question, type: "topic_switch",
                    answered_checkpoints: turn.checkpoints_filled, ready_to_close: turn.ready_to_close,
                });
            } else {
                await this._logTurnWithoutQuestion("topic_switch", turn);
            }
            if (turn.ready_to_close && this._phase === PHASES.CHAT) {
                this._beginClosingPhase().catch(e => {
                    pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                });
            }
        } catch (e) {
            pushSessionEvent({ role: "system", type: "topic_switch_error", message: e.message }).catch(() => {});
        } finally {
            this._isBusy = false;
            document.getElementById("sendBtn").disabled = false;
            if (this._phase === PHASES.CHAT) setEarlyCloseHintDisabled(false);
            setPlayfulHintDisabled(false);
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

    _renderClosingAction() {
        if (this._phase !== PHASES.CLOSING) return;
        renderClosingAction(
            () => this._concludeSession({ logEvent: { role: "system", type: "session_completed_by_user" } }),
            () => this._showClosingSummary()
        );
    }

    async _showClosingSummary() {
        if (this._phase !== PHASES.CLOSING || this._isBusy) return;
        this._cancelFollowup();
        this._resetAbandonTimer();
        removePlayfulHint();
        this._isBusy = true;
        document.getElementById("sendBtn").disabled = true;
        try {
            const prompt = "内部指示: ここまでの会話を踏まえて、聞き手の感想として短い要約を2〜3文で作ってください。流れの事務的要約ではなく、参加者の言葉を受け止める温かいトーンで書いてください。最後は相手が自然に余韻を感じられるように、やわらかく締めてください。";
            const turn = await generateInterviewTurn(prompt, {
                model: this.model,
                sessionContext: this.sessionContext,
                checkpoints: this.checkpoints,
                lastUserMessage: this._lastUserMessage,
                inClosingPhase: true,
                inClosingImpressionSummary: true,
            });
            if (this._phase !== PHASES.CLOSING) { removeTyping(); return; }
            showClosingSummaryModal(turn.text);
            await pushSessionEvent({ role: "ai", text: turn.text, type: "closing_impression_summary" }).catch(() => {});
            this.refreshStats();
        } catch (e) {
            pushSessionEvent({ role: "system", type: "closing_impression_summary_error", message: e.message }).catch(() => {});
        } finally {
            this._isBusy = false;
            document.getElementById("sendBtn").disabled = false;
        }
    }

    // --- Phase transitions ---

    async _beginClosingPhase() {
        this._stopAbandonTimer();
        this._cancelFollowup();
        this._phase = PHASES.CLOSING;
        removeEarlyCloseHint();
        removePlayfulHint();
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
            this._renderClosingAction();
            this._resetAbandonTimer();
        }
    }

    async _concludeSession({ logEvent, endedNote, showRestartAction = false } = {}) {
        if (this._phase === PHASES.ENDED) return;
        this._phase = PHASES.ENDED;
        this._stopAbandonTimer();
        removeTyping();
        removeClosingAction();
        removeTimeoutAction();
        removeEarlyCloseHint();
        removePlayfulHint();
        hideComposer();
        setSessionEndedNote(endedNote ?? "話してくれてありがとうございました。");
        if (!showRestartAction && endedNote) {
            addMessage("ai", endedNote);
        }
        if (showRestartAction) {
            renderTimeoutAction({
                message: "終了判定前に会話が止まりました。インタビューをやり直しますか？",
                primaryLabel: "もう一度はじめる",
                secondaryLabel: "今回は終了",
                onPrimary: () => window.location.reload(),
                onSecondary: () => {
                    addMessage("ai", endedNote ?? "話してくれてありがとうございました。");
                    removeTimeoutAction();
                },
            });
        }
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
        this._cancelFollowup();
        this._resetAbandonTimer();
        this._userTurnCount++;
        this._lastUserMessage = normalizedText;
        if (this._phase === PHASES.CLOSING) removeClosingAction();
        if (this._phase === PHASES.CLOSING) removeEarlyCloseHint();
        removePlayfulHint();
        addMessage("user", normalizedText);
        this._isBusy = true;
        document.getElementById("sendBtn").disabled = true;
        setPlayfulHintDisabled(true);
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
            await this._speakReactions(turn.reactions);
            if (turn.question) {
                await this._speakAndLog(turn.question, {
                    role: "ai", text: turn.question, type: "generated_turn",
                    answered_checkpoints: turn.checkpoints_filled, ready_to_close: turn.ready_to_close,
                });
            } else if (turn.ready_to_close || turn.checkpoints_filled.length > 0) {
                await this._logTurnWithoutQuestion("generated_turn", turn);
            }
            if (this._phase === PHASES.CLOSING) this._renderClosingAction();
            if (!turn.question && turn.ready_to_close && this._phase === PHASES.CHAT) {
                this._beginClosingPhase().catch(e => {
                    pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                });
            } else if (this._phase === PHASES.CHAT) {
                const schedulesReactionOnlyFollowup = !turn.question
                    && shouldScheduleFollowupOnReactionOnly(turn)
                    && !shouldWaitOnReactionOnly(turn);
                if (
                    !turn.question
                    && !schedulesReactionOnlyFollowup
                    && (turn.turn_policy?.mode === "playful" || turn.turn_policy?.mode === "shiritori")
                ) {
                    this._showPlayfulHint();
                }
                if (schedulesReactionOnlyFollowup) {
                    this._scheduleFollowup(false);
                }
                if (this._userTurnCount >= EARLY_CLOSE_TURNS) {
                    showEarlyCloseHint(
                        () => this._switchTopic(),
                        () => this._beginClosingPhase().catch(e => {
                            pushSessionEvent({ role: "system", type: "closing_phase_error", message: e.message }).catch(() => {});
                        })
                    );
                }
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
            this._isBusy = false;
            document.getElementById("sendBtn").disabled = false;
            setPlayfulHintDisabled(false);
        }
    }

    // --- Session flow ---

    async _beginFreeConversation() {
        showComposer();
        removeClosingAction();
        removePlayfulHint();
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
        removeTimeoutAction();
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
