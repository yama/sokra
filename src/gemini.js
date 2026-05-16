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

const TURN_MODE = {
    NORMAL: "normal",
    PLAYFUL: "playful",
    SHIRITORI: "shiritori",
};

function buildConversationHistory(lastUserMessage) {
    const log = getSessionLog().slice();
    const last = log[log.length - 1];
    if (last?.role === "user" && last.text === lastUserMessage) log.pop();
    const entries = log
        .filter(e =>
            ["user", "ai"].includes(e.role)
            && e?.type !== "button"
            && typeof e.text === "string"
        )
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
    return String(text || "")
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function normalizeUserText(text) {
    return String(text || "").trim();
}

function normalizeReactions(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean);
}

function looksLikeExplicitQuestion(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return false;
    const cleaned = stripEmoji(normalized).replace(/[」』）)\]】]+$/gu, "").trim();
    if (/[？?]\s*$/.test(cleaned)) return true;
    return /(ますか|でしょうか|でしたか|ですか|のですか)\s*$/.test(cleaned);
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

function recentAiReactionTexts(limit = 3) {
    return getSessionLog()
        .filter(e => e?.role === "ai" && e?.type === "reaction" && typeof e.text === "string")
        .map(e => e.text.trim())
        .filter(Boolean)
        .slice(-limit);
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

function countTrailingShiritoriTurnsFromTexts(userTexts) {
    if (userTexts.length < 2) return 0;
    let streak = 1;
    for (let i = userTexts.length - 1; i > 0; i--) {
        if (!looksLikePlayfulSingleProbe(userTexts[i]) || !looksLikePlayfulSingleProbe(userTexts[i - 1])) break;
        if (!looksLikeShiritoriPair(userTexts[i - 1], userTexts[i])) break;
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
    return countTrailingShiritoriTurnsFromTexts(recentUserTextsWithCurrent(userText));
}

function buildPlayfulSnapshot(userText, playfulCount) {
    return {
        count: playfulCount,
        recentInputs: recentUserTextsWithCurrent(userText).slice(-3),
        recentReactions: recentAiReactionTexts(3),
    };
}

function detectTurnClassification(userText, context) {
    if (context.forceNormalTurn === true) {
        return {
            mode: TURN_MODE.NORMAL,
            playful: { count: 0, recentInputs: [], recentReactions: [] },
        };
    }

    if (!looksLikePlayfulSingleProbe(userText)) {
        return {
            mode: TURN_MODE.NORMAL,
            playful: { count: 0, recentInputs: [], recentReactions: [] },
        };
    }

    const playfulCount = countTrailingShortSingleTokenUserTurns(userText);
    if (countTrailingShiritoriTurns(userText) >= 2) {
        return {
            mode: TURN_MODE.SHIRITORI,
            playful: buildPlayfulSnapshot(userText, playfulCount),
        };
    }

    return {
        mode: TURN_MODE.PLAYFUL,
        playful: buildPlayfulSnapshot(userText, playfulCount),
    };
}

function buildTurnPolicy(userText, context) {
    const requireQuestion = context.requireQuestion === true;
    const classification = detectTurnClassification(userText, context);
    return {
        ...classification,
        requireQuestion,
        allowQuestion: classification.mode === TURN_MODE.NORMAL,
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
        reactions: normalizeReactions(parsed.reactions),
        question: typeof parsed.question === "string" ? parsed.question.trim() : "",
        ready_to_close: parsed.ready_to_close === true,
    });
    if (policy.allowQuestion === false && turn.question && !looksLikeExplicitQuestion(turn.question)) {
        turn.reactions.push(turn.question);
        turn.question = "";
    }
    if (!turn.question && turn.reactions.length === 0) {
        throw new Error("response.question or response.reactions is required");
    }
    if (policy.requireQuestion && !turn.question) {
        throw new Error("response.question is required for this turn");
    }
    if (policy.allowQuestion === false && turn.question) {
        throw new Error("response.question is not allowed for this turn");
    }
    if (turn.ready_to_close && turn.question) {
        throw new Error("response.question is not allowed when ready_to_close is true");
    }
    return {
        reactions: turn.reactions,
        question: turn.question || undefined,
        checkpoints_filled: validateCheckpointsFilled(parsed.checkpoints_filled, checkpoints),
        ready_to_close: turn.ready_to_close,
    };
}

function parseClosingResponse(rawText, checkpoints) {
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
        checkpoints_filled: validateCheckpointsFilled(parsed.checkpoints_filled, checkpoints),
        ready_to_close: parsed.ready_to_close === true,
    };
}

function normalizeReactionEmojiRhythm(turn) {
    if (!turn.reactions.some(reaction => hasEmoji(reaction))) return turn;
    return {
        ...turn,
        question: stripEmoji(turn.question),
    };
}

export function shouldWaitOnReactionOnly(turn) {
    if (!Array.isArray(turn?.reactions) || turn.reactions.length !== 1 || turn?.question) return false;
    return turn?.turn_policy?.mode === TURN_MODE.PLAYFUL
        && turn?.turn_policy?.playful?.count === 1
        && countEmojiClusters(turn.reactions[0]) === 1;
}

export function shouldScheduleFollowupOnReactionOnly(turn) {
    if (!Array.isArray(turn?.reactions) || turn.reactions.length === 0 || turn?.question) return false;
    return turn?.turn_policy?.mode === TURN_MODE.NORMAL
        || (
            turn?.turn_policy?.mode === TURN_MODE.PLAYFUL
            && turn?.turn_policy?.playful?.count === 1
            && !shouldWaitOnReactionOnly(turn)
        );
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
                    turnMode: policy.mode,
                    playfulCount: policy.playful?.count,
                    playfulRecentInputs: policy.playful?.recentInputs,
                    playfulRecentReactions: policy.playful?.recentReactions
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
    const isClosingResponse = context.inClosingSummary || context.inClosingImpressionSummary;
    try {
        const { rawText, policy } = await requestGeminiTurn(userText, context);
        if (isClosingResponse) {
            return parseClosingResponse(rawText, context.checkpoints);
        }
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
            if (isClosingResponse) {
                return parseClosingResponse(rawText, context.checkpoints);
            }
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
