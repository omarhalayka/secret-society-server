// @ts-nocheck
const lobbyManager       = require("../core/lobbyManager");
const matchmakingManager = require("../core/matchmakingManager");
const roomManager        = require("../core/roomManager");
const {
    targetIdSchema,
    rejoinCodeSchema,
    sessionPasswordSchema,
    playerCountSchema,
    generateCodeSchema
} = require("../validation/validationSchemas"); // اضبط المسار حسب مكان الملف

// ... باقي الكود (sessionPassword, rejoinCodes, etc.) ...

function initializeSocket(io) {

    io.on("connection", (socket) => {

        // ... الكود الموجود حتى نهاية الأحداث ...

        // ================= GAME ACTIONS (مع التحقق) =================

        socket.on("mafia_kill", (targetId) => {
            const validation = targetIdSchema.safeParse({ targetId });
            if (!validation.success) {
                socket.emit("error", { message: "Invalid target ID" });
                return;
            }
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerMafiaKill(socket.id, validation.data.targetId);
        });

        socket.on("doctor_save", (targetId) => {
            const validation = targetIdSchema.safeParse({ targetId });
            if (!validation.success) {
                socket.emit("error", { message: "Invalid target ID" });
                return;
            }
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerDoctorSave(socket.id, validation.data.targetId);
        });

        socket.on("detective_check", (targetId) => {
            const validation = targetIdSchema.safeParse({ targetId });
            if (!validation.success) {
                socket.emit("error", { message: "Invalid target ID" });
                return;
            }
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerDetectiveCheck(socket.id, validation.data.targetId);
        });

        socket.on("vote", (targetId) => {
            // الأدمن والمشاهد لا يصوتون
            if (socket.data.isAdmin || socket.data.type === "SPECTATOR") return;
            const validation = targetIdSchema.safeParse({ targetId });
            if (!validation.success) {
                socket.emit("error", { message: "Invalid target ID" });
                return;
            }
            const room = roomManager.getRoom(socket.data.roomId);
            if (!room?.engine) return;
            room.engine.registerVote(socket.id, validation.data.targetId);
        });

        // ================= REJOIN WITH CODE (مع التحقق) =================

        socket.on("rejoin_with_code", (data) => {
            const validation = rejoinCodeSchema.safeParse(data);
            if (!validation.success) {
                socket.emit("error", { message: "Invalid rejoin data" });
                return;
            }
            const { code, username } = validation.data;

            const entry = rejoinCodes[code];
            if (!entry) {
                socket.emit("rejoin_code_error", { message: "كود غلط ❌" });
                return;
            }
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

            // ... باقي الكود كما هو ...
        });

        // ================= SET SESSION PASSWORD (مع التحقق) =================

        socket.on("set_session_password", (data) => {
            const validation = sessionPasswordSchema.safeParse(data);
            if (!validation.success) {
                socket.emit("error", { message: "Invalid password data" });
                return;
            }
            const pw = validation.data.password?.trim() ?? "";
            // ... باقي الكود كما هو ...
        });

        // ================= SET PLAYER COUNT (مع التحقق) =================

        socket.on("set_player_count", (data) => {
            const validation = playerCountSchema.safeParse(data);
            if (!validation.success) {
                socket.emit("error", { message: "Invalid player count" });
                return;
            }
            const count = validation.data.count;
            // ... باقي الكود كما هو ...
        });

        // ================= ADMIN GENERATE ROOM CODE (مع التحقق) =================

        socket.on("admin_generate_room_code", (data) => {
            if (!socket.data.isAdmin) return;
            const validation = generateCodeSchema.safeParse(data);
            if (!validation.success) {
                socket.emit("error", { message: "Invalid role" });
                return;
            }
            const role = validation.data.role;
            // ... باقي الكود كما هو ...
        });

        // ================= باقي الأحداث (لا تحتاج تحقق مباشر أو تمت تغطيتها) =================

        // ...
    });
}

module.exports = initializeSocket;