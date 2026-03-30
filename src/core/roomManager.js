// src/core/roomManager.js
const { v4: uuidv4 } = require("uuid");
const GameEngine     = require("../game/GameEngine");
const logger         = require("../utils/logger");

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId → room
    }

    createRoom(players, io, adminId = null) {
        const roomId = uuidv4();

        const roomPlayers = players.map(p => ({
            id:       p.id,
            username: p.username,
            avatar:   p.avatar || "😎",
            color:    p.color  || "#1e293b",
            role:     null,
            alive:    true,
        }));

        const room = {
            id:         roomId,
            players:    roomPlayers,
            spectators: [],
            engine:     null,
            createdAt:  Date.now(),
        };

        room.engine = new GameEngine(roomPlayers, io, roomId, adminId);

        this.rooms.set(roomId, room);
        logger.info("ROOM", "Room created", { roomId, players: roomPlayers.length });

        return room;
    }

    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    removeRoom(roomId) {
        if (this.rooms.has(roomId)) {
            this.rooms.delete(roomId);
            logger.info("ROOM", "Room removed", { roomId });
        }
    }

    getAllRooms() {
        return Array.from(this.rooms.values());
    }
}

module.exports = new RoomManager();