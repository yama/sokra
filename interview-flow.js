(function (global) {
    const CHECKPOINTS = [
        { id: "background", label: "参加背景", done: false },
        { id: "temperature", label: "温度感", done: false },
        { id: "impression", label: "印象点", done: false },
        { id: "difficulty", label: "違和感・難しさ", done: false },
        { id: "practical", label: "実務との接点", done: false }
    ];

    const CONVERSATION_FLOW = ["impression", "difficulty", "practical", "background"];

    function createCheckpoints() {
        return CHECKPOINTS.map(checkpoint => ({ ...checkpoint }));
    }

    function checkpointForStep(step) {
        switch (step) {
            case "impression":
                return "impression";
            case "feeling":
                return "difficulty";
            case "practical":
                return "practical";
            case "background":
                return "background";
            default:
                return "";
        }
    }

    function nextMissingCheckpointId(checkpoints) {
        const first = checkpoints.find(checkpoint => !checkpoint.done);
        return first ? first.id : "";
    }

    function checkpointDone(checkpoints, id) {
        return checkpoints.some(checkpoint => checkpoint.id === id && checkpoint.done);
    }

    function nextConversationCheckpoint(checkpoints, fromId = "") {
        const startIndex = fromId ? CONVERSATION_FLOW.indexOf(fromId) + 1 : 0;
        for (let i = Math.max(startIndex, 0); i < CONVERSATION_FLOW.length; i += 1) {
            const id = CONVERSATION_FLOW[i];
            if (checkpoints.some(checkpoint => checkpoint.id === id && !checkpoint.done)) {
                return id;
            }
        }
        return nextMissingCheckpointId(checkpoints) || "";
    }

    function syncActiveCheckpoint(checkpoints, activeCheckpointId) {
        if (activeCheckpointId && checkpoints.some(checkpoint => checkpoint.id === activeCheckpointId && !checkpoint.done)) {
            return activeCheckpointId;
        }
        return nextConversationCheckpoint(checkpoints, activeCheckpointId);
    }

    function isMinimalReply(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return true;
        if (/^[?？!！…。ー〜\s]+$/.test(trimmed)) return true;
        return trimmed.length <= 1;
    }

    function isLowEnergyReply(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return false;
        if (isMinimalReply(trimmed)) return true;
        return /^(特に|特にない|特にないです|わからない|分からない|よくわからない|よく分からない|詳しくない|詳しくないです|うまく言えない|うまく言えないです)[。.!！]*$/.test(trimmed);
    }

    function looksConfusedReply(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return false;
        if (/^[?？!！…。ー〜\s]+$/.test(trimmed)) return true;
        return trimmed.length <= 8 && /[?？]/.test(trimmed);
    }

    function hasExplanatoryShape(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return false;
        return /[。！？]|です|ます|でした|ました|らしい|という|って|ので|から|けど|と思|感じ|気が|ような|ことが|のが/.test(trimmed);
    }

    function isBareTopicReply(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return false;
        if (isLowEnergyReply(trimmed) || looksConfusedReply(trimmed)) return false;
        return trimmed.length <= 18 && !hasExplanatoryShape(trimmed);
    }

    function isSubstantiveCheckpointAnswer(checkpointId, text) {
        const trimmed = String(text || "").trim();
        if (!trimmed || isLowEnergyReply(trimmed) || looksConfusedReply(trimmed)) return false;
        if (checkpointId === "impression") {
            return !isBareTopicReply(trimmed) && (trimmed.length >= 10 || hasExplanatoryShape(trimmed));
        }
        if (checkpointId === "difficulty" || checkpointId === "practical") {
            return trimmed.length >= 8 || hasExplanatoryShape(trimmed);
        }
        return trimmed.length >= 6 || hasExplanatoryShape(trimmed);
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

    function looksLikeBackground(text) {
        const trimmed = String(text || "").trim();
        return /きっかけ|案内|お知らせ|勧められて|誘われて|参加した|参加しました|来ました|来た/.test(trimmed);
    }

    function looksLikeImpression(text) {
        const trimmed = String(text || "").trim();
        return /印象|面白|おもしろ|リアクション|残った|覚えて|話/.test(trimmed);
    }

    function looksLikeDifficulty(text) {
        const trimmed = String(text || "").trim();
        return /難し|分から|わから|こわ|怖|不安|不気味|引っかか|違和感|依存|抵抗/.test(trimmed);
    }

    function looksLikePractical(text) {
        const trimmed = String(text || "").trim();
        return /仕事|活用|使える|使えそう|作れる|作れそう|便利|普段|日常|業務|問い合わせ|対応|FAQ|faq|サイト|ホームページ|レシピ|晩ごはん|夕飯|料理|提案書|商談|社内.*対応/.test(trimmed);
    }

    function detectAnsweredCheckpoints(text, expectedStep) {
        const trimmed = String(text || "").trim();
        const ids = new Set();
        const expectedCheckpoint = checkpointForStep(expectedStep);
        if (!trimmed) return [];

        if (isLowEnergyReply(trimmed)) {
            if (expectedCheckpoint) ids.add(expectedCheckpoint);
            return [...ids];
        }

        const hasBackground = looksLikeBackground(trimmed);
        const hasPractical = looksLikePractical(trimmed);
        const hasDifficulty = looksLikeDifficulty(trimmed);
        const hasImpression = looksLikeImpression(trimmed) && isSubstantiveCheckpointAnswer("impression", trimmed);

        if (hasBackground) ids.add("background");
        if (hasPractical) ids.add("practical");
        if (hasDifficulty) ids.add("difficulty");
        if (hasImpression) ids.add("impression");

        if (expectedStep === "impression" && expectedCheckpoint && isSubstantiveCheckpointAnswer(expectedCheckpoint, trimmed)) {
            if (hasImpression || ids.size === 0) ids.add(expectedCheckpoint);
        }
        if (expectedStep === "practical" && expectedCheckpoint && isSubstantiveCheckpointAnswer(expectedCheckpoint, trimmed)) {
            if (!hasBackground && !hasDifficulty && !hasImpression) ids.add(expectedCheckpoint);
        }

        return [...ids];
    }

    function firstMissingCheckpoint(checkpoints, ids) {
        return ids.find(id => !checkpointDone(checkpoints, id)) || "";
    }

    function chooseNextStep(state, answeredIds, previousStep, options = {}) {
        const checkpoints = state.checkpoints || [];
        const answered = new Set(answeredIds);
        const currentStage = state.interviewStepStage || "entry";
        let softCloseAfterBackground = Boolean(state.softCloseAfterBackground);

        if (options.lowEnergy) {
            softCloseAfterBackground = true;
            if (!checkpointDone(checkpoints, "background")) {
                return { step: "background", stage: "entry", softCloseAfterBackground };
            }
            return { step: "", stage: "done", softCloseAfterBackground };
        }

        if (softCloseAfterBackground && answered.has("background")) {
            return { step: "", stage: "done", softCloseAfterBackground };
        }

        if (previousStep === "impression" && !answered.has("impression") && !checkpointDone(checkpoints, "impression")) {
            const answeredOtherCheckpoint = answered.size > 0;
            return { step: "impression", stage: answeredOtherCheckpoint ? "entry" : "detail", softCloseAfterBackground };
        }
        if (previousStep === "feeling" && !answered.has("difficulty") && !checkpointDone(checkpoints, "difficulty")) {
            if (currentStage === "entry") {
                return { step: "feeling", stage: "contrast", softCloseAfterBackground };
            }
            return { step: "practical", stage: "entry", softCloseAfterBackground };
        }
        if (previousStep === "practical" && !answered.has("practical") && !checkpointDone(checkpoints, "practical")) {
            return { step: "practical", stage: "entry", softCloseAfterBackground };
        }

        if (answered.has("impression") && !checkpointDone(checkpoints, "difficulty")) {
            return { step: "feeling", stage: "entry", softCloseAfterBackground };
        }
        if (answered.has("difficulty") && !checkpointDone(checkpoints, "practical")) {
            return { step: "practical", stage: "entry", softCloseAfterBackground };
        }
        if (answered.has("practical") && !checkpointDone(checkpoints, "background")) {
            return { step: "background", stage: "entry", softCloseAfterBackground };
        }
        if (answered.has("background") && !checkpointDone(checkpoints, "impression")) {
            return { step: "impression", stage: "entry", softCloseAfterBackground };
        }

        const nextCheckpoint = firstMissingCheckpoint(checkpoints, ["impression", "difficulty", "practical", "background"]);
        if (nextCheckpoint === "impression") return { step: "impression", stage: "entry", softCloseAfterBackground };
        if (nextCheckpoint === "difficulty") return { step: "feeling", stage: "entry", softCloseAfterBackground };
        if (nextCheckpoint === "practical") return { step: "practical", stage: "entry", softCloseAfterBackground };
        if (nextCheckpoint === "background") return { step: "background", stage: "entry", softCloseAfterBackground };
        return { step: "", stage: "done", softCloseAfterBackground };
    }

    function acknowledgementFor(answeredIds, options = {}) {
        if (options.lowEnergy) {
            return "そうなんですね。";
        }
        const answered = new Set(answeredIds);
        if (answered.has("practical")) {
            return "使えそうな場面も浮かんだんですね。";
        }
        if (answered.has("difficulty")) {
            return "少し引っかかる感じもあったんですね。";
        }
        if (answered.has("impression")) {
            return "その話が残っていたんですね。";
        }
        if (answered.has("background")) {
            return "参加のきっかけはそういう流れだったんですね。";
        }
        return "その話ですね。";
    }

    function questionForStep(step, stage = "entry") {
        switch (step) {
            case "impression":
                if (stage === "detail") {
                    return "どのあたりが残りましたか？";
                }
                return "今日の中で印象に残っている話はありますか？";
            case "feeling":
                if (stage === "contrast") {
                    return "逆に、少し引っかかったところやこわさはありましたか？";
                }
                return "それを聞いて、面白い、こわい、便利そうなど、どんな感じがしましたか？";
            case "practical":
                return "仕事や普段の場面で使えそうなところはありましたか？";
            case "background":
                return "最後に、参加したきっかけを一言だけ聞かせてください。";
            default:
                return "";
        }
    }

    function buildPlannedTurn(answeredIds, nextStep, options = {}) {
        if (!nextStep.step) {
            return buildClosingMessage(options.lastCompletedCheckpointId, options.lastContentCheckpointId);
        }
        const ack = acknowledgementFor(answeredIds, options);
        const question = questionForStep(nextStep.step, nextStep.stage);
        return `${ack}${question}`;
    }

    function buildClosingMessage(lastCompletedCheckpointId, lastContentCheckpointId = "") {
        const closingCheckpointId = lastCompletedCheckpointId === "background"
            ? lastContentCheckpointId
            : lastCompletedCheckpointId;
        if (closingCheckpointId === "practical") {
            return "使えそうな場面まで聞かせていただいてありがとうございました。今日はこのあたりで終わりにします。";
        }
        if (closingCheckpointId === "difficulty") {
            return "引っかかった点も含めて率直に聞かせていただいてありがとうございました。今日はこのあたりで終わりにします。";
        }
        if (closingCheckpointId === "impression") {
            return "印象に残った点を聞かせていただいてありがとうございました。今日はこのあたりで終わりにします。";
        }
        return "お話を聞かせていただいてありがとうございました。今日はこのあたりで終わりにします。";
    }

    function buildOpeningMessage(sessionContext) {
        if (/まあまあ|よかった|参考/.test(sessionContext?.mood || "")) {
            return "今日はありがとうございました。印象に残った話があれば、そこから聞かせてください。";
        }
        if (/微妙|難しい|いまいち/.test(sessionContext?.mood || "")) {
            return "今日はありがとうございました。引っかかったところがあれば、そのことから聞かせてください。";
        }
        return "今日はありがとうございました。印象に残ったことがあれば、一言だけ聞かせてください。";
    }

    function buildMetaConversationClosing() {
        return "噛み合っていない感じになってしまいましたね。ここでいったん止めます。";
    }

    function currentTopic(checkpoints, activeCheckpointId) {
        return activeCheckpointId || nextMissingCheckpointId(checkpoints) || "";
    }

    global.SokraInterviewFlow = {
        CHECKPOINTS,
        createCheckpoints,
        checkpointForStep,
        nextMissingCheckpointId,
        checkpointDone,
        syncActiveCheckpoint,
        isLowEnergyReply,
        isMetaConversationReply,
        getUserSignal,
        buildResistanceResponse,
        detectAnsweredCheckpoints,
        chooseNextStep,
        buildPlannedTurn,
        buildClosingMessage,
        buildOpeningMessage,
        buildMetaConversationClosing,
        currentTopic
    };
})(window);
