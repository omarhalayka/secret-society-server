// src/utils/errors.js
// نظام أخطاء موحّد — كل emit خطأ يمر من هنا

const ERROR_TYPES = {
    // Auth
    INVALID_PASSWORD:   "INVALID_PASSWORD",
    UNAUTHORIZED:       "UNAUTHORIZED",
    // Queue / Room
    ALREADY_IN_QUEUE:   "ALREADY_IN_QUEUE",
    ROOM_NOT_FOUND:     "ROOM_NOT_FOUND",
    GAME_NOT_ACTIVE:    "GAME_NOT_ACTIVE",
    // Game Actions
    WRONG_PHASE:        "WRONG_PHASE",
    INVALID_TARGET:     "INVALID_TARGET",
    ALREADY_VOTED:      "ALREADY_VOTED",
    ACTION_USED:        "ACTION_USED",
    SELF_TARGET:        "SELF_TARGET",
    REPEAT_TARGET:      "REPEAT_TARGET",
    PLAYER_DEAD:        "PLAYER_DEAD",
    // Input
    INVALID_INPUT:      "INVALID_INPUT",
    RATE_LIMITED:       "RATE_LIMITED",
    // Rejoin
    REJOIN_FAILED:      "REJOIN_FAILED",
    INVALID_CODE:       "INVALID_CODE",
};

/**
 * إرسال خطأ موحّد لـ socket واحد
 * @param {import("socket.io").Socket} socket
 * @param {string} type - من ERROR_TYPES
 * @param {string} message - رسالة للمستخدم
 * @param {object} [extra] - بيانات إضافية اختيارية
 */
function emitError(socket, type, message, extra = {}) {
    socket.emit("game_error", {
        type,
        message,
        ...extra,
    });
}

module.exports = { ERROR_TYPES, emitError };