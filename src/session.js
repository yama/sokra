let sessionId = null;
let sessionLog = [];
let eventSeq = 0;
let persistQueue = Promise.resolve();
let persistenceError = "";

export const getSessionId = () => sessionId;
export const getSessionLog = () => sessionLog;
export const getPersistenceError = () => persistenceError;

export async function startServerSession(model) {
    const res = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, client: "web" })
    });
    if (!res.ok) {
        throw new Error(`セッション開始に失敗しました: ${await res.text()}`);
    }
    sessionId = (await res.json()).sessionId;
}

async function persistEvent(event) {
    if (!sessionId) return;
    const res = await fetch(`/api/session/${sessionId}/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
        keepalive: true
    });
    if (!res.ok) {
        throw new Error(`イベント保存に失敗しました: ${res.status} ${await res.text()}`);
    }
}

export function pushSessionEvent(event) {
    const entry = { seq: ++eventSeq, ...event };
    sessionLog.push(entry);
    const task = persistQueue.then(() => persistEvent(entry));
    persistQueue = task.catch(() => {});
    return task.catch(err => {
        persistenceError = err.message;
        throw err;
    });
}
