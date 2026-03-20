const roomManager = require("./roomManager");

class MatchmakingManager {
    constructor() {
        this.queue = [];
        this.requiredPlayers = 6; // القيمة الافتراضية
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
        console.log(`Player joined queue: ${player.username} | Queue: ${this.queue.length}`);

        if (this.queue.length >= this.requiredPlayers) {
            return this.createMatch(io);
        }
        return null;
    }

    removeFromQueue(socketId) {
        this.queue = this.queue.filter(p => p.id !== socketId);
        console.log(`Queue size: ${this.queue.length}`);
    }

    createMatch(io) {
        const playersForMatch = this.queue.splice(0, this.requiredPlayers);

        // ابحث عن الأدمن المتصل
        let adminId = null;
        io.sockets.sockets.forEach((client) => {
            if (client.data && client.data.type === "ADMIN") adminId = client.id;
        });

        console.log("Creating match with players:");
        playersForMatch.forEach(p => console.log(` - ${p.username}`));

        // ─── أنشئ الغرفة ───
        const room = roomManager.createRoom(playersForMatch, io, adminId);
        console.log("Room created:", room.id);

        // ─── ربط كل لاعب بالـ socket room ───
        // نعمل join هنا فقط — game_started سيبعثه engine.startGame()
        playersForMatch.forEach(player => {
            const socket = io.sockets.sockets.get(player.id);
            if (!socket) return;
            socket.join(room.id);
            socket.data.roomId = room.id;
            console.log(`Player ${player.username} joined socket room ${room.id}`);
        });

        // ─── ربط الأدمن إن وجد ───
        if (adminId) {
            const adminSocket = io.sockets.sockets.get(adminId);
            if (adminSocket) {
                adminSocket.join(room.id);
                adminSocket.data.roomId = room.id;
                room.engine.adminId = adminId; // تأكد إن الـ engine يعرف الأدمن
                console.log("Admin attached to room:", room.id);
            }
        }

        // ─── startGame: يعمل assignRoles + يبعث game_started + room_state + startNight ───
        // نأخر 300ms عشان كل socket.join ينتهي أولاً
        setTimeout(() => {
            room.engine.startGame();
        }, 300);

        return room;
    }

    getQueueSize() {
        return this.queue.length;
    }
}

module.exports = new MatchmakingManager();