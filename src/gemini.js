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

function parseGeminiResponse(rawText, checkpoints) {
    const parsed = JSON.parse(String(rawText || "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not a JSON object");
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) throw new Error("response.text is required");
    return {
        reaction: typeof parsed.reaction === "string" ? parsed.reaction.trim() : "",
        text,
        checkpoints_filled: validateCheckpointsFilled(parsed.checkpoints_filled, checkpoints),
        is_done: parsed.is_done === true,
        has_question: typeof parsed.has_question === "boolean" ? parsed.has_question : true,
    };
}

function recordUsage(usage) {
    if (!usage) return;
    usageSummary.promptTokens += Number(usage.promptTokenCount || 0);
    usageSummary.outputTokens += Number(usage.outputTokenCount || 0);
    usageSummary.totalTokens += Number(usage.totalTokenCount || 0);
}

async function requestGeminiTurn(userText, context, retryReason = "") {
    usageSummary.requests += 1;
    const { model, sessionContext, checkpoints, lastUserMessage, inClosingPhase = false, inClosingSummary = false } = context;

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
                requestKind: inClosingSummary ? "closing_summary" : "interview_turn",
                systemPrompt: buildSystemPrompt(sessionContext, checkpoints, retryReason, { inClosingPhase, inClosingSummary }),
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
    return String(data.text || "");
}

export async function generateInterviewTurn(userText, context) {
    try {
        return parseGeminiResponse(await requestGeminiTurn(userText, context), context.checkpoints);
    } catch (firstError) {
        usageSummary.retries += 1;
        pushSessionEvent({ role: "system", type: "ai_turn_retry", reason: firstError.message }).catch(() => {});
        try {
            return parseGeminiResponse(
                await requestGeminiTurn(userText, context, firstError.message),
                context.checkpoints
            );
        } catch (secondError) {
            throw new Error(`Gemini interview turn failed after retry: ${secondError.message}`);
        }
    }
}
