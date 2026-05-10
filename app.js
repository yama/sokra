import { InterviewSession } from "./src/interview-session.js";
import { getUsageSummary } from "./src/gemini.js";
import { onUserTypingInput } from "./src/ui.js";

const session = new InterviewSession();
let isStarting = false;

document.getElementById("startBtn").addEventListener("click", async () => {
    if (isStarting) return;
    const startBtn = document.getElementById("startBtn");
    isStarting = true;
    startBtn.disabled = true;
    try {
        await session.start(document.getElementById("modelSelect").value);
    } catch (e) {
        document.getElementById("startError").textContent = e.message;
        document.getElementById("startError").style.display = "block";
    } finally {
        isStarting = false;
        if (document.getElementById("startScreen").style.display !== "none") {
            startBtn.disabled = false;
        }
    }
});

document.getElementById("sendBtn").addEventListener("click", () => {
    const ta = document.getElementById("userInput");
    const text = ta.value.trim();
    if (text) { ta.value = ""; ta.style.height = "42px"; session.onUserMessage(text); }
});

document.getElementById("userInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("sendBtn").click(); }
});

document.getElementById("userInput").addEventListener("input", function () {
    onUserTypingInput();
    this.value.trim() ? session.pauseSilenceTimer() : session.resumeSilenceTimer();
    this.style.height = "42px";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

document.getElementById("logBtn").addEventListener("click", () => {
    const log = { ...session.getLog(), usage_summary: getUsageSummary() };
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "interview_log.json";
    a.click();
    URL.revokeObjectURL(url);
});
