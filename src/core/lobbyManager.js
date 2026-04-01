// src/core/lobbyManager.js
const logger = require("../utils/logger");

class LobbyManager {
    constructor() {
        this.players = new Map(); // socketId → player
        this.playerIdBySocket = new Map(); // socketId → playerId
        this.playerByPlayerId = new Map(); // playerId → player
    }

    addPlayer(socketId, playerId) {
        const player = {
            id:          socketId,
            playerId:    playerId,
            username:    `Guest_${socketId.substring(0, 5)}`,
            avatar:      "😎",
            color:       "#1e293b",
            connectedAt: Date.now(),
            connected:   true,
        };
        this.players.set(socketId, player);
        this.playerIdBySocket.set(socketId, playerId);
        this.playerByPlayerId.set(playerId, player);
        logger.connect(socketId);
        return player;
    }

    markDisconnected(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            player.connected = false;
            // لا نحذف من الخرائط حتى يتمكن من إعادة الاتصال
            logger.debug("LOBBY", `Player ${player.username} marked disconnected`);
        }
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            this.players.delete(socketId);
            this.playerIdBySocket.delete(socketId);
            this.playerByPlayerId.delete(player.playerId);
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

    getPlayerByPlayerId(playerId) {
        return this.playerByPlayerId.get(playerId) || null;
    }

    getAllPlayers() {
        return Array.from(this.players.values());
    }

    getPlayerCount() {
        return this.players.size;
    }
}

module.exports = new LobbyManager();