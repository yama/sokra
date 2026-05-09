const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const SESSIONS_DIR = path.join(ROOT, "data", "sessions");
const STATIC_FILES = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
    ["/interview-flow.js", { file: "interview-flow.js", type: "application/javascript; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "application/javascript; charset=utf-8" }],
    ["/README.md", { file: "README.md", type: "text/markdown; charset=utf-8" }]
]);
function loadEnvFile() {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;

        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

loadEnvFile();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);

async function ensureSessionsDir() {
    await fsp.mkdir(SESSIONS_DIR, { recursive: true });
}

function makeSessionId() {
    return `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function sessionFilePath(sessionId) {
    const safe = String(sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(SESSIONS_DIR, `${safe}.jsonl`);
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(text)
    });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => {
            data += chunk;
            if (data.length > 1_000_000) {
                reject(new Error("Request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

async function appendJsonl(filePath, obj) {
    const line = `${JSON.stringify(obj)}\n`;
    await fsp.appendFile(filePath, line, "utf8");
}

async function parseSessionFile(filePath) {
    const text = await fsp.readFile(filePath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    let meta = null;
    const events = [];

    for (const line of lines) {
        try {
            const item = JSON.parse(line);
            if (item.type === "meta") {
                meta = item;
            } else {
                events.push(item);
            }
        } catch {
            // Skip malformed lines so one bad line does not break retrieval.
        }
    }

    return {
        session_id: path.basename(filePath, ".jsonl"),
        meta,
        events
    };
}

function toGeminiContents(history, userText) {
    const items = Array.isArray(history) ? history.slice() : [];
    items.push({ role: "user", content: String(userText || "") });

    return items.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content || "") }]
    }));
}

function extractCandidateText(candidate) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
        .map(part => typeof part?.text === "string" ? part.text : "")
        .join("")
        .trim();
    return text;
}

async function callGemini({ model, systemPrompt, conversationHistory, userText }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in .env");
    }
    const modelName = model || "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: String(systemPrompt || "") }] },
            generationConfig: {
                maxOutputTokens: 512,
                thinkingConfig: {
                    thinkingBudget: 0
                }
            },
            contents: toGeminiContents(conversationHistory, userText)
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0] || null;
    const raw = extractCandidateText(candidate);
    if (!raw) {
        const finishReason = candidate?.finishReason || "";
        const error = new Error(`Gemini response did not include any text candidate${finishReason ? ` (finishReason=${finishReason})` : ""}`);
        error.code = "GEMINI_EMPTY_TEXT";
        error.details = {
            finishReason,
            modelVersion: data.modelVersion || "",
            candidateExcerpt: JSON.stringify(candidate || {}).slice(0, 1200)
        };
        throw error;
    }
    const usage = data.usageMetadata || {};

    return {
        text: raw,
        usage: {
            promptTokenCount: usage.promptTokenCount || 0,
            outputTokenCount: usage.candidatesTokenCount || usage.outputTokenCount || 0,
            totalTokenCount: usage.totalTokenCount || 0
        },
        finishReason: data.candidates?.[0]?.finishReason || "",
        modelVersion: data.modelVersion || ""
    };
}

async function handleApi(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/session/start") {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const sessionId = makeSessionId();
        const filePath = sessionFilePath(sessionId);

        await appendJsonl(filePath, {
            type: "meta",
            ts: new Date().toISOString(),
            model: body.model || "gemini-2.5-flash",
            client: body.client || "web"
        });

        return sendJson(res, 200, { sessionId });
    }

    if (req.method === "POST" && /^\/api\/session\/[^/]+\/event$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[3];
        const filePath = sessionFilePath(sessionId);
        if (!fs.existsSync(filePath)) {
            return sendJson(res, 404, { error: "Session not found" });
        }

        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        if (!body || typeof body !== "object" || !body.event) {
            return sendJson(res, 400, { error: "event is required" });
        }

        await appendJsonl(filePath, {
            ...body.event,
            ts: new Date().toISOString()
        });
        return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && /^\/api\/session\/[^/]+$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[3];
        const filePath = sessionFilePath(sessionId);
        if (!fs.existsSync(filePath)) {
            return sendJson(res, 404, { error: "Session not found" });
        }

        const parsed = await parseSessionFile(filePath);
        return sendJson(res, 200, parsed);
    }

    if (req.method === "POST" && url.pathname === "/api/gemini") {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        try {
            const result = await callGemini({
                model: body.model,
                systemPrompt: body.systemPrompt,
                conversationHistory: body.conversationHistory,
                userText: body.userText
            });
            return sendJson(res, 200, result);
        } catch (err) {
            return sendJson(res, 502, {
                error: err.message || "Gemini request failed",
                code: err.code || "",
                details: err.details || null
            });
        }
    }

    return false;
}

function serveStatic(req, res, url) {
    if (req.method !== "GET") return false;

    const staticFile = STATIC_FILES.get(url.pathname);
    if (staticFile) {
        const filePath = path.join(ROOT, staticFile.file);
        if (!fs.existsSync(filePath)) return false;
        sendText(res, 200, fs.readFileSync(filePath, "utf8"), staticFile.type);
        return true;
    }

    return false;
}

async function main() {
    await ensureSessionsDir();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

            const apiHandled = await handleApi(req, res, url);
            if (apiHandled !== false) return;

            const staticHandled = serveStatic(req, res, url);
            if (staticHandled) return;

            sendJson(res, 404, { error: "Not found" });
        } catch (err) {
            sendJson(res, 500, { error: err.message || "Internal Server Error" });
        }
    });

    server.listen(PORT, HOST, () => {
        console.log(`Server running at http://${HOST}:${PORT}`);
        console.log(`Session logs directory: ${SESSIONS_DIR}`);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
