const lobbyManager       = require("../core/lobbyManager");
const matchmakingManager = require("../core/matchmakingManager");
const roomManager        = require("../core/roomManager");

function initializeSocket(io) {

    io.on("connection", (socket) => {

        const player = lobbyManager.addPlayer(socket);

        socket.emit("welcome", { message: "Connected to Secret Society", player });

        // ─────────────────────────────────────
        //  USERNAME
        // ─────────────────────────────────────
        socket.on("set_username", (username) => {
            if (typeof username !== "string" || username.trim().length < 3) return;
            const clean = username.trim().substring(0, 20);
            const updatedPlayer = lobbyManager.updateUsername(socket.id, clean);
            socket.emit("username_updated", updatedPlayer);
        });

        // ─────────────────────────────────────
        //  JOIN QUEUE
        // ─────────────────────────────────────
        socket.on("join_queue", (data) => {
            const p = lobbyManager.getPlayer(socket.id);
            if (!p) return;
            const type = data?.type || "player";
            if (type === "spectator" || type === "admin") return;
            socket.data.type = "PLAYER";
            socket.emit("role_type", { type: "PLAYER" });
            matchmakingManager.addToQueue(p, io);
        });

        // ─────────────────────────────────────
        //  ADMIN JOIN
        // ─────────────────────────────────────
        socket.on("join_admin", () => {
            socket.data.isAdmin = true;
            socket.data.type    = "ADMIN";

            const rooms      = roomManager.getAllRooms();
            const activeRoom = rooms.find(r => r.engine && r.engine.phase !== "GAME_OVER") || rooms[0];

            if (!activeRoom) {
                socket.emit("admin_joined");
                socket.emit("waiting_for_players", { message: "No active room yet. Waiting for players..." });
                console.log(`Admin ${socket.id} waiting — no active room`);
                return;
            }

            attachToRoom(socket, activeRoom);
            if (activeRoom.engine) activeRoom.engine.adminId = socket.id;
            socket.emit("admin_joined");
            console.log(`Admin ${socket.id} joined room ${activeRoom.id}`);
        });

        // ─────────────────────────────────────
        //  SPECTATOR JOIN
        // ─────────────────────────────────────
        socket.on("spectator_join_game", () => {
            socket.data.type = "SPECTATOR";

            const rooms      = roomManager.getAllRooms();
            const activeRoom = rooms.find(r => r.engine && r.engine.phase !== "GAME_OVER");

            if (!activeRoom) {
                socket.emit("error", { message: "No active game found to spectate" });
                return;
            }

            socket.join(activeRoom.id);
            socket.data.roomId = activeRoom.id;

            if (activeRoom.engine) activeRoom.engine.addSpectator(socket.id);

            socket.emit("game_started", { role: "SPECTATOR", roomId: activeRoom.id });
            socket.emit("room_state", {
                players: activeRoom.players,
                phase:   activeRoom.engine.phase,
                round:   activeRoom.engine.round
            });

            io.to(activeRoom.id).emit("spectator_joined", { message: "A spectator has joined" });
            console.log(`Spectator ${socket.id} joined room ${activeRoom.id}`);
        });

        // ─────────────────────────────────────
        //  GAME ACTIONS
        // ─────────────────────────────────────
        socket.on("mafia_kill", (targetId) => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerMafiaKill(socket.id, targetId);
        });

        socket.on("doctor_save", (targetId) => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerDoctorSave(socket.id, targetId);
        });

        socket.on("detective_check", (targetId) => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerDetectiveCheck(socket.id, targetId);
        });

        // ─────────────────────────────────────
        //  VOTING
        // ─────────────────────────────────────
        socket.on("vote", (targetId) => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            if (socket.data.isAdmin || socket.data.type === "SPECTATOR") return;
            room.engine.registerVote(socket.id, targetId);
        });

        // ─────────────────────────────────────
        //  ADMIN CONTROLS
        // ─────────────────────────────────────
        socket.on("admin_start_night", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.startNight();
        });

        socket.on("admin_end_night", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.endNight();
        });

        // ─────────────────────────────────────
        //  ADMIN REVEAL NIGHT RESULTS
        //  FIX: نحفظ النتائج قبل executeNightResults يمسحها
        //  FIX: نبعث night_results_revealed للاعبين (MAFIA/DOCTOR/DETECTIVE)
        // ─────────────────────────────────────
        socket.on("admin_reveal_night_results", (storyText) => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            console.log("Admin revealing night results, story:", storyText);

            // FIX: executeNightResults ترجع النتائج المحفوظة قبل التنظيف
            const results = room.engine.executeNightResults();

            // بعث النتائج للمافيا/دكتور/محقق
            room.engine.players.forEach(p => {
                if (["MAFIA", "DOCTOR", "DETECTIVE"].includes(p.role)) {
                    io.to(p.id).emit("night_review", {
                        mafiaTarget:     results.mafiaTarget,
                        doctorSave:      results.doctorSave,
                        detectiveChecks: results.detectiveChecks,
                        finalVictim:     results.finalVictim,
                    });
                }
            });

            // القصة لكل الغرفة
            io.to(room.id).emit("night_story", {
                story:  storyText || "The night passed in silence...",
                victim: results.finalVictim
            });

            // الانتقال للنهار
            room.engine.startDay();
        });

        socket.on("admin_start_voting", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.startVoting();
        });

        socket.on("admin_end_voting", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.endVoting();
        });

        socket.on("admin_end_game", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.endGame("ADMIN_FORCED");
        });

        // ─────────────────────────────────────
        //  RESTART GAME
        //  FIX: نمسح room_state الزائدة — startGame() يبعثها مرة واحدة كافية
        // ─────────────────────────────────────
        socket.on("restart_game", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            console.log(`Admin restarting game in room ${room.id}`);
            room.engine.resetGame();

            // delay 1 ثانية — وقت للـ client يعالج back_to_lobby ويرجع للـ GameScene
            setTimeout(() => {
                room.engine.startGame();
                // startGame() يبعث game_started + room_state للكل — لا نحتاج نبعث مرة ثانية
            }, 1000);
        });

        // ─────────────────────────────────────
        //  STATE REQUEST
        // ─────────────────────────────────────
        socket.on("request_room_state", () => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            socket.emit("room_state", {
                players: room.players,
                phase:   room.engine.phase,
                round:   room.engine.round
            });
        });

        // ─────────────────────────────────────
        //  QUEUE STATUS
        // ─────────────────────────────────────
        socket.on("request_queue_status", () => {
            socket.emit("queue_update", {
                queueSize: matchmakingManager.getQueueSize()
            });
        });

        // ─────────────────────────────────────
        //  CHAT — مفتوح للكل دائماً
        //  الأدمن، اللاعبون (أحياء وأموات)، المشاهدون
        // ─────────────────────────────────────
        socket.on("send_message", (message) => {
            if (typeof message !== "string" || message.trim().length === 0) return;

            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            const clean = message.trim().substring(0, 200);

            let senderUsername = null;
            let senderAlive    = true;

            if (socket.data.isAdmin) {
                senderUsername = "ADMIN 👑";
                senderAlive    = true;
            } else if (socket.data.type === "SPECTATOR") {
                senderUsername = "SPECTATOR 👁";
                senderAlive    = true;
            } else {
                const p = room.players.find(pl => pl.id === socket.id);
                if (!p) return;
                senderUsername = p.username;
                senderAlive    = p.alive;
            }

            io.to(room.id).emit("receive_message", {
                username: senderUsername,
                message:  clean,
                alive:    senderAlive
            });
        });

        // ─────────────────────────────────────
        //  DISCONNECT
        // ─────────────────────────────────────
        socket.on("disconnect", () => {
            if (socket.data.type === "SPECTATOR" && socket.data.roomId) {
                const room = roomManager.getRoom(socket.data.roomId);
                if (room?.engine) room.engine.removeSpectator(socket.id);
            }
            lobbyManager.removePlayer(socket.id);
            matchmakingManager.removeFromQueue(socket.id);
        });

    });

    // ─── helper: ربط الأدمن/المشاهد بغرفة موجودة ───
    function attachToRoom(socket, room) {
        socket.join(room.id);
        socket.data.roomId = room.id;

        const role = socket.data.isAdmin ? "ADMIN" : "SPECTATOR";

        socket.emit("game_started", { roomId: room.id, role });
        socket.emit("room_state", {
            players: room.players,
            phase:   room.engine?.phase || "LOBBY",
            round:   room.engine?.round || 1
        });
    }
}

module.exports = initializeSocket;