// index.js — Secret Society Server — نقطة الدخول الرئيسية
require("dotenv").config();
const express        = require("express");
const http           = require("http");
const { Server }     = require("socket.io");
const cors           = require("cors");
const { v4: uuidv4 } = require("uuid");

const lobbyManager       = require("./src/core/lobbyManager");
const matchmakingManager = require("./src/core/matchmakingManager");
const roomManager        = require("./src/core/roomManager");
const socketHandler      = require("./src/websocket/socketHandler");

// ─── إعداد التطبيق ───────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || "*";

const io = new Server(server, {
    cors: {
        origin:  CLIENT_URL,
        methods: ["GET", "POST"],
    },
    pingTimeout:  60000,
    pingInterval: 25000,
    // مهم لـ Render — يمنع انقطاع الاتصال بسبب idle
    transports: ["websocket", "polling"],
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

// ─── Health check لـ Render ──────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", rooms: roomManager.getAllRooms().length }));
app.get("/",       (_, res) => res.send("Secret Society Server is running ✅"));

// ─── حالة الجلسة (global) ────────────────────────────────────────────────────
// sessionPassword: كلمة سر الجلسة التي يحددها الأدمن
// rejoinCodes:     Map<code, { roomId, role, expiresAt }>
global.sessionPassword = null;
global.rejoinCodes     = new Map();

// تنظيف الأكواد المنتهية كل دقيقة
setInterval(() => {
    const now = Date.now();
    global.rejoinCodes.forEach((val, key) => {
        if (val.expiresAt < now) global.rejoinCodes.delete(key);
    });
}, 60_000);

// ─── مساعد: أول غرفة نشطة ───────────────────────────────────────────────────
function findActiveRoom() {
    const rooms = roomManager.getAllRooms();
    return rooms.length > 0 ? rooms[0] : null;
}

// ─── Rate limiter بسيط ───────────────────────────────────────────────────────
// socketId → { count, resetAt }
const rateLimits = new Map();
function rateLimit(socketId, maxPerSecond = 5) {
    const now = Date.now();
    const entry = rateLimits.get(socketId) || { count: 0, resetAt: now + 1000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 1000; }
    entry.count++;
    rateLimits.set(socketId, entry);
    return entry.count <= maxPerSecond;
}

// ─── Socket.io connection ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
    // أضف اللاعب للـ lobby
    const player = lobbyManager.addPlayer(socket);
    console.log(`✅ Connected: ${socket.id}`);

    // أبلغه بحالة الجلسة فوراً
    socket.emit("session_password_ready", { ready: !!global.sessionPassword });

    // ─────────────────────────────────────────────────────────────────────────
    // USERNAME / AVATAR / COLOR
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("set_username", (username) => {
        if (typeof username !== "string") return;
        const clean = username.trim().slice(0, 20);
        if (clean.length < 2) return;
        const updated = lobbyManager.updateUsername(socket.id, clean);
        if (updated) socket.emit("username_updated", updated);
    });

    socket.on("set_avatar", (avatar) => {
        const p = lobbyManager.getPlayer(socket.id);
        if (p) p.avatar = String(avatar).slice(0, 10);
    });

    socket.on("set_color", (color) => {
        const p = lobbyManager.getPlayer(socket.id);
        if (p) p.color = String(color).slice(0, 20);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("join_admin", () => {
        socket.data.type    = "ADMIN";
        socket.data.isAdmin = true;

        // ربط الأدمن بالغرفة النشطة لو موجودة
        const room = findActiveRoom();
        if (room) {
            socket.join(room.id);
            socket.data.roomId = room.id;
            if (room.engine) {
                room.engine.adminId = socket.id;
                socket.emit("game_started", { roomId: room.id, role: "ADMIN" });
                socket.emit("room_state", {
                    players: room.players,
                    phase:   room.engine.phase,
                    round:   room.engine.round,
                });
            }
        } else {
            socket.emit("game_started", { roomId: null, role: "ADMIN" });
        }

        socket.emit("admin_joined");
        console.log(`👑 Admin connected: ${socket.id}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // QUEUE
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("join_queue", (data) => {
        const p = lobbyManager.getPlayer(socket.id);
        if (!p) return;

        // التحقق من كلمة السر
        if (global.sessionPassword) {
            if (!data?.password || data.password !== global.sessionPassword) {
                socket.emit("error", { message: "كلمة السر غلط ❌" });
                return;
            }
        }

        p.type = "player";
        const room = matchmakingManager.addToQueue(p, io);

        if (!room) {
            // لم يكتمل العدد بعد
            const queueSize = matchmakingManager.getQueueSize();
            const required  = matchmakingManager.requiredPlayers;
            socket.emit("queue_update", { queueSize, required });
            io.emit("queue_update",     { queueSize, required });
        }
    });

    socket.on("request_queue_status", () => {
        socket.emit("queue_update", {
            queueSize: matchmakingManager.getQueueSize(),
            required:  matchmakingManager.requiredPlayers,
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SPECTATOR
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("spectator_join_game", () => {
        const room = findActiveRoom();
        if (!room || !room.engine) {
            socket.emit("waiting_for_players", { message: "لا توجد لعبة نشطة حالياً" });
            return;
        }

        // تأكد إنه مش لاعب أصلاً
        if (room.players.some(p => p.id === socket.id)) {
            socket.emit("error", { message: "أنت بالفعل لاعب في هذه الغرفة" });
            return;
        }

        socket.data.type   = "SPECTATOR";
        socket.data.roomId = room.id;
        socket.join(room.id);

        room.spectators = room.spectators || [];
        if (!room.spectators.includes(socket.id)) room.spectators.push(socket.id);

        socket.emit("game_started", { roomId: room.id, role: "SPECTATOR" });
        socket.emit("room_state", {
            players: room.players.map(p => ({
                id: p.id, username: p.username, alive: p.alive, role: null
            })),
            phase: room.engine.phase,
            round: room.engine.round,
        });
        socket.to(room.id).emit("spectator_joined", { spectatorId: socket.id });
        console.log(`👁 Spectator joined room: ${room.id}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SESSION PASSWORD (الأدمن فقط)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("set_session_password", ({ password }) => {
        if (!socket.data.isAdmin) return;
        global.sessionPassword = password || null;
        console.log(`🔑 Session password ${global.sessionPassword ? "set" : "cleared"}`);
        io.emit("session_password_set",   { password: global.sessionPassword });
        io.emit("session_password_ready", { ready: !!global.sessionPassword });
    });

    socket.on("verify_session_password", ({ password }) => {
        if (!global.sessionPassword || password === global.sessionPassword) {
            socket.emit("password_verify_ok");
        } else {
            socket.emit("password_verify_fail");
        }
    });

    socket.on("set_player_count", ({ count }) => {
        if (!socket.data.isAdmin) return;
        matchmakingManager.setRequiredPlayers(count);
        const required = matchmakingManager.requiredPlayers;
        io.emit("player_count_updated", { required });
        console.log(`👥 Required players set to ${required}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GAME ACTIONS (Mafia / Doctor / Detective / Vote)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("mafia_kill", (targetId) => {
        if (!rateLimit(socket.id)) return;
        if (typeof targetId !== "string") return;
        const room = roomManager.getRoom(socket.data.roomId);
        room?.engine?.registerMafiaKill(socket.id, targetId);
    });

    socket.on("doctor_save", (targetId) => {
        if (!rateLimit(socket.id)) return;
        if (typeof targetId !== "string") return;
        const room = roomManager.getRoom(socket.data.roomId);
        room?.engine?.registerDoctorSave(socket.id, targetId);
    });

    socket.on("detective_check", (targetId) => {
        if (!rateLimit(socket.id)) return;
        if (typeof targetId !== "string") return;
        const room = roomManager.getRoom(socket.data.roomId);
        room?.engine?.registerDetectiveCheck(socket.id, targetId);
    });

    socket.on("vote", (targetId) => {
        if (!rateLimit(socket.id, 2)) return; // صوت واحد كل نصف ثانية كحد أقصى
        if (typeof targetId !== "string") return;
        const room = roomManager.getRoom(socket.data.roomId);
        room?.engine?.registerVote(socket.id, targetId);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // CHAT
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("send_message", (message) => {
        if (!rateLimit(socket.id, 3)) return;
        if (typeof message !== "string" || !message.trim()) return;

        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room   = roomManager.getRoom(roomId);
        if (!room)   return;

        const player   = room.players.find(p => p.id === socket.id);
        const isAdmin  = socket.data.isAdmin;
        const username = isAdmin ? "ADMIN 👑" : (player?.username || "Unknown");
        const alive    = isAdmin ? true : (player ? player.alive : true);

        io.to(roomId).emit("receive_message", {
            username,
            message: message.trim().slice(0, 200),
            alive,
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // MAFIA CHAT (مافيا مع بعض فقط)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("mafia_chat", (message) => {
        if (!rateLimit(socket.id, 3)) return;
        if (typeof message !== "string" || !message.trim()) return;

        const room = roomManager.getRoom(socket.data.roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.role !== "MAFIA") return;

        // أرسل للمافيا فقط
        room.players
            .filter(p => p.role === "MAFIA")
            .forEach(m => {
                io.to(m.id).emit("mafia_chat_message", {
                    from:    player.username,
                    message: message.trim().slice(0, 200),
                });
            });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN CONTROLS
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("admin_start_night", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: start night");
        room.engine.startNight();
    });

    socket.on("admin_end_night", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: end night");
        room.engine.endNight();
    });

    socket.on("admin_start_voting", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: start voting");
        room.engine.startVoting();
    });

    socket.on("admin_end_voting", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: end voting");
        room.engine.endVoting();
    });

    socket.on("admin_end_game", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: force end game");
        room.engine.endGame("ADMIN_FORCED");
    });

    socket.on("admin_reveal_night_results", (story) => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;

        const storyText = typeof story === "string"
            ? story.trim().slice(0, 500)
            : "The night passed in silence...";

        console.log("Admin: reveal night results");
        room.engine.executeNightResults();
        io.to(socket.data.roomId).emit("night_story", { story: storyText });

        // تحقق من شرط الفوز قبل الانتقال للنهار
        if (!room.engine.checkWinCondition()) {
            room.engine.startDay();
        }
    });

    socket.on("restart_game", () => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room?.engine) return;
        console.log("Admin: restart game");
        room.engine.resetGame();
    });

    socket.on("admin_reset_server", () => {
        if (!socket.data.isAdmin) return;
        console.log("⚠️ Admin: server reset");

        // امسح كل الغرف
        roomManager.getAllRooms().forEach(r => roomManager.removeRoom(r.id));

        // أفرغ الـ queue
        matchmakingManager.queue = [];

        // امسح الجلسة
        global.sessionPassword = null;
        global.rejoinCodes.clear();

        // أبلغ الجميع
        io.emit("server_reset");
        io.emit("session_password_ready", { ready: false });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // REJOIN CODES (الأدمن يولّد، اللاعب يستخدم)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("admin_generate_room_code", ({ role }) => {
        if (!socket.data.isAdmin) return;
        const room = roomManager.getRoom(socket.data.roomId);
        if (!room) return;

        const validRoles = ["MAFIA", "DOCTOR", "DETECTIVE", "CITIZEN"];
        if (!validRoles.includes(role)) return;

        // كود من 6 أرقام
        const code      = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 دقيقة

        global.rejoinCodes.set(code, {
            roomId: room.id,
            role,
            expiresAt,
        });

        socket.emit("room_code_generated", { code, role });
        console.log(`🔑 Rejoin code generated: ${code} (role: ${role})`);
    });

    socket.on("rejoin_with_code", ({ code, username }) => {
        if (typeof code !== "string" || typeof username !== "string") return;

        const entry = global.rejoinCodes.get(code.trim());
        if (!entry || entry.expiresAt < Date.now()) {
            global.rejoinCodes.delete(code);
            socket.emit("rejoin_code_error", { message: "الكود غلط أو منتهي ❌" });
            return;
        }

        const room = roomManager.getRoom(entry.roomId);
        if (!room) {
            socket.emit("rejoin_code_error", { message: "الغرفة لم تعد موجودة ❌" });
            return;
        }

        // أنشئ لاعباً جديداً بالدور المحدد
        const newPlayer = {
            id:       socket.id,
            username: username.trim().slice(0, 20),
            role:     entry.role,
            alive:    true,
            avatar:   "😎",
            color:    "#1e293b",
        };
        room.players.push(newPlayer);
        lobbyManager.updateUsername(socket.id, newPlayer.username);

        socket.join(entry.roomId);
        socket.data.roomId = entry.roomId;
        socket.data.type   = "PLAYER";

        // احذف الكود بعد الاستخدام
        global.rejoinCodes.delete(code);

        socket.emit("game_started", { roomId: entry.roomId, role: entry.role });

        // أبلغ الغرفة بالوافد الجديد
        socket.to(entry.roomId).emit("player_rejoined", {
            id:       socket.id,
            username: newPlayer.username,
            role:     entry.role,
        });

        console.log(`🔄 ${newPlayer.username} rejoined via code as ${entry.role}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // REJOIN (جلسة محفوظة)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("rejoin_game", ({ roomId, username, role }) => {
        if (typeof roomId !== "string" || typeof username !== "string") {
            socket.emit("rejoin_failed");
            return;
        }

        const room = roomManager.getRoom(roomId);
        if (!room) {
            socket.emit("rejoin_failed");
            return;
        }

        // ابحث عن اللاعب بالاسم والدور معاً (أكثر دقة)
        const player = room.players.find(
            p => p.username === username.trim() && p.role === role
        );
        if (!player) {
            socket.emit("rejoin_failed");
            return;
        }

        // حدّث الـ socket ID
        const oldId  = player.id;
        player.id    = socket.id;
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.type   = "PLAYER";
        lobbyManager.updateUsername(socket.id, username);

        // أبلغ الغرفة بتحديث الـ socket (مهم للـ voice)
        socket.to(roomId).emit("voice_reconnect_request", {
            oldId, newId: socket.id, username,
        });

        socket.emit("game_started", { roomId, role: player.role });
        console.log(`🔄 ${username} rejoined session`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ROOM STATE
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("request_room_state", () => {
        // استخدم socketHandler للـ logic المفصّل
        socketHandler(io, socket);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // VOICE (PeerJS peer IDs)
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("voice_peer_id", ({ peerId }) => {
        if (typeof peerId !== "string") return;

        const room = roomManager.getRoom(socket.data.roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.peerId = peerId;

        // أرسل قائمة الـ peers الموجودين للداخل الجديد
        const peers = room.players
            .filter(p => p.id !== socket.id && p.peerId)
            .map(p => ({ peerId: p.peerId, username: p.username, role: p.role }));

        socket.emit("voice_peers", { peers });

        // أبلغ الباقين بالـ peer الجديد
        socket.to(socket.data.roomId).emit("voice_peer_joined", {
            peerId,
            username: player?.username,
            role:     player?.role,
        });

        console.log(`🎤 Voice peer registered: ${player?.username} (${peerId.slice(0, 8)}...)`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DISCONNECT
    // ─────────────────────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
        console.log(`❌ Disconnected: ${socket.id} (${reason})`);

        // أزل من الـ lobby
        lobbyManager.removePlayer(socket.id);

        // أزل من الـ queue لو كان فيها
        matchmakingManager.removeFromQueue(socket.id);

        // أبلغ الغرفة
        const roomId = socket.data.roomId;
        if (roomId) {
            socket.to(roomId).emit("player_disconnected", { id: socket.id });
        }

        // نظّف rate limiter
        rateLimits.delete(socket.id);
    });
});

// ─── تشغيل السيرفر ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Secret Society Server running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   Client URL:  ${CLIENT_URL}`);
});