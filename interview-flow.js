export const CHECKPOINTS = [
    { id: "background",  label: "参加背景",         done: false },
    { id: "temperature", label: "温度感",             done: false },
    { id: "impression",  label: "印象点",             done: false },
    { id: "difficulty",  label: "違和感・難しさ",     done: false },
    { id: "practical",   label: "実務との接点",       done: false }
];

export const CONTEXT_QUESTIONS = [
    {
        key: "format",
        prompt: "今日はありがとうございました。少しだけ話聞かせてもらえますか？",
        choices: [
            { label: "現地参加",   value: "現地" },
            { label: "オンライン参加", value: "オンライン" }
        ]
    },
    {
        key: "timing",
        prompt: "そうなんですね。仕事終わりでした？",
        choices: [
            { label: "仕事終わり" },
            { label: "休日" },
            { label: "その他" }
        ]
    },
    {
        key: "mood",
        prompt: "今日のセミナー、全体的にどうでした？",
        choices: [
            { label: "よかった" },
            { label: "まあまあ" },
            { label: "難しかった" },
            { label: "よく分からなかった" }
        ],
        checkpointId: "temperature"
    }
];

export function createCheckpoints() {
    return CHECKPOINTS.map(cp => ({ ...cp }));
}
