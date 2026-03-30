const roomManager = require("./roomManager");

class MatchmakingManager {
    constructor() {
        this.queue = [];
        this.requiredPlayers = 6;
    }

    setRequiredPlayers(count) {
        const n = parseInt(count);
        if (n >= 4 && n <= 12) {
            this.requiredPlayers = n;
            console.log(`Required players set to: ${this.requiredPlayers}`);
        }
    }

    addToQueue(player, io) {
        if (this.queue.find(p => p.id === player.id)) return null;

        this.queue.push(player);
        console.log(`Player joined queue: ${player.username} | Queue: ${this.queue.length}/${this.requiredPlayers}`);

        if (this.queue.length >= this.requiredPlayers) {
            return this.createMatch(io);
        }
        return null;
    }

    removeFromQueue(socketId) {
        const before = this.queue.length;
        this.queue = this.queue.filter(p => p.id !== socketId);
        if (this.queue.length < before) {
            console.log(`Queue size: ${this.queue.length}/${this.requiredPlayers}`);
        }
    }

    createMatch(io) {
        const playersForMatch = this.queue.splice(0, this.requiredPlayers);

        // ابحث عن الأدمن المتصل
        let adminId = null;
        io.sockets.sockets.forEach((client) => {
            if (client.data && client.data.isAdmin) adminId = client.id;
        });

        console.log("Creating match with players:");
        playersForMatch.forEach(p => console.log(` - ${p.username}`));

        // ─── أنشئ الغرفة ───
        const room = roomManager.createRoom(playersForMatch, io, adminId);
        console.log("Room created:", room.id);

        // ─── ربط كل لاعب بالـ socket room باستخدام callback ───
        // نحسب كم لاعب أنهى الـ join عشان نبدأ اللعبة بعد اكتمالهم
        let joinedCount = 0;
        const totalExpected = playersForMatch.length + (adminId ? 1 : 0);

        const onAllJoined = () => {
            joinedCount++;
            if (joinedCount >= totalExpected) {
                console.log(`All ${joinedCount} sockets joined room ${room.id} — starting game`);
                room.engine.startGame();
            }
        };

        playersForMatch.forEach(player => {
            const socket = io.sockets.sockets.get(player.id);
            if (!socket) {
                // اللاعب انقطع — عدّه كـ joined عشان ما نعلق
                onAllJoined();
                return;
            }
            socket.join(room.id, onAllJoined);
            socket.data.roomId = room.id;
            console.log(`Player ${player.username} joining socket room ${room.id}`);
        });

        // ─── ربط الأدمن إن وجد ───
        if (adminId) {
            const adminSocket = io.sockets.sockets.get(adminId);
            if (adminSocket) {
                adminSocket.join(room.id, onAllJoined);
                adminSocket.data.roomId = room.id;
                room.engine.adminId = adminId;
                console.log("Admin attached to room:", room.id);
            } else {
                // الأدمن غير متصل — عدّه كـ joined
                onAllJoined();
            }
        }

        // ─── Fallback: لو الـ callback ما اشتغل خلال 3 ثواني (socket.join قديم لا يدعم callback) ───
        setTimeout(() => {
            if (joinedCount < totalExpected && !room.engine.gameStarted) {
                console.warn(`Fallback: starting game after timeout (joined ${joinedCount}/${totalExpected})`);
                room.engine.startGame();
            }
        }, 3000);

        return room;
    }

    getQueueSize() {
        return this.queue.length;
    }
}

module.exports = new MatchmakingManager();