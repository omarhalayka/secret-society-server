const lobbyManager       = require("../core/lobbyManager");
const matchmakingManager = require("../core/matchmakingManager");
const roomManager        = require("../core/roomManager");

// ─── كلمة سر الجلسة الحالية — يحددها الأدمن كل مرة ───
let sessionPassword = null;

function initializeSocket(io) {

    io.on("connection", (socket) => {

        const player = lobbyManager.addPlayer(socket);

        socket.emit("welcome", {
            message: "Connected to Secret Society",
            player
        });

        // ─── أبلغ الـ client بحالة كلمة السر الحالية فوراً ───
        socket.emit("session_password_ready", { ready: !!sessionPassword });

        // ================= USERNAME =================

        socket.on("set_username", (username) => {
            if (typeof username !== "string" || username.trim().length < 3) return;
            const clean = username.trim().substring(0, 20);
            const updatedPlayer = lobbyManager.updateUsername(socket.id, clean);
            socket.emit("username_updated", updatedPlayer);
        });

        // ================= JOIN QUEUE =================

        socket.on("join_queue", (data) => {
            const player = lobbyManager.getPlayer(socket.id);
            if (!player) return;

            const type     = data?.type || "player";
            const password = data?.password || "";

            // spectator/admin لا يدخلون الطابور
            if (type === "spectator" || type === "admin") return;

            // ─── التحقق من كلمة السر للاعبين فقط ───
            console.log(`Join attempt — sessionPassword: "${sessionPassword}", provided: "${password}"`);
            if (sessionPassword && password !== sessionPassword) {
                socket.emit("error", { message: "كلمة السر غلط ❌" });
                return;
            }

            socket.data.type = "PLAYER";
            socket.emit("role_type", { type: "PLAYER" });
            matchmakingManager.addToQueue(player, io);
        });

        // ================= ADMIN JOIN =================

        socket.on("join_admin", () => {
            socket.data.isAdmin = true;
            socket.data.type    = "ADMIN";

            // ابحث عن غرفة نشطة
            const rooms      = roomManager.getAllRooms();
            const activeRoom = rooms.find(r => r.engine && r.engine.phase !== "GAME_OVER") || rooms[0];

            if (!activeRoom) {
                socket.emit("admin_joined");
                socket.emit("waiting_for_players", { message: "No active room yet. Waiting for players..." });
                console.log(`Admin ${socket.id} waiting — no active room yet`);
                return;
            }

            attachToRoom(socket, activeRoom);
            if (activeRoom.engine) {
                activeRoom.engine.adminId = socket.id;
            }
            socket.emit("admin_joined");
            console.log(`Admin ${socket.id} joined room ${activeRoom.id}`);
        });

        // ================= SET SESSION PASSWORD =================

        socket.on("set_session_password", (data) => {
            const pw = typeof data?.password === "string" ? data.password.trim() : "";
            // كلمة سر فارغة = بدون كلمة سر (open session)
            if (!pw) {
                sessionPassword = null;
                console.log("Session password cleared — open session");
                socket.emit("session_password_set", { password: null });
                io.emit("session_password_ready", { ready: false });
                return;
            }
            if (pw.length < 2) {
                socket.emit("error", { message: "كلمة السر قصيرة جداً" });
                return;
            }

            sessionPassword = pw;
            console.log(`Session password set: ${sessionPassword}`);
            socket.emit("session_password_set", { password: sessionPassword });

            // ─── اطرد كل اللاعبين من الـ queue ───
            const ejected = matchmakingManager.getQueueSize();
            if (ejected > 0) {
                // نأخذ نسخة من الـ queue قبل ما نفضيها
                const queuedIds = matchmakingManager.queue.map(p => p.id);
                queuedIds.forEach(id => {
                    matchmakingManager.removeFromQueue(id);
                    const s = io.sockets.sockets.get(id);
                    if (s) {
                        s.emit("session_reset", { message: "تم تغيير كلمة السر — أدخل الكلمة الجديدة للانضمام" });
                    }
                });
                console.log(`Ejected ${ejected} players from queue due to password change`);
            }

            // أبلغ كل الـ clients إن كلمة السر تغيرت
            io.emit("session_password_ready", { ready: true });
        });

        // ================= VERIFY SESSION PASSWORD =================

        socket.on("verify_session_password", (data) => {
            const pw = typeof data?.password === "string" ? data.password.trim() : "";
            if (sessionPassword && pw === sessionPassword) {
                socket.emit("password_verify_ok");
            } else {
                socket.emit("password_verify_fail");
            }
        });

        socket.on("spectator_join_game", () => {
            console.log(`Socket ${socket.id} trying to join as spectator`);
            socket.data.type = "SPECTATOR";

            const rooms      = roomManager.getAllRooms();
            // ✅ FIX: نقبل أي غرفة حتى لو في LOBBY — عشان يشوف اللعبة من البداية
            const activeRoom = rooms.find(r =>
                r.engine && r.engine.phase !== "GAME_OVER"
            );

            if (!activeRoom) {
                socket.emit("error", { message: "No active game found to spectate" });
                console.log(`❌ No active game for spectator ${socket.id}`);
                return;
            }

            socket.join(activeRoom.id);
            socket.data.roomId = activeRoom.id;

            // ✅ نسجّل المشاهد في الـ engine
            if (activeRoom.engine) {
                activeRoom.engine.addSpectator(socket.id);
            }

            socket.emit("game_started", {
                role:   "SPECTATOR",
                roomId: activeRoom.id
            });

            socket.emit("room_state", {
                players: activeRoom.players,
                phase:   activeRoom.engine.phase,
                round:   activeRoom.engine.round
            });

            io.to(activeRoom.id).emit("spectator_joined", {
                message: "A spectator has joined"
            });

            console.log(`✅ Spectator ${socket.id} joined room ${activeRoom.id}`);
        });

        // ================= GAME ACTIONS =================

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

        // ================= VOTING =================

        socket.on("vote", (targetId) => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            // ✅ FIX: الأدمن والمشاهد لا يصوّتون — فقط اللاعبين
            if (socket.data.isAdmin || socket.data.type === "SPECTATOR") return;
            room.engine.registerVote(socket.id, targetId);
        });

        // ================= ADMIN CONTROLS =================

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

        // ================= ADMIN REVEAL NIGHT RESULTS =================

        socket.on("admin_reveal_night_results", (storyText) => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            console.log("Admin revealing night results:", storyText);

            room.engine.executeNightResults();

            io.to(room.id).emit("night_story", {
                story:  storyText || "The night has passed in silence...",
                victim: room.engine.nightResults?.finalVictim || null
            });

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

        // ✅ FIX: admin_end_game يُنهي اللعبة قسراً بدل checkWinCondition
        socket.on("admin_end_game", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.endGame("ADMIN_FORCED");
        });

        // ================= RESTART GAME =================

        socket.on("restart_game", () => {
            if (!socket.data.isAdmin) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            console.log(`Admin restarting game in room ${room.id}`);
            room.engine.resetGame();

            // ✅ FIX: delay صغير قبل startGame عشان الـ clients يعالجوا back_to_lobby
            setTimeout(() => {
                room.engine.startGame();

                // ✅ FIX: نبعث room_state للكل بعد توزيع الأدوار
                io.to(room.id).emit("room_state", {
                    players: room.players,
                    phase:   room.engine.phase,
                    round:   room.engine.round
                });
            }, 800);
        });

        // ================= STATE REQUEST =================

        socket.on("request_room_state", () => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            // فلترة الأدوار: كل لاعب يشوف دوره فقط، التانيين بدون role
            const filteredPlayers = room.players.map(p => ({
                id:       p.id,
                username: p.username,
                alive:    p.alive,
                userType: p.userType,
                role: (p.id === socket.id || !p.alive || socket.data.isAdmin || socket.data.type === "SPECTATOR") ? p.role : null,
            }));
            // المافيا يشوف زملاءه
            const myPlayer = room.players.find(p => p.id === socket.id);
            if (myPlayer?.role === "MAFIA") {
                filteredPlayers.forEach(fp => {
                    const orig = room.players.find(p => p.id === fp.id);
                    if (orig?.role === "MAFIA") fp.role = "MAFIA";
                });
            }
            socket.emit("room_state", {
                players: filteredPlayers,
                phase:   room.engine.phase,
                round:   room.engine.round
            });
        });

        // ================= QUEUE STATUS =================

        // ✅ FIX: handler مفقود — LobbyScene تطلبه كل 3 ثواني
        socket.on("request_queue_status", () => {
            socket.emit("queue_update", {
                queueSize: matchmakingManager.getQueueSize()
            });
        });

        // ================= CHAT MESSAGE =================

        socket.on("send_message", (message) => {
            if (typeof message !== "string" || message.trim().length === 0) return;

            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            // ✅ FIX: الشات مفتوح دائماً للكل — أدمن، لاعبين، مشاهدين
            // chatEnabled دائماً true في الـ engine الجديد
            // لكن نتحقق منه للأمان
            if (!room.engine.chatEnabled) return;

            const clean = message.trim().substring(0, 200);

            // ✅ FIX: الأدمن والمشاهد كمان يقدروا يحكوا
            let senderUsername = null;
            let senderAlive    = true;

            if (socket.data.isAdmin) {
                senderUsername = "ADMIN 👑";
                senderAlive    = true;
            } else if (socket.data.type === "SPECTATOR") {
                senderUsername = "SPECTATOR 👁";
                senderAlive    = true;
            } else {
                const player = room.players.find(p => p.id === socket.id);
                if (!player) return;
                senderUsername = player.username;
                senderAlive    = player.alive;
            }

            io.to(room.id).emit("receive_message", {
                username: senderUsername,
                message:  clean,
                alive:    senderAlive
            });
        });

        // ================= DISCONNECT =================

        socket.on("disconnect", () => {
            // نشيل المشاهد من الـ engine لو كان مشاهداً
            if (socket.data.type === "SPECTATOR" && socket.data.roomId) {
                const room = roomManager.getRoom(socket.data.roomId);
                if (room?.engine) room.engine.removeSpectator(socket.id);
            }

            lobbyManager.removePlayer(socket.id);
            matchmakingManager.removeFromQueue(socket.id);

            // ─── نشيل اللاعب من الغرفة لو كان فيها ───
            if (socket.data.roomId) {
                const room = roomManager.getRoom(socket.data.roomId);
                if (room) {
                    // نحذف اللاعب من قائمة الغرفة
                    room.players = room.players.filter(p => p.id !== socket.id);
                    console.log(`Player ${socket.id} removed from room ${socket.data.roomId}`);

                    // لو الغرفة فاضية تماماً — نحذفها
                    const activeSockets = room.players.filter(p => {
                        return io.sockets.sockets.has(p.id);
                    });
                    if (activeSockets.length === 0) {
                        roomManager.removeRoom(socket.data.roomId);
                        // reset كلمة السر لما الجلسة تنتهي
                        sessionPassword = null;
                        io.emit("session_password_ready", { ready: false });
                        console.log(`Room ${socket.data.roomId} removed — session reset`);
                    }
                }
            }
        });

    });

    // ================= ATTACH TO ROOM =================

    function attachToRoom(socket, room) {
        socket.join(room.id);
        socket.data.roomId = room.id;

        const role = socket.data.isAdmin ? "ADMIN" : "SPECTATOR";

        socket.emit("game_started", {
            roomId: room.id,
            role
        });

        socket.emit("room_state", {
            players: room.players,
            phase:   room.engine?.phase  || "LOBBY",
            round:   room.engine?.round  || 1
        });
    }
}

module.exports = initializeSocket;