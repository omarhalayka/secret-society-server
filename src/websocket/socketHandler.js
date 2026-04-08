// src/websocket/socketHandler.js
const roomManager = require("../core/roomManager");

module.exports = function socketHandler(io, socket) {
    const room = roomManager.getRoom(socket.data.roomId);
    if (!room?.engine) return;

    socket.emit("room_state", room.engine.getRoomStatePayload({
        socketId: socket.id,
        playerId: socket.data.playerId,
        isAdmin: !!socket.data.isAdmin,
        isSpectator: socket.data.type === "SPECTATOR",
    }));
};
