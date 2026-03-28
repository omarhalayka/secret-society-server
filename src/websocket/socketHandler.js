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