// socketHandler.js
// افترض وجود roomManager معرف مسبقاً في نفس الملف أو مستورد من مكان آخر
const roomManager = require('./roomManager'); // مثال على الاستيراد

module.exports = (io, socket) => {
    // ========== معالج الانضمام كمشاهد ==========
    socket.on("spectator_join_game", (data) => {
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;

        // إذا كان المستخدم أصلاً لاعبًا في الغرفة، لا يمكنه الانضمام كمشاهد
        if (room.players.some(p => p.id === socket.id)) {
            socket.emit("error", { message: "أنت بالفعل لاعب في هذه الغرفة" });
            return;
        }

        // تحويل المستخدم إلى مشاهد
        socket.data.type = "SPECTATOR";
        room.spectators = room.spectators || [];
        if (!room.spectators.includes(socket.id)) {
            room.spectators.push(socket.id);
        }

        // إرسال حالة منقحة للمشاهد
        socket.emit("room_state", {
            players: room.players.map(p => ({
                id: p.id,
                username: p.username,
                alive: p.alive,
                userType: p.userType,
                role: null
            })),
            phase: room.engine.phase,
            round: room.engine.round
        });

        // إعلام الآخرين بوجود مشاهد جديد (اختياري)
        socket.to(room.id).emit("spectator_joined", { spectatorId: socket.id });
    });

    // ========== معالج طلب حالة الغرفة (مضاف حديثاً) ==========
    socket.on("request_room_state", () => {
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;

        const isSpectator = socket.data.type === "SPECTATOR";

        const filteredPlayers = room.players.map(p => ({
            id:       p.id,
            username: p.username,
            alive:    p.alive,
            userType: p.userType,
            // المشاهد ما يشوف أي دور
            role: isSpectator ? null :
                  (p.id === socket.id || socket.data.isAdmin) ? p.role : null,
        }));

        if (!isSpectator) {
            const myPlayer = room.players.find(p => p.id === socket.id);
            if (myPlayer?.role === "MAFIA") {
                filteredPlayers.forEach(fp => {
                    const orig = room.players.find(p => p.id === fp.id);
                    if (orig?.role === "MAFIA") fp.role = "MAFIA";
                });
            }
        }

        socket.emit("room_state", {
            players: filteredPlayers,
            phase:   room.engine.phase,
            round:   room.engine.round
        });
    });

    // ========== يمكن إضافة معالجات أخرى هنا ==========
    // مثال:
    // socket.on("disconnect", () => { ... });
    // socket.on("some_other_event", () => { ... });
};