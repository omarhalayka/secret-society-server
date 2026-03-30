// src/core/lobbyManager.js
const logger = require("../utils/logger");

class LobbyManager {
    constructor() {
        this.players = new Map(); // socketId → player
    }

    addPlayer(socket) {
        const player = {
            id:          socket.id,
            username:    `Guest_${socket.id.substring(0, 5)}`,
            avatar:      "😎",
            color:       "#1e293b",
            connectedAt: Date.now(),
        };
        this.players.set(socket.id, player);
        logger.connect(socket.id);
        return player;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            this.players.delete(socketId);
            logger.disconnect(socketId, "removed from lobby");
        }
    }

    updateUsername(socketId, newUsername) {
        const player = this.players.get(socketId);
        if (!player) return null;
        player.username = newUsername;
        return player;
    }

    getPlayer(socketId) {
        return this.players.get(socketId) || null;
    }

    getAllPlayers() {
        return Array.from(this.players.values());
    }

    getPlayerCount() {
        return this.players.size;
    }
}

module.exports = new LobbyManager();