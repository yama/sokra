import { CHECKPOINTS } from "../interview-flow.js";
import { buildSystemPrompt } from "./prompt.js";
import { getSessionLog, pushSessionEvent } from "./session.js";

const VALID_CHECKPOINT_IDS = new Set(CHECKPOINTS.map(cp => cp.id));
const GEMINI_REQUEST_TIMEOUT_MS = window.__SOKRA_GEMINI_TIMEOUT_MS__ || 30000;

let usageSummary = {
    requests: 0,
    retries: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0
};

export const getUsageSummary = () => ({ ...usageSummary });

const PLAYFUL_SHORT_PROBE_MODES = {
    OFF: "off",
    SINGLE: "single",
    SHORT_PROBE_STREAK: "short_probe_streak",
    SHIRITORI_STREAK: "shiritori_streak",
};

const TURN_POLICY = {
    NORMAL: "normal",
    PLAYFUL_SINGLE: "playful_single",
    PLAYFUL_SHORT_STREAK: "playful_short_streak",
    PLAYFUL_SHIRITORI_STREAK: "playful_shiritori_streak",
};

function buildConversationHistory(lastUserMessage) {
    const log = getSessionLog().slice();
    const last = log[log.length - 1];
    if (last?.role === "user" && last.text === lastUserMessage) log.pop();
    const entries = log
        .filter(e => ["user", "ai"].includes(e.role) && typeof e.text === "string")
        .map(e => ({ role: e.role === "ai" ? "assistant" : "user", content: e.text }));
    return entries.reduce((acc, entry) => {
        const prev = acc[acc.length - 1];
        if (prev?.role === entry.role) {
            prev.content += "\n" + entry.content;
        } else {
            acc.push({ ...entry });
        }
        return acc;
    }, []);
}

function validateCheckpointsFilled(filled, checkpoints) {
    if (!Array.isArray(filled)) return [];
    const seen = new Set();
    return filled.filter(id => {
        if (typeof id !== "string" || seen.has(id)) return false;
        if (!VALID_CHECKPOINT_IDS.has(id)) return false;
        if (!checkpoints.some(cp => cp.id === id && !cp.done)) return false;
        seen.add(id);
        return true;
    });
}

function hasEmoji(text) {
    return /[\p{Extended_Pictographic}\uFE0F]/u.test(text);
}

function countEmojiClusters(text) {
    const value = String(text || "");
    if (!value) return 0;
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
        let count = 0;
        for (const { segment } of segmenter.segment(value)) {
            if (hasEmoji(segment)) count += 1;
        }
        return count;
    }
    const matches = value.match(/[\p{Extended_Pictographic}]\uFE0F?/gu);
    return matches ? matches.length : 0;
}

