// src/utils/validate.js
// تحقق من كل input قبل ما يلمس game state
// المبدأ: لا تثق بأي شيء يجي من الـ client

const VALID_ROLES = ["MAFIA", "DOCTOR", "DETECTIVE", "CITIZEN"];

/**
 * username: string، 2-20 حرف، بدون رموز خطرة
 */
function username(val) {
    if (typeof val !== "string") return null;
    const clean = val.trim().replace(/[<>&"'/\\]/g, "").slice(0, 20);
    return clean.length >= 2 ? clean : null;
}

/**
 * socketId: string بسيطة
 */
function socketId(val) {
    if (typeof val !== "string") return null;
    const clean = val.trim();
    return clean.length > 0 && clean.length <= 40 ? clean : null;
}

/**
 * roomId: UUID string
 */
function roomId(val) {
    if (typeof val !== "string") return null;
    const clean = val.trim();
    // UUID format لكن ما نشترطه بشكل صارم
    return clean.length > 0 && clean.length <= 50 ? clean : null;
}

/**
 * role: من القائمة المسموح بها فقط
 */
function role(val) {
    if (typeof val !== "string") return null;
    return VALID_ROLES.includes(val) ? val : null;
}

/**
 * message: string، max 200 حرف، بدون HTML
 */
function message(val) {
    if (typeof val !== "string") return null;
    const clean = val.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 200);
    return clean.length > 0 ? clean : null;
}

/**
 * password: string، max 50 حرف
 */
function password(val) {
    if (typeof val !== "string") return null;
    return val.trim().slice(0, 50) || null;
}

/**
 * code: 6 أرقام بالضبط
 */
function rejoinCode(val) {
    if (typeof val !== "string") return null;
    const clean = val.trim();
    return /^\d{6}$/.test(clean) ? clean : null;
}

/**
 * count: integer بين 4 و 12
 */
function playerCount(val) {
    const n = parseInt(val);
    return Number.isInteger(n) && n >= 4 && n <= 12 ? n : null;
}

module.exports = { username, socketId, roomId, role, message, password, rejoinCode, playerCount };