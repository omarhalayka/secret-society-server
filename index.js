// index.js — Secret Society Game Server
// النسخة النهائية: production-ready
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const lobbyManager = require("./src/core/lobbyManager");
const matchmakingManager = require("./src/core/matchmakingManager");
const roomManager = require("./src/core/roomManager");
const socketHandler = require("./src/websocket/socketHandler");
const logger = require("./src/utils/logger");
const rateLimiter = require("./src/utils/rateLimit");
const validate = require("./src/utils/validate");
const { emitError, ERROR_TYPES } = require("./src/utils/errors");

// ─── Express + HTTP + Socket.io ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || "*";

const io = new Server(server, {
    cors: {
        origin: CLIENT_URL,
        methods: ["GET", "POST"],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 1e5, // 100KB — يمنع payloads ضخمة
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: "10kb" }));

// ─── HTTP Endpoints ───────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("Secret Society Server ✅"));
app.get("/health", (_, res) => res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    rooms: roomManager.getAllRooms().length,
    queue: matchmakingManager.getQueueSize(),
}));

// ─── حالة الجلسة ─────────────────────────────────────────────────────────────
// sessionPassword: كلمة سر يحددها الأدمن للسماح للاعبين بالدخول
// rejoinCodes:     Map<code, { roomId, role, expiresAt }>
global.sessionPassword = null;
global.rejoinCodes = new Map();

// تنظيف الأكواد المنتهية كل دقيقة
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    global.rejoinCodes.forEach((val, key) => {
        if (val.expiresAt < now) { global.rejoinCodes.delete(key); cleaned++; }
    });
    if (cleaned > 0) logger.debug("SERVER", `Cleaned ${cleaned} expired rejoin codes`);
}, 60_000);

// ─── Helper: أول غرفة نشطة ───────────────────────────────────────────────────
function findActiveRoom() {
    const rooms = roomManager.getAllRooms();
    return rooms.length > 0 ? rooms[0] : null;
}

// ─── Helper: احصل على الغرفة بناءً على socket.data.roomId ────────────────────
function getRoomForSocket(socket) {
    return socket.data.roomId
        ? roomManager.getRoom(socket.data.roomId)
        : null;
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
    lobbyManager.addPlayer(socket);

    // أخبر الكلاينت فوراً بحالة الجلسة
    socket.emit("session_password_ready", { ready: !!global.sessionPassword });

    // =========================================================================
    // USERNAME / AVATAR / COLOR
    // =========================================================================
    socket.on("set_username", (username) => {
        if (!rateLimiter.events.SET_USERNAME(socket.id)) return;
        const clean = validate.username(username);
        if (!clean) {
            emitError(socket, ERROR_TYPES.INVALID_INPUT, "اسم المستخدم يجب أن يكون بين 2-20 حرف");
            return;
        }
        const updated = lobbyManager.updateUsername(socket.id, clean);
        if (updated) socket.emit("username_updated", updated);
    });

    socket.on("set_avatar", (avatar) => {
        const p = lobbyManager.getPlayer(socket.id);
        if (p) p.avatar = String(avatar || "😎").slice(0, 10);
    });

    socket.on("set_color", (color) => {
        const p = lobbyManager.getPlayer(socket.id);
        if (p) p.color = String(color || "#1e293b").slice(0, 20);
    });

    // =========================================================================
    // ADMIN
    // =========================================================================
    socket.on("join_admin", () => {
        socket.data.type = "ADMIN";
        socket.data.isAdmin = true;

        const room = findActiveRoom();
        if (room?.engine) {
            socket.join(room.id);
            socket.data.roomId = room.id;
            room.engine.adminId = socket.id;

            socket.emit("game_started", { roomId: room.id, role: "ADMIN" });
            socket.emit("room_state", {
                players: room.players,
                phase: room.engine.phase,
                round: room.engine.round,
            });
        } else {
            socket.emit("game_started", { roomId: null, role: "ADMIN" });
        }

        socket.emit("admin_joined");
        logger.adminAct("join_admin", socket.data.roomId || "no-room");
    });

    // =========================================================================
    // SESSION PASSWORD
    // =========================================================================
    socket.on("set_session_password", ({ password } = {}) => {
        if (!socket.data.isAdmin) {
            emitError(socket, ERROR_TYPES.UNAUTHORIZED, "غير مصرح لك بهذا الإجراء");
            return;
        }
        const cleaned = validate.password(password);
        global.sessionPassword = cleaned;
        logger.info("AUTH", `Session password ${cleaned ? "set" : "cleared"}`);
        io.emit("session_password_set", { password: global.sessionPassword });
        io.emit("session_password_ready", { ready: !!global.sessionPassword });
    });

    socket.on("verify_session_password", ({ password } = {}) => {
        const ok = !global.sessionPassword || password === global.sessionPassword;
        socket.emit(ok ? "password_verify_ok" : "password_verify_fail");
    });

    socket.on("set_player_count", ({ count } = {}) => {
        if (!socket.data.isAdmin) return;
        const n = validate.playerCount(count);
        if (!n) return;
        matchmakingManager.setRequiredPlayers(n);
        io.emit("player_count_updated", { required: n });
    });

    // =========================================================================
    // QUEUE
    // =========================================================================
    socket.on("join_queue", (data = {}) => {
        if (!rateLimiter.events.JOIN_QUEUE(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى بعد ثوانٍ");
            return;
        }

        const p = lobbyManager.getPlayer(socket.id);
        if (!p) return;

        // التحقق من كلمة السر
        if (global.sessionPassword) {
            const pwd = validate.password(data?.password);
            if (!pwd || pwd !== global.sessionPassword) {
                emitError(socket, ERROR_TYPES.INVALID_PASSWORD, "كلمة السر غلط ❌");
                return;
            }
        }

        p.type = "player";
        const room = matchmakingManager.addToQueue(p, io);

        if (!room) {
            const queueSize = matchmakingManager.getQueueSize();
            const required = matchmakingManager.requiredPlayers;
            // أبلغ الكل بتحديث الـ queue
            io.emit("queue_update", { queueSize, required });
        }
    });

    socket.on("request_queue_status", () => {
        socket.emit("queue_update", {
            queueSize: matchmakingManager.getQueueSize(),
            required: matchmakingManager.requiredPlayers,
        });
    });

    // =========================================================================
    // SPECTATOR
    // =========================================================================
    socket.on("spectator_join_game", () => {
        const room = findActiveRoom();
        if (!room?.engine) {
            socket.emit("waiting_for_players", { message: "لا توجد لعبة نشطة حالياً" });
            return;
        }
        if (room.players.some(p => p.id === socket.id)) {
            emitError(socket, ERROR_TYPES.INVALID_INPUT, "أنت بالفعل لاعب في هذه الغرفة");
            return;
        }

        socket.data.type = "SPECTATOR";
        socket.data.roomId = room.id;
        socket.join(room.id);

        room.spectators = room.spectators || [];
        if (!room.spectators.includes(socket.id)) room.spectators.push(socket.id);

        socket.emit("game_started", { roomId: room.id, role: "SPECTATOR" });
        socket.emit("room_state", {
            players: room.players.map(p => ({
                id: p.id, username: p.username, alive: p.alive,
                avatar: p.avatar, color: p.color, role: null,
            })),
            phase: room.engine.phase,
            round: room.engine.round,
        });
        socket.to(room.id).emit("spectator_joined", { spectatorId: socket.id });
        logger.info("SPECTATOR", "Joined room", { socketId: socket.id, roomId: room.id });
    });

    // =========================================================================
    // ROOM STATE
    // =========================================================================
    socket.on("request_room_state", () => {
        if (!rateLimiter.events.ROOM_STATE(socket.id)) return;
        socketHandler(io, socket);
    });

    // =========================================================================
    // GAME ACTIONS
    // =========================================================================
    socket.on("mafia_kill", (targetId) => {
        if (!rateLimiter.events.GAME_ACTION(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى");
            return;
        }
        const tid = validate.socketId(targetId);
        if (!tid) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "هدف غير صالح"); return; }

        const room = getRoomForSocket(socket);
        console.log("[Socket] mafia_kill received", {
            socketId: socket.id,
            roomId: socket.data.roomId,
            targetId: tid,
            hasRoom: !!room,
            engineInstanceId: room?.engine?.instanceId || null,
            phase: room?.engine?.phase || null,
            round: room?.engine?.round || null,
            lastMafiaTarget: room?.engine?.lastMafiaTarget || null,
        });
        const result = room?.engine?.registerMafiaKill(socket.id, tid);
        console.log("[Socket] mafia_kill result", {
            socketId: socket.id,
            roomId: socket.data.roomId,
            engineInstanceId: room?.engine?.instanceId || null,
            result: result || null,
            currentNightTarget: room?.engine?.nightActions?.mafiaTarget || null,
            lastMafiaTarget: room?.engine?.lastMafiaTarget || null,
        });
    });

    socket.on("doctor_save", (targetId) => {
        if (!rateLimiter.events.GAME_ACTION(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى");
            return;
        }
        const tid = validate.socketId(targetId);
        if (!tid) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "هدف غير صالح"); return; }

        const room = getRoomForSocket(socket);
        console.log("[Socket] doctor_save received", {
            socketId: socket.id,
            roomId: socket.data.roomId,
            targetId: tid,
            hasRoom: !!room,
            engineInstanceId: room?.engine?.instanceId || null,
            phase: room?.engine?.phase || null,
            round: room?.engine?.round || null,
            lastDoctorTarget: room?.engine?.lastDoctorTarget || null,
        });
        const result = room?.engine?.registerDoctorSave(socket.id, tid);
        console.log("[Socket] doctor_save result", {
            socketId: socket.id,
            roomId: socket.data.roomId,
            engineInstanceId: room?.engine?.instanceId || null,
            result: result || null,
            currentNightTarget: room?.engine?.nightActions?.doctorSave || null,
            lastDoctorTarget: room?.engine?.lastDoctorTarget || null,
        });
    });

    socket.on("detective_check", (targetId) => {
        if (!rateLimiter.events.GAME_ACTION(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى");
            return;
        }
        const tid = validate.socketId(targetId);
        if (!tid) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "هدف غير صالح"); return; }

        const room = getRoomForSocket(socket);
        room?.engine?.registerDetectiveCheck(socket.id, tid);
    });

    socket.on("vote", (targetId) => {
        if (!rateLimiter.events.VOTE(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى");
            return;
        }
        const tid = validate.socketId(targetId);
        if (!tid) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "هدف غير صالح"); return; }

        const room = getRoomForSocket(socket);
        room?.engine?.registerVote(socket.id, tid);
    });

    // =========================================================================
    // CHAT
    // =========================================================================
    socket.on("send_message", (message) => {
        if (!rateLimiter.events.CHAT(socket.id)) return;

        const msg = validate.message(message);
        if (!msg) return;

        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = roomManager.getRoom(roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const isAdmin = socket.data.isAdmin;
        const username = isAdmin ? "ADMIN 👑" : (player?.username || "Unknown");
        const alive = isAdmin ? true : (player?.alive ?? true);

        io.to(roomId).emit("receive_message", { username, message: msg, alive });
    });

    // ─── Mafia chat (بين أفراد المافيا فقط) ──────────────────────────────────
    socket.on("mafia_chat", (message) => {
        if (!rateLimiter.events.MAFIA_CHAT(socket.id)) return;

        const msg = validate.message(message);
        if (!msg) return;

        const room = getRoomForSocket(socket);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.role !== "MAFIA") return;

        // أرسل للمافيا فقط
        room.players
            .filter(p => p.role === "MAFIA")
            .forEach(m => {
                io.to(m.id).emit("mafia_chat_message", {
                    from: player.username,
                    message: msg,
                });
            });
    });

    // =========================================================================
    // ADMIN CONTROLS
    // =========================================================================
    function requireAdmin() {
        return socket.data.isAdmin;
    }

    socket.on("admin_start_night", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("start_night", room.id);
        room.engine.startNight();
    });

    socket.on("admin_end_night", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("end_night", room.id);
        room.engine.endNight();
    });

    socket.on("admin_start_voting", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("start_voting", room.id);
        room.engine.startVoting();
    });

    socket.on("admin_end_voting", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("end_voting", room.id);
        room.engine.endVoting();
    });

    socket.on("admin_end_game", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("force_end_game", room.id);
        room.engine.endGame("ADMIN_FORCED");
    });

    socket.on("admin_reveal_night_results", (story) => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;

        const storyText = validate.message(story) || "The night passed in silence...";
        logger.adminAct("reveal_night_results", room.id);

        room.engine.executeNightResults();
        io.to(socket.data.roomId).emit("night_story", { story: storyText });

        // تحقق من شرط الفوز قبل بدء النهار
        if (!room.engine.checkWinCondition()) {
            room.engine.startDay();
        }
    });

    socket.on("restart_game", () => {
        if (!requireAdmin()) return;
        const room = getRoomForSocket(socket);
        if (!room?.engine) return;
        logger.adminAct("restart_game", room.id);
        room.engine.resetGame();
    });

    socket.on("admin_reset_server", () => {
        if (!requireAdmin()) return;
        logger.warn("SERVER", "Admin triggered server reset");

        roomManager.getAllRooms().forEach(r => roomManager.removeRoom(r.id));
        matchmakingManager.queue = [];
        global.sessionPassword = null;
        global.rejoinCodes.clear();

        io.emit("server_reset");
        io.emit("session_password_ready", { ready: false });
    });

    // =========================================================================
    // REJOIN CODES
    // =========================================================================
    socket.on("admin_generate_room_code", ({ role } = {}) => {
        if (!requireAdmin()) return;

        const validRole = validate.role(role);
        if (!validRole) {
            emitError(socket, ERROR_TYPES.INVALID_INPUT, "دور غير صالح");
            return;
        }

        const room = getRoomForSocket(socket);
        if (!room) {
            emitError(socket, ERROR_TYPES.ROOM_NOT_FOUND, "لا توجد غرفة نشطة");
            return;
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 15 * 60 * 1000;

        global.rejoinCodes.set(code, { roomId: room.id, role: validRole, expiresAt });

        socket.emit("room_code_generated", { code, role: validRole });
        logger.info("REJOIN", `Code generated`, { code, role: validRole, roomId: room.id });
    });

    socket.on("rejoin_with_code", ({ code, username } = {}) => {
        if (!rateLimiter.events.REJOIN(socket.id)) {
            emitError(socket, ERROR_TYPES.RATE_LIMITED, "حاول مرة أخرى لاحقاً");
            return;
        }

        const cleanCode = validate.rejoinCode(code);
        const cleanName = validate.username(username);

        if (!cleanCode) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "كود غير صالح"); return; }
        if (!cleanName) { emitError(socket, ERROR_TYPES.INVALID_INPUT, "اسم غير صالح"); return; }

        const entry = global.rejoinCodes.get(cleanCode);
        if (!entry || entry.expiresAt < Date.now()) {
            global.rejoinCodes.delete(cleanCode);
            emitError(socket, ERROR_TYPES.INVALID_CODE, "الكود غلط أو منتهي ❌");
            return;
        }

        const room = roomManager.getRoom(entry.roomId);
        if (!room) {
            emitError(socket, ERROR_TYPES.ROOM_NOT_FOUND, "الغرفة لم تعد موجودة ❌");
            return;
        }

        // أنشئ اللاعب بالدور المحدد من الأدمن
        const newPlayer = {
            id: socket.id,
            username: cleanName,
            role: entry.role,
            alive: true,
            avatar: "😎",
            color: "#1e293b",
        };
        room.players.push(newPlayer);
        lobbyManager.updateUsername(socket.id, cleanName);

        socket.join(entry.roomId);
        socket.data.roomId = entry.roomId;
        socket.data.type = "PLAYER";

        // الكود يُستخدم مرة واحدة فقط
        global.rejoinCodes.delete(cleanCode);

        socket.emit("game_started", { roomId: entry.roomId, role: entry.role });
        socket.to(entry.roomId).emit("player_rejoined", {
            id: socket.id, username: cleanName, role: entry.role,
        });

        logger.rejoin(cleanName, entry.roomId);
    });

    // ─── Rejoin بجلسة محفوظة (localStorage) ──────────────────────────────────
    socket.on("rejoin_game", ({ roomId, username, role } = {}) => {
        if (!rateLimiter.events.REJOIN(socket.id)) return;

        const cleanRoomId = validate.roomId(roomId);
        const cleanName = validate.username(username);
        const cleanRole = validate.role(role);

        if (!cleanRoomId || !cleanName || !cleanRole) {
            socket.emit("rejoin_failed");
            return;
        }

        const room = roomManager.getRoom(cleanRoomId);
        if (!room) { socket.emit("rejoin_failed"); return; }

        // ابحث بالاسم + الدور معاً — أكثر دقة من الاسم وحده
        const player = room.players.find(
            p => p.username === cleanName && p.role === cleanRole
        );
        if (!player) { socket.emit("rejoin_failed"); return; }

        const oldId = player.id;
        player.id = socket.id;

        socket.join(cleanRoomId);
        socket.data.roomId = cleanRoomId;
        socket.data.type = "PLAYER";
        lobbyManager.updateUsername(socket.id, cleanName);

        // أبلغ الغرفة بتغيير الـ socket ID (مهم للـ voice)
        socket.to(cleanRoomId).emit("voice_reconnect_request", {
            oldId, newId: socket.id, username: cleanName,
        });

        socket.emit("game_started", { roomId: cleanRoomId, role: player.role });
        logger.rejoin(cleanName, cleanRoomId);
    });

    // =========================================================================
    // VOICE (PeerJS signaling)
    // =========================================================================
    socket.on("voice_peer_id", ({ peerId } = {}) => {
        if (!rateLimiter.events.VOICE(socket.id)) return;
        if (typeof peerId !== "string" || peerId.length > 60) return;

        const room = getRoomForSocket(socket);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.peerId = peerId;

        // أرسل قائمة الـ peers الموجودين
        const peers = room.players
            .filter(p => p.id !== socket.id && p.peerId)
            .map(p => ({ peerId: p.peerId, username: p.username, role: p.role }));

        socket.emit("voice_peers", { peers });

        // أبلغ الباقين بالـ peer الجديد
        socket.to(socket.data.roomId).emit("voice_peer_joined", {
            peerId,
            username: player?.username,
            role: player?.role,
        });

        logger.debug("VOICE", `Peer registered`, { username: player?.username });
    });

    // =========================================================================
    // DISCONNECT
    // =========================================================================
    socket.on("disconnect", (reason) => {
        logger.disconnect(socket.id, reason);

        lobbyManager.removePlayer(socket.id);
        matchmakingManager.removeFromQueue(socket.id);
        rateLimiter.cleanup(socket.id);

        const roomId = socket.data.roomId;
        if (roomId) {
            socket.to(roomId).emit("player_disconnected", { id: socket.id });

            // إزالة الـ spectator من الغرفة
            const room = roomManager.getRoom(roomId);
            if (room) {
                room.spectators = (room.spectators || []).filter(id => id !== socket.id);
            }
        }
    });
});

// ─── تشغيل السيرفر ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info("SERVER", `Started on port ${PORT}`, {
        env: process.env.NODE_ENV || "development",
        client: CLIENT_URL,
    });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
    logger.warn("SERVER", "SIGTERM received — shutting down");
    io.emit("server_reset");
    server.close(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
    logger.error("SERVER", "Uncaught exception", { message: err.message, stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
    logger.error("SERVER", "Unhandled rejection", { reason: String(reason) });
});
