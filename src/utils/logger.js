// src/utils/logger.js
// Logger بسيط وواضح — كل event مهم يُسجّل هنا

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function timestamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fmt(level, category, msg, data) {
    const base = `[${timestamp()}] [${level}] [${category}] ${msg}`;
    if (data && Object.keys(data).length > 0) {
        return base + " | " + JSON.stringify(data);
    }
    return base;
}

const logger = {
    debug: (category, msg, data = {}) => {
        if (CURRENT_LEVEL <= LEVELS.DEBUG)
            console.debug(fmt("DEBUG", category, msg, data));
    },
    info: (category, msg, data = {}) => {
        if (CURRENT_LEVEL <= LEVELS.INFO)
            console.log(fmt("INFO ", category, msg, data));
    },
    warn: (category, msg, data = {}) => {
        if (CURRENT_LEVEL <= LEVELS.WARN)
            console.warn(fmt("WARN ", category, msg, data));
    },
    error: (category, msg, data = {}) => {
        if (CURRENT_LEVEL <= LEVELS.ERROR)
            console.error(fmt("ERROR", category, msg, data));
    },

    // shortcuts للأحداث المهمة
    connect:    (socketId) => logger.info("CONN",    `+ connected`,       { socketId }),
    disconnect: (socketId, reason) => logger.info("CONN", `- disconnected`, { socketId, reason }),
    join:       (username, roomId) => logger.info("QUEUE",  `joined queue`,    { username, roomId }),
    kill:       (by, target, round) => logger.info("GAME",  `mafia kill`,      { by, target, round }),
    save:       (by, target, round) => logger.info("GAME",  `doctor save`,     { by, target, round }),
    check:      (by, target, result) => logger.info("GAME", `detective check`, { by, target, result }),
    vote:       (by, target, round) => logger.info("GAME",  `vote cast`,       { by, target, round }),
    phase:      (phase, round, roomId) => logger.info("GAME", `phase changed`,  { phase, round, roomId }),
    win:        (winner, roomId, round) => logger.info("GAME", `game over`,     { winner, roomId, round }),
    rejoin:     (username, roomId) => logger.info("REJOIN", `rejoined`,        { username, roomId }),
    adminAct:   (action, roomId) => logger.info("ADMIN",  `action`,           { action, roomId }),
};

module.exports = logger;