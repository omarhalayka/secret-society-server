// src/websocket/socketHandler.js
// يعالج request_room_state — مع فلترة صارمة للأدوار
const roomManager = require("../core/roomManager");

module.exports = function socketHandler(io, socket) {
    const room = roomManager.getRoom(socket.data.roomId);
    if (!room?.engine) return;

    const isAdmin     = socket.data.isAdmin;
    const isSpectator = socket.data.type === "SPECTATOR";
    const myPlayer    = room.players.find(p => p.id === socket.id);

    const filteredPlayers = room.players.map(p => {
        // ─── الأدمن: يرى كل الأدوار ──────────────────────────────────────
        if (isAdmin) {
            return { ...p };
        }

        // ─── المشاهد: لا يرى أي دور إطلاقاً ─────────────────────────────
        // حتى الميتين — المشاهد يشاهد فقط الأسماء والحياة
        if (isSpectator) {
            return {
                id:       p.id,
                username: p.username,
                alive:    p.alive,
                avatar:   p.avatar  || "😎",
                color:    p.color   || "#1e293b",
                role:     null,  // ✅ لا يُرسل الدور للمشاهد أبداً
            };
        }

        // ─── اللاعب العادي ────────────────────────────────────────────────
        const showRole =
            p.id === socket.id ||                              // نفسه دائماً
            (myPlayer?.role === "MAFIA" && p.role === "MAFIA"); // المافيا تعرف بعضها

        // ملاحظة: الميتون لا يُكشف دورهم هنا — يُكشف فقط عند game_over
        // هذا يمنع الغش عبر room_state

        return {
            id:       p.id,
            username: p.username,
            alive:    p.alive,
            avatar:   p.avatar || "😎",
            color:    p.color  || "#1e293b",
            role:     showRole ? p.role : null,
        };
    });

    socket.emit("room_state", {
        players: filteredPlayers,
        phase:   room.engine.phase,
        round:   room.engine.round,
    });
};