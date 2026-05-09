(function (global) {
    const CHECKPOINTS = [
        { id: "background", label: "参加背景", done: false },
        { id: "temperature", label: "温度感", done: false },
        { id: "impression", label: "印象点", done: false },
        { id: "difficulty", label: "違和感・難しさ", done: false },
        { id: "practical", label: "実務との接点", done: false }
    ];

    function createCheckpoints() {
        return CHECKPOINTS.map(checkpoint => ({ ...checkpoint }));
    }

    function isMetaConversationReply(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return false;
        return /噛み合|通じ|壊|ずれ|意味が分から|意味がわから|何を言|会話.*(変|おかしい)|^違います|^違う/.test(trimmed);
    }

    function getUserSignal(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return "none";
        if (["終わりに", "そうしてください", "やめたい", "もう終わり"].some(pattern => trimmed.includes(pattern))) {
            return "end";
        }
        if (["どうしても", "答えないといけない", "しつこくない", "しつこい"].some(pattern => trimmed.includes(pattern))) {
            return "resist";
        }
        if (["さっき言った", "もう言った", "同じこと"].some(pattern => trimmed.includes(pattern))) {
            return "repeat";
        }
        return "none";
    }

    function buildResistanceResponse(signal) {
        switch (signal) {
            case "end":
                return "分かりました。ここまでで十分です。今日はこのあたりで終わりにしましょう。";
            case "resist":
                return "しつこく感じさせてしまってすみません。ここまでで十分なので、今日はこのあたりで終わりにします。";
            case "repeat":
                return "同じことを聞く形になってしまいましたね。ここまででも十分なので、今日はこのあたりで終わりにします。";
            default:
                return "";
        }
    }

    function buildMetaConversationClosing() {
        return "噛み合っていない感じになってしまいましたね。ここでいったん止めます。";
    }

    global.SokraInterviewFlow = {
        CHECKPOINTS,
        createCheckpoints,
        isMetaConversationReply,
        getUserSignal,
        buildResistanceResponse,
        buildMetaConversationClosing
    };
})(window);
