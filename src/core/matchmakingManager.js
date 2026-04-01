const roomManager = require("./roomManager");
const logger      = require("../utils/logger");

class MatchmakingManager {
    constructor() {
        this.queue           = [];
        this.requiredPlayers = 6;
    }

    _getQueueKey(player) {
        return player?.playerId || player?.id || null;
    }

    setRequiredPlayers(count) {
        const n = parseInt(count);
        if (n >= 4 && n <= 12) {
            this.requiredPlayers = n;
            logger.info("MATCH", `Required players set to ${n}`);
        }
    }

    addToQueue(player, io) {
        const queueKey = this._getQueueKey(player);
        if (!queueKey) return null;

        const existing = this.queue.find((p) => this._getQueueKey(p) === queueKey);
        if (existing) {
            existing.id = player.id;
            existing.username = player.username;
            existing.avatar = player.avatar;
            existing.color = player.color;
            existing.connected = true;
            return null;
        }

        this.queue.push(player);
        logger.join(player.username, `queue ${this.queue.length}/${this.requiredPlayers}`);

        if (this.queue.length >= this.requiredPlayers) {
            return this.createMatch(io);
        }
        return null;
    }

    removeFromQueue(socketId) {
        const before = this.queue.length;
        this.queue = this.queue.filter((p) => p.id !== socketId);
        if (this.queue.length < before) {
            logger.info("MATCH", "Player removed from queue", {
                remaining: this.queue.length,
            });
        }
    }

    createMatch(io) {
        const playersForMatch = this.queue.splice(0, this.requiredPlayers);

        const uniquePlayers = [];
        const seen = new Set();
        for (const p of playersForMatch) {
            const key = this._getQueueKey(p);
            if (key && !seen.has(key)) {
                seen.add(key);
                uniquePlayers.push(p);
            }
        }

        if (uniquePlayers.length !== playersForMatch.length) {
            logger.warn("MATCH", "Duplicate players in queue removed", {
                before: playersForMatch.length,
                after: uniquePlayers.length,
            });
        }

        if (uniquePlayers.length < this.requiredPlayers) {
            this.queue = uniquePlayers.concat(this.queue);
            logger.warn("MATCH", "Match creation deferred after duplicate cleanup", {
                playersReady: uniquePlayers.length,
                required: this.requiredPlayers,
            });
            return null;
        }

        let adminId = null;
        io.sockets.sockets.forEach((client) => {
            if (client.data?.isAdmin) adminId = client.id;
        });

        logger.info("MATCH", "Creating match", {
            players: uniquePlayers.map((p) => p.username).join(", "),
            adminId: adminId ? "yes" : "none",
        });

        const room = roomManager.createRoom(uniquePlayers, io, adminId);

        let joinedCount = 0;
        const allSockets = [...uniquePlayers.map((p) => p.id)];
        if (adminId) allSockets.push(adminId);
        const totalExpected = allSockets.length;

        const onAllJoined = () => {
            joinedCount += 1;
            if (joinedCount >= totalExpected) {
                logger.info("MATCH", `All sockets joined room ${room.id} — starting game`);
                room.engine.startGame();
            }
        };

        uniquePlayers.forEach((player) => {
            const socket = io.sockets.sockets.get(player.id);
            if (!socket) {
                onAllJoined();
                return;
            }
            socket.data.roomId = room.id;
            socket.join(room.id, onAllJoined);
        });

        if (adminId) {
            const adminSocket = io.sockets.sockets.get(adminId);
            if (adminSocket) {
                adminSocket.data.roomId = room.id;
                room.engine.adminId = adminId;
                adminSocket.join(room.id, onAllJoined);
            } else {
                onAllJoined();
            }
        }

        const fallbackTimer = setTimeout(() => {
            if (!room.engine.gameStarted) {
                logger.warn("MATCH", "Fallback: starting game via timeout", { roomId: room.id });
                room.engine.startGame();
            }
        }, 3000);

        const originalStartGame = room.engine.startGame.bind(room.engine);
        room.engine.startGame = function () {
            clearTimeout(fallbackTimer);
            room.engine.startGame = originalStartGame;
            originalStartGame();
        };

        return room;
    }

    getQueueSize() {
        return this.queue.length;
    }
}

module.exports = new MatchmakingManager();