function stripEmoji(text) {
    return text
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function normalizeUserText(text) {
    return String(text || "").trim();
}

function isSimpleKanaToken(text) {
    return /^[ぁ-ゖァ-ヶー]+$/u.test(text);
}

function looksLikePlayfulSingleProbe(userText) {
    const normalized = normalizeUserText(userText);
    if (!normalized) return false;
    if (/\s/.test(normalized)) return false;
    if (normalized.length <= 4) return true;
    return isSimpleKanaToken(normalized) && normalized.length <= 6;
}

function recentUserTextsWithCurrent(userText) {
    const userTexts = getSessionLog()
        .filter(e =>
            e?.role === "user"
            && typeof e.text === "string"
            && e?.type !== "button"
        )
        .map(e => e.text.trim());
    const currentText = normalizeUserText(userText);
    if (userTexts[userTexts.length - 1] === currentText) {
        return userTexts;
    }
    userTexts.push(currentText);
    return userTexts;
}

function countTrailingShortSingleTokenUserTurns(userText) {
    const userTexts = recentUserTextsWithCurrent(userText);
    let streak = 0;
    for (let i = userTexts.length - 1; i >= 0; i--) {
        if (!looksLikePlayfulSingleProbe(userTexts[i])) break;
        streak += 1;
    }
    return streak;
}

function normalizeKanaForComparison(text) {
    return normalizeUserText(text)
        .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
        .replace(/[ー〜～・!?！？。、,\.\s]/g, "")
        .replace(/[ぁぃぅぇぉゃゅょっゎ]/g, ch => ({
            "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
            "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ", "ゎ": "わ"
        }[ch] || ch));
}

function firstComparableChar(text) {
    const normalized = normalizeKanaForComparison(text);
    return normalized ? normalized[0] : "";
}

function lastComparableChar(text) {
    const normalized = normalizeKanaForComparison(text);
    return normalized ? normalized[normalized.length - 1] : "";
}

function looksLikeShiritoriPair(previousText, currentText) {
    const prevLast = lastComparableChar(previousText);
    const currentFirst = firstComparableChar(currentText);
    if (!prevLast || !currentFirst) return false;
    if (prevLast === "ん") return false;
    return prevLast === currentFirst;
}

function countTrailingShiritoriTurns(userText) {
    const userTexts = recentUserTextsWithCurrent(userText);
    if (userTexts.length < 2) return 0;
    let streak = 1;
    for (let i = userTexts.length - 1; i > 0; i--) {
        if (!looksLikePlayfulSingleProbe(userTexts[i]) || !looksLikePlayfulSingleProbe(userTexts[i - 1])) break;
        if (!looksLikeShiritoriPair(userTexts[i - 1], userTexts[i])) break;
        streak += 1;
    }
    return streak;
}

function getPlayfulShortProbeMode(userText) {
    if (!looksLikePlayfulSingleProbe(userText)) return PLAYFUL_SHORT_PROBE_MODES.OFF;
    if (countTrailingShiritoriTurns(userText) >= 2) return PLAYFUL_SHORT_PROBE_MODES.SHIRITORI_STREAK;
    if (countTrailingShortSingleTokenUserTurns(userText) >= 2) return PLAYFUL_SHORT_PROBE_MODES.SHORT_PROBE_STREAK;
    return PLAYFUL_SHORT_PROBE_MODES.SINGLE;
}

function buildTurnPolicy(userText, context) {
    if (context.allowReactionOnly === false) {
        return {
            name: TURN_POLICY.NORMAL,
            promptMode: PLAYFUL_SHORT_PROBE_MODES.OFF,
            allowReactionOnly: false,
            waitOnReactionOnly: false,
            scheduleFollowupOnReactionOnly: false,
        };
    }

    const promptMode = getPlayfulShortProbeMode(userText);
    if (promptMode === PLAYFUL_SHORT_PROBE_MODES.SINGLE) {
        return {
            name: TURN_POLICY.PLAYFUL_SINGLE,
            promptMode,
            allowReactionOnly: true,
            waitOnReactionOnly: true,
            scheduleFollowupOnReactionOnly: true,
        };
    }
    if (promptMode === PLAYFUL_SHORT_PROBE_MODES.SHORT_PROBE_STREAK) {
        return {
            name: TURN_POLICY.PLAYFUL_SHORT_STREAK,
            promptMode,
            allowReactionOnly: false,
            waitOnReactionOnly: false,
            scheduleFollowupOnReactionOnly: false,
        };
    }
    if (promptMode === PLAYFUL_SHORT_PROBE_MODES.SHIRITORI_STREAK) {
        return {
            name: TURN_POLICY.PLAYFUL_SHIRITORI_STREAK,
            promptMode,
            allowReactionOnly: false,
            waitOnReactionOnly: false,
            scheduleFollowupOnReactionOnly: false,
        };
    }

    return {
        name: TURN_POLICY.NORMAL,
        promptMode,
        allowReactionOnly: false,
        waitOnReactionOnly: false,
        scheduleFollowupOnReactionOnly: false,
    };
}

function attachTurnPolicy(turn, policy) {
    return {
        ...turn,
        turn_policy: policy,
    };
}

function parseGeminiResponse(rawText, checkpoints, policy) {
    const parsed = JSON.parse(String(rawText || "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not a JSON object");
    }
    const turn = normalizeReactionEmojiRhythm({
        reaction: typeof parsed.reaction === "string" ? parsed.reaction.trim() : "",
        text: typeof parsed.text === "string" ? parsed.text.trim() : "",
        ready_to_close: parsed.ready_to_close === true,
    });
    if (!turn.text && !turn.reaction) {
        throw new Error("response.text or response.reaction is required");
    }
    if (!policy.allowReactionOnly && !turn.text) {
        throw new Error("response.text is required for this turn");
    }
    if (turn.ready_to_close && !turn.text) {
        throw new Error("response.text is required when ready_to_close is true");
    }
    return {
        reaction: turn.reaction,
        text: turn.text,
        checkpoints_filled: validateCheckpointsFilled(parsed.checkpoints_filled, checkpoints),
        ready_to_close: turn.ready_to_close,
        has_question: turn.text
            ? (typeof parsed.has_question === "boolean" ? parsed.has_question : true)
            : false,
    };
}

function normalizeReactionEmojiRhythm(turn) {
    if (!turn.reaction || !hasEmoji(turn.reaction)) return turn;
    return {
        ...turn,
        text: stripEmoji(turn.text),
    };
}

export function shouldWaitOnReactionOnly(turn) {
    if (!turn?.reaction || turn?.text) return false;
    return turn?.turn_policy?.waitOnReactionOnly === true && countEmojiClusters(turn.reaction) === 1;
}

export function shouldScheduleFollowupOnReactionOnly(turn) {
    if (!turn?.reaction || turn?.text) return false;
    return turn?.turn_policy?.scheduleFollowupOnReactionOnly === true
        && !shouldWaitOnReactionOnly(turn);
}

function recordUsage(usage) {
    if (!usage) return;
    usageSummary.promptTokens += Number(usage.promptTokenCount || 0);
    usageSummary.outputTokens += Number(usage.outputTokenCount || 0);
    usageSummary.totalTokens += Number(usage.totalTokenCount || 0);
}

async function requestGeminiTurn(userText, context, retryReason = "") {
    usageSummary.requests += 1;
    const {
        model,
        sessionContext,
        checkpoints,
        lastUserMessage,
        inClosingPhase = false,
        inClosingSummary = false,
        inClosingImpressionSummary = false,
    } = context;
    const policy = buildTurnPolicy(userText, context);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
    let res;
    try {
        res = await fetch("/api/gemini", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model,
                requestKind: inClosingImpressionSummary
                    ? "closing_impression_summary"
                    : inClosingSummary
                    ? "closing_summary"
                    : "interview_turn",
                systemPrompt: buildSystemPrompt(sessionContext, checkpoints, retryReason, {
                    inClosingPhase,
                    inClosingSummary,
                    inClosingImpressionSummary,
                    playfulShortProbeMode: policy.promptMode
                }),
                conversationHistory: buildConversationHistory(lastUserMessage),
                userText,
                responseMimeType: "application/json"
            })
        });
    } catch (e) {
        if (e?.name === "AbortError") throw new Error(`Gemini API request timed out after ${GEMINI_REQUEST_TIMEOUT_MS}ms`);
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }

    const bodyText = await res.text();
    let data = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; } catch {
        throw new Error(`Gemini API returned non-JSON response: ${bodyText.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(data.error || `Gemini API request failed: ${res.status}`);

    recordUsage(data.usage);
    return { rawText: String(data.text || ""), policy };
}

export async function generateInterviewTurn(userText, context) {
    try {
        const { rawText, policy } = await requestGeminiTurn(userText, context);
        return attachTurnPolicy(
            normalizeReactionEmojiRhythm(
                parseGeminiResponse(rawText, context.checkpoints, policy)
            ),
            policy
        );
    } catch (firstError) {
        usageSummary.retries += 1;
        pushSessionEvent({ role: "system", type: "ai_turn_retry", reason: firstError.message }).catch(() => {});
        try {
            const { rawText, policy } = await requestGeminiTurn(userText, context, firstError.message);
            return attachTurnPolicy(
                normalizeReactionEmojiRhythm(
                    parseGeminiResponse(rawText, context.checkpoints, policy)
                ),
                policy
            );
        } catch (secondError) {
            throw new Error(`Gemini interview turn failed after retry: ${secondError.message}`);
        }
    }
}
