// src/websocket/socketHandler.js
const roomManager = require("../core/roomManager");

module.exports = function socketHandler(io, socket) {
    const room = roomManager.getRoom(socket.data.roomId);
    if (!room?.engine) return;

    const isAdmin = socket.data.isAdmin;
    const isSpectator = socket.data.type === "SPECTATOR";
    const myPlayer = room.players.find((p) => p.playerId === socket.data.playerId || p.socketId === socket.id);

    const filteredPlayers = room.players.map((player) => {
        if (isAdmin) {
            return {
                id: player.playerId,
                playerId: player.playerId,
                socketId: player.socketId,
                username: player.username,
                alive: player.alive,
                avatar: player.avatar || "?",
                color: player.color || "#1e293b",
                role: player.role,
            };
        }

        const showRole = !isSpectator && (
            player.playerId === socket.data.playerId ||
            (myPlayer?.role === "MAFIA" && player.role === "MAFIA")
        );

        return {
            id: player.playerId,
            playerId: player.playerId,
            socketId: player.socketId,
            username: player.username,
            alive: player.alive,
            avatar: player.avatar || "?",
            color: player.color || "#1e293b",
            role: showRole ? player.role : null,
        };
    });

    socket.emit("room_state", {
        players: filteredPlayers,
        phase: room.engine.phase,
        round: room.engine.round,
    });
};
