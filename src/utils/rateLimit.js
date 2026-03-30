// src/utils/rateLimit.js
// Rate limiter per-socket per-event — يمنع الـ spam على كل حدث بشكل مستقل

// هيكل البيانات:
// limits: Map< socketId, Map< eventName, { count, resetAt } > >
const limits = new Map();

/**
 * التحقق من rate limit لـ socket + event معين
 * @param {string} socketId
 * @param {string} event       - اسم الحدث
 * @param {number} maxCalls    - الحد الأقصى
 * @param {number} windowMs    - الفترة الزمنية بالمللي ثانية
 * @returns {boolean} - true = مسموح، false = محجوب
 */
function check(socketId, event, maxCalls, windowMs) {
    const now = Date.now();

    if (!limits.has(socketId)) limits.set(socketId, new Map());
    const socketLimits = limits.get(socketId);

    const entry = socketLimits.get(event) || { count: 0, resetAt: now + windowMs };

    // هل انتهت نافذة الوقت؟ إذاً ابدأ من الصفر
    if (now >= entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + windowMs;
    }

    entry.count++;
    socketLimits.set(event, entry);

    return entry.count <= maxCalls;
}

/**
 * تنظيف بيانات socket لما يقطع
 * @param {string} socketId
 */
function cleanup(socketId) {
    limits.delete(socketId);
}

// ─── حدود جاهزة لكل event ─────────────────────────────────────────────────
// استخدام: rateLimiter.events.CHAT(socketId)
const events = {
    // chat: 4 رسائل / 2 ثانية
    CHAT: (id) => check(id, "chat", 4, 2000),
    // mafia chat: 3 رسائل / 2 ثانية
    MAFIA_CHAT: (id) => check(id, "mafia_chat", 3, 2000),
    // game actions (kill/save/check): مرة واحدة / ثانية
    GAME_ACTION: (id) => check(id, "game_action", 1, 1000),
    // vote: مرة واحدة / 2 ثانية (يمنع ضغطات متعاقبة)
    VOTE: (id) => check(id, "vote", 1, 2000),
    // voice peer: 2 / ثانية
    VOICE: (id) => check(id, "voice", 2, 1000),
    // join queue: 3 / 5 ثواني (يمنع الـ reconnect spam)
    JOIN_QUEUE: (id) => check(id, "join_queue", 3, 5000),
    // set_username: 5 / 10 ثواني
    SET_USERNAME: (id) => check(id, "set_username", 5, 10000),
    // rejoin: 5 / دقيقة
    REJOIN: (id) => check(id, "rejoin", 5, 60000),
    // request_room_state: 10 / ثانية
    ROOM_STATE: (id) => check(id, "room_state", 10, 1000),
};

module.exports = { check, cleanup, events };