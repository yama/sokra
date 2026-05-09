(function (global) {
    const CHECKPOINTS = [
        { id: "background", label: "参加背景", done: false },
        { id: "temperature", label: "温度感", done: false },
        { id: "impression", label: "印象点", done: false },
        { id: "difficulty", label: "違和感・難しさ", done: false },
        { id: "practical", label: "実務との接点", done: false }
    ];

    function createCheckpoints() {
        return CHECKPOINTS.map(cp => ({ ...cp }));
    }

    global.SokraInterviewFlow = { CHECKPOINTS, createCheckpoints };
})(window);
