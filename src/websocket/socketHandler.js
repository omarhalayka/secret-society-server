// @ts-nocheck
const lobbyManager       = require("../core/lobbyManager");
const matchmakingManager = require("../core/matchmakingManager");
const roomManager        = require("../core/roomManager");

// ─── كلمة سر الجلسة الحالية ───
let sessionPassword = null;

// ─── كودات الرجوع — { code: { username, roomId, role, expires } } ───
const rejoinCodes = {};

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

        // ================= ADMIN GENERATE ROOM CODE =================

        socket.on("admin_generate_room_code", () => {
            if (!socket.data.isAdmin) return;

            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            // ولّد كود عام للغرفة صالح 15 دقيقة
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            rejoinCodes[code] = {
                roomId:  room.id,
                expires: Date.now() + 15 * 60 * 1000,
            };

            console.log(`✅ Room code: ${code}`);
            socket.emit("room_code_generated", { code });
        });

        // ================= REJOIN WITH CODE =================

        socket.on("rejoin_with_code", (data) => {
            const { code, username } = data || {};
            if (!code || !username?.trim()) return;

            const entry = rejoinCodes[code];
            if (!entry) { socket.emit("rejoin_code_error", { message: "كود غلط ❌" }); return; }
            if (Date.now() > entry.expires) {
                delete rejoinCodes[code];
                socket.emit("rejoin_code_error", { message: "الكود انتهت صلاحيته" });
                return;
            }

            const room = roomManager.getRoom(entry.roomId);
            if (!room?.engine || room.engine.phase === "GAME_OVER") {
                delete rejoinCodes[code];
                socket.emit("rejoin_code_error", { message: "الجلسة انتهت" });
                return;
            }

            // ─── ابحث عن لاعب disconnected ───
            const missingPlayer = room.players.find(p => p.disconnected);

            let assignedRole = "CITIZEN";
            if (missingPlayer) {
                console.log(`Replacing disconnected: ${missingPlayer.username} (${missingPlayer.role})`);
                assignedRole               = missingPlayer.role;
                missingPlayer.id           = socket.id;
                missingPlayer.username     = username.trim();
                missingPlayer.disconnected = false;
            } else {
                // ما في أحد disconnected — أضف كـ CITIZEN
                room.players.push({
                    id:       socket.id,
                    username: username.trim(),
                    role:     "CITIZEN",
                    alive:    true,
                    userType: "PLAYER",
                });
            }

            socket.data.roomId = entry.roomId;
            socket.data.type   = "PLAYER";
            socket.join(entry.roomId);
            delete rejoinCodes[code];

            // فلترة الأدوار للاعب الجديد
            const filteredPlayers = room.players.map(p => ({
                id:       p.id,
                username: p.username,
                alive:    p.alive,
                userType: p.userType,
                role:     p.id === socket.id ? p.role : null,
            }));
            if (assignedRole === "MAFIA") {
                filteredPlayers.forEach(fp => {
                    const orig = room.players.find(p => p.id === fp.id);
                    if (orig?.role === "MAFIA") fp.role = "MAFIA";
                });
            }

            // ─── أبلغ اللاعب الجديد ───
            socket.emit("game_started", { roomId: entry.roomId, role: assignedRole });
            socket.emit("room_state", {
                players: filteredPlayers,
                phase:   room.engine.phase,
                round:   room.engine.round,
            });

            // ─── refresh للكل ───
            io.to(entry.roomId).emit("room_state", {
                players: room.players,
                phase:   room.engine.phase,
                round:   room.engine.round,
            });

            console.log(`✅ ${username} joined as ${assignedRole}`);
        });

        // ================= REJOIN GAME =================

        socket.on("rejoin_game", (data) => {
            const { roomId, username, role } = data || {};
            if (!roomId || !username) return;

            const room = roomManager.getRoom(roomId);
            if (!room?.engine || room.engine.phase === "GAME_OVER") {
                socket.emit("rejoin_failed", { message: "Game session has ended" });
                return;
            }

            // ابحث عن اللاعب في الغرفة باسمه
            const existingPlayer = room.players.find(p => p.username === username);
            if (!existingPlayer) {
                socket.emit("rejoin_failed", { message: "Player not found in session" });
                return;
            }

            // حدّث الـ socket ID للاعب
            existingPlayer.id  = socket.id;
            socket.data.roomId = roomId;
            socket.data.type   = "PLAYER";
            socket.join(roomId);

            // لو كان أدمن
            if (role === "ADMIN") {
                socket.data.isAdmin    = true;
                socket.data.type       = "ADMIN";
                room.engine.adminId    = socket.id;
                socket.emit("game_started", { roomId, role: "ADMIN" });

                // الأدمن يشوف كل الأدوار
                socket.emit("room_state", {
                    players: room.players,
                    phase:   room.engine.phase,
                    round:   room.engine.round,
                });
            } else {
                socket.emit("game_started", { roomId, role: existingPlayer.role });

                // ─── فلترة الأدوار — نفس منطق request_room_state ───
                const filteredPlayers = room.players.map(p => ({
                    id:       p.id,
                    username: p.username,
                    alive:    p.alive,
                    userType: p.userType,
                    role:     (p.id === socket.id || socket.data.isAdmin) ? p.role : null,
                }));
                // المافيا تشوف زملاءها
                if (existingPlayer.role === "MAFIA") {
                    filteredPlayers.forEach(fp => {
                        const orig = room.players.find(p => p.id === fp.id);
                        if (orig?.role === "MAFIA") fp.role = "MAFIA";
                    });
                }
                socket.emit("room_state", {
                    players: filteredPlayers,
                    phase:   room.engine.phase,
                    round:   room.engine.round,
                });
            }

            console.log(`✅ Player ${username} rejoined room ${roomId} as ${existingPlayer.role}`);
        });

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

        // ================= SET PLAYER COUNT =================

        socket.on("set_player_count", (data) => {
            const count = parseInt(data?.count);
            if (isNaN(count) || count < 4 || count > 12) return;

            // فضّي الـ queue لو في أحد
            if (matchmakingManager.getQueueSize() > 0) {
                const queuedIds = matchmakingManager.queue.map(p => p.id);
                queuedIds.forEach(id => {
                    matchmakingManager.removeFromQueue(id);
                    const s = io.sockets.sockets.get(id);
                    if (s) s.emit("session_reset", { message: "تم تغيير عدد اللاعبين — انضم من جديد" });
                });
            }

            matchmakingManager.setRequiredPlayers(count);
            console.log(`Player count set to ${count}`);

            // أبلغ كل الـ clients بالعدد الجديد
            io.emit("player_count_updated", { required: count });
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

        // ─── محادثة المافيا السرية (ليل فقط) ───
        socket.on("mafia_chat", (message) => {
            if (typeof message !== "string" || !message.trim()) return;
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            if (room.engine.phase !== "NIGHT") return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player || player.role !== "MAFIA" || !player.alive) return;

            const clean = message.trim().substring(0, 200);
            // نبعث الرسالة لكل المافيا الأحياء فقط
            room.players.forEach(p => {
                if (p.role === "MAFIA" && p.alive) {
                    const s = room.engine.io.to(p.id);
                    s.emit("mafia_chat_message", {
                        from:    player.username,
                        message: clean,
                    });
                }
            });
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

            setTimeout(() => {
                room.engine.startGame();
                io.to(room.id).emit("room_state", {
                    players: room.players,
                    phase:   room.engine.phase,
                    round:   room.engine.round
                });
            }, 800);
        });

        // ================= RESET SERVER =================

        socket.on("admin_reset_server", () => {
            if (!socket.data.isAdmin) return;
            console.log("🔴 Admin triggered full server reset");

            // ─── امسح كل الغرف وأوقف الـ timers ───
            const allRooms = roomManager.getAllRooms();
            allRooms.forEach(room => {
                if (room.engine?._pendingTimer) {
                    clearTimeout(room.engine._pendingTimer);
                }
                roomManager.removeRoom(room.id);
            });

            // ─── امسح الـ queue ───
            matchmakingManager.queue = [];

            // ─── امسح كلمة السر ───
            sessionPassword = null;

            // ─── امسح بيانات كل الـ sockets ما عدا الأدمن ───
            io.sockets.sockets.forEach((s) => {
                if (s.id === socket.id) return; // الأدمن يضل
                // امسح بياناته
                s.data.roomId  = null;
                s.data.type    = null;
                s.data.isAdmin = false;
                // اشيله من أي socket room
                s.rooms.forEach(room => {
                    if (room !== s.id) s.leave(room);
                });
                // سجّله من جديد في الـ lobbyManager بدون دور
                const p = lobbyManager.getPlayer(s.id);
                if (p) {
                    p.role    = null;
                    p.roomId  = null;
                }
            });

            // ─── امسح بيانات الأدمن نفسه ───
            socket.data.roomId = null;

            // ─── أبلغ كل الـ clients ───
            io.emit("server_reset", {});
            io.emit("session_password_ready", { ready: false });

            console.log("✅ Server reset complete");
        });

        // ================= STATE REQUEST =================

        socket.on("request_room_state", () => {
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;

            // فلترة اللاعبين — نشيل الـ disconnected من العرض
            const activePlayers = room.players.filter(p => !p.disconnected);

            const filteredPlayers = activePlayers.map(p => ({
                id:       p.id,
                username: p.username,
                alive:    p.alive,
                userType: p.userType,
                role: (p.id === socket.id || socket.data.isAdmin || socket.data.type === "SPECTATOR") ? p.role : null,
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
                queueSize: matchmakingManager.getQueueSize(),
                required:  matchmakingManager.requiredPlayers
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

            if (socket.data.roomId) {
                const room = roomManager.getRoom(socket.data.roomId);
                if (room) {
                    const player = room.players.find(p => p.id === socket.id);
                    if (player) {
                        // ─── نعلّمه كـ disconnected بدل ما نشيله ───
                        // عشان البديل يقدر يلاقي دوره لاحقاً
                        player.disconnected = true;
                        console.log(`Player ${player.username} (${player.role}) disconnected from room`);
                    }

                    // لو كل اللاعبين disconnected — نحذف الغرفة
                    const activeSockets = room.players.filter(p => !p.disconnected);
                    if (activeSockets.length === 0) {
                        roomManager.removeRoom(socket.data.roomId);
                        sessionPassword = null;
                        io.emit("session_password_ready", { ready: false });
                        console.log(`Room ${socket.data.roomId} removed — all disconnected`);
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