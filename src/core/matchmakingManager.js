// src/core/matchmakingManager.js
const roomManager = require("./roomManager");
const logger      = require("../utils/logger");

class MatchmakingManager {
    constructor() {
        this.queue           = [];
        this.requiredPlayers = 6;
    }

    setRequiredPlayers(count) {
        const n = parseInt(count);
        if (n >= 4 && n <= 12) {
            this.requiredPlayers = n;
            logger.info("MATCH", `Required players set to ${n}`);
        }
    }

    addToQueue(player, io) {
        // لا تضيف نفس اللاعب مرتين
        if (this.queue.find(p => p.id === player.id)) return null;

        this.queue.push(player);
        logger.join(player.username, `queue ${this.queue.length}/${this.requiredPlayers}`);

        if (this.queue.length >= this.requiredPlayers) {
            return this.createMatch(io);
        }
        return null;
    }

    removeFromQueue(socketId) {
        const before = this.queue.length;
        this.queue = this.queue.filter(p => p.id !== socketId);
        if (this.queue.length < before) {
            logger.info("MATCH", `Player removed from queue`, {
                remaining: this.queue.length,
            });
        }
    }

    createMatch(io) {
        const playersForMatch = this.queue.splice(0, this.requiredPlayers);

        // إزالة أي تكرار في قائمة اللاعبين (قد يحدث بسبب انقطاع غير صحيح)
        const uniquePlayers = [];
        const seen = new Set();
        for (const p of playersForMatch) {
            if (!seen.has(p.id)) {
                seen.add(p.id);
                uniquePlayers.push(p);
            }
        }
        if (uniquePlayers.length !== playersForMatch.length) {
            logger.warn("MATCH", "Duplicate players in queue removed", { 
                before: playersForMatch.length, 
                after: uniquePlayers.length 
            });
        }
        // استخدم القائمة المنظفة
        const cleanPlayers = uniquePlayers;

        // ابحث عن الأدمن المتصل
        let adminId = null;
        io.sockets.sockets.forEach((client) => {
            if (client.data?.isAdmin) adminId = client.id;
        });

        logger.info("MATCH", "Creating match", {
            players: cleanPlayers.map(p => p.username).join(", "),
            adminId: adminId ? "yes" : "none",
        });

        const room = roomManager.createRoom(cleanPlayers, io, adminId);

        // ─── ربط الـ sockets بالغرفة ─────────────────────────────────────
        // نستخدم Promise.all مع callback لضمان اكتمال الـ join قبل startGame
        let joinedCount      = 0;
        const allSockets     = [...cleanPlayers.map(p => p.id)];
        if (adminId) allSockets.push(adminId);
        const totalExpected  = allSockets.length;

        const onAllJoined = () => {
            joinedCount++;
            if (joinedCount >= totalExpected) {
                logger.info("MATCH", `All sockets joined room ${room.id} — starting game`);
                room.engine.startGame();
            }
        };

        cleanPlayers.forEach(player => {
            const socket = io.sockets.sockets.get(player.id);
            if (!socket) {
                // اللاعب انقطع — عدّه عشان ما نعلق
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
                room.engine.adminId    = adminId;
                adminSocket.join(room.id, onAllJoined);
            } else {
                onAllJoined();
            }
        }

        // ─── Fallback: لو socket.join لا يدعم callback في هذا الإصدار ────
        // (Socket.io v4 يدعمه، لكن كـ safety net)
        const fallbackTimer = setTimeout(() => {
            if (!room.engine.gameStarted) {
                logger.warn("MATCH", "Fallback: starting game via timeout", { roomId: room.id });
                room.engine.startGame();
            }
        }, 3000);

        // إلغاء الـ fallback لو اللعبة بدأت بشكل طبيعي
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