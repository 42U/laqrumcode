const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = process.env.KONGCODE_LOG_LEVEL ?? "warn";
if (currentLevel === "debug") {
    console.warn("[kongcode] KONGCODE_LOG_LEVEL=debug — logs may contain user prompts and query data. Do not use in shared environments.");
}
export const log = {
    error: (...args) => { if (LEVELS[currentLevel] >= LEVELS.error)
        console.error("[kongcode]", ...args); },
    warn: (...args) => { if (LEVELS[currentLevel] >= LEVELS.warn)
        console.warn("[kongcode]", ...args); },
    info: (...args) => { if (LEVELS[currentLevel] >= LEVELS.info)
        console.info("[kongcode]", ...args); },
    debug: (...args) => { if (LEVELS[currentLevel] >= LEVELS.debug)
        console.debug("[kongcode]", ...args); },
};
