// src/websocket/socketHandler.js
// يُعالج فقط request_room_state — يُنادى من index.js
const roomManager = require("../core/roomManager");

module.exports = function socketHandler(io, socket) {
    const room = roomManager.getRoom(socket.data.roomId);
    if (!room?.engine) return;

    const isAdmin     = socket.data.isAdmin;
    const isSpectator = socket.data.type === "SPECTATOR";
    const myPlayer    = room.players.find(p => p.id === socket.id);

    const filteredPlayers = room.players.map(p => {
        // الأدمن يرى كل الأدوار
        if (isAdmin) {
            return { ...p };
        }
        // المشاهد لا يرى أي دور
        if (isSpectator) {
            return { id: p.id, username: p.username, alive: p.alive, avatar: p.avatar, color: p.color, role: null };
        }
        // اللاعب يرى دوره فقط + زملاء المافيا
        const showRole =
            p.id === socket.id ||                             // نفسه
            !p.alive ||                                       // ميت — الكل يعرف دوره
            (myPlayer?.role === "MAFIA" && p.role === "MAFIA"); // المافيا تعرف بعضها

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