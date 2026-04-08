// src/game/GameEngine.js
// @ts-nocheck
const logger = require("../utils/logger");
const { emitError, ERROR_TYPES } = require("../utils/errors");

const GAME_ROLES = new Set(["MAFIA", "DOCTOR", "DETECTIVE", "CITIZEN"]);

class GameEngine {
    constructor(players, io, roomId, adminId = null) {
        GameEngine._instanceCounter = (GameEngine._instanceCounter || 0) + 1;
        this.instanceId = `engine-${GameEngine._instanceCounter}`;
        this.players = players;
        this.io = io;
        this.roomId = roomId;
        this.adminId = adminId;
        this.spectators = [];

        this.PHASES = {
            LOBBY:        "LOBBY",
            NIGHT:        "NIGHT",
            DAY:          "DAY",
            VOTING:       "VOTING",
            NIGHT_REVIEW: "NIGHT_REVIEW",
            GAME_OVER:    "GAME_OVER",
        };

        this.phase       = this.PHASES.LOBBY;
        this.round       = 1;
        this.gameOver    = false;
        this.gameStarted = false;
        this.chatEnabled = true;
        this._pendingTimer = null;

        this.votes = {};

        this.lastDoctorTargetPlayerId = null;
        this.lastMafiaTargetPlayerId  = null;

        this.nightActions = {
            mafiaTargetPlayerId:     null,
            doctorSavePlayerId:      null,
            detectiveChecks: [],
        };

        this.nightActionStatus = {
            mafia:     { done: false, playerId: null },
            doctor:    { done: false, playerId: null },
            detective: { done: false, playerId: null },
        };

        this.nightResults = {
            mafiaTargetPlayerId:     null,
            doctorSavePlayerId:      null,
            detectiveChecks: [],
            finalVictimPlayerId:     null,
        };

        this.gameStats = {
            nightKills:         [],
            votingEliminations: [],
            gameLog:            [],
            startTime:          Date.now(),
        };

        // Build quick lookup maps
        this._socketToPlayer = new Map(); // socketId -> player object
        this._playerIdToPlayer = new Map();
        this.players.forEach(p => {
            this._socketToPlayer.set(p.socketId, p);
            this._playerIdToPlayer.set(p.playerId, p);
        });

        console.log("[GameEngine] Created", {
            roomId:     this.roomId,
            instanceId: this.instanceId,
            players:    this.players.length,
        });
    }

    broadcast(event, data) {
        this.io.to(this.roomId).emit(event, data);
    }

    _getViewerPlayer(playerId = null, socketId = null) {
        if (playerId) {
            const byPlayerId = this._playerIdToPlayer.get(playerId);
            if (byPlayerId) return byPlayerId;
        }
        if (socketId) {
            const bySocketId = this._socketToPlayer.get(socketId);
            if (bySocketId) return bySocketId;
        }
        return null;
    }

    _emitRoleAware(event, playerData, spectatorData = playerData) {
        const emitted = new Set();

        this.players.forEach((player) => {
            if (!player?.connected || !player.socketId) return;
            emitted.add(player.socketId);
            this.io.to(player.socketId).emit(event, playerData);
        });

        if (this.adminId) {
            emitted.add(this.adminId);
            this.io.to(this.adminId).emit(event, playerData);
        }

        this.spectators.forEach((socketId) => {
            if (!socketId || emitted.has(socketId)) return;
            this.io.to(socketId).emit(event, spectatorData);
        });
    }

    _serializePlayer(player, role = null) {
        return {
            id:       player.playerId,
            playerId: player.playerId,
            socketId: player.socketId,
            username: player.username,
            alive:    player.alive,
            avatar:   player.avatar || "😎",
            color:    player.color  || "#1e293b",
            role,
        };
    }

    _getVisibleRoleForViewer(targetPlayer, viewerPlayer, { isAdmin = false, isSpectator = false } = {}) {
        if (isAdmin) return targetPlayer.role;
        if (isSpectator || !viewerPlayer) return null;
        if (viewerPlayer.playerId === targetPlayer.playerId) return targetPlayer.role;
        if (viewerPlayer.role === "MAFIA" && targetPlayer.role === "MAFIA") return targetPlayer.role;
        return null;
    }

    getRoomStatePayload({ socketId = null, playerId = null, isAdmin = false, isSpectator = false } = {}) {
        const viewerPlayer = this._getViewerPlayer(playerId, socketId);
        return {
            players: this.players.map((player) => this._serializePlayer(
                player,
                this._getVisibleRoleForViewer(player, viewerPlayer, { isAdmin, isSpectator })
            )),
            phase: this.phase,
            round: this.round,
        };
    }

    _emitRoomState() {
        const emitted = new Set();

        this.players.forEach((player) => {
            if (!player?.connected || !player.socketId) return;
            emitted.add(player.socketId);
            this.io.to(player.socketId).emit("room_state", this.getRoomStatePayload({
                socketId: player.socketId,
                playerId: player.playerId,
            }));
        });

        if (this.adminId) {
            emitted.add(this.adminId);
            this.io.to(this.adminId).emit("room_state", this.getRoomStatePayload({
                socketId: this.adminId,
                isAdmin: true,
            }));
        }

        this.spectators.forEach((socketId) => {
            if (!socketId || emitted.has(socketId)) return;
            this.io.to(socketId).emit("room_state", this.getRoomStatePayload({
                socketId,
                isSpectator: true,
            }));
        });
    }

    _emitToPlayer(playerId, event, data) {
        const p = this._playerIdToPlayer.get(playerId);
        if (p && p.connected && p.socketId) {
            this.io.to(p.socketId).emit(event, data);
        } else {
            logger.debug("GAME", `Cannot emit to player ${playerId}, not connected`);
        }
    }

    _emitRoleError(playerId, event, type, message, extra = {}) {
        this._emitToPlayer(playerId, event, { type, message, ...extra });
        const socket = this.io.sockets.sockets.get(this._playerIdToPlayer.get(playerId)?.socketId);
        if (socket) emitError(socket, type, message, extra);
    }

    _sendNightStatusToAdmin() {
        if (!this.adminId) return;
        const withUsernames = Object.fromEntries(
            Object.entries(this.nightActionStatus).map(([role, value]) => {
                const actor = value.playerId ? this._playerIdToPlayer.get(value.playerId) : null;
                return [role, {
                    ...value,
                    username: actor?.username || null,
                }];
            })
        );
        this.io.to(this.adminId).emit("night_action_status", withUsernames);
    }

    _getAlivePlayer(playerId) {
        const player = this._playerIdToPlayer.get(playerId);
        if (!player || !player.alive) return null;
        return player;
    }

    _buildNightTargetsPayload(player) {
        if (!player || !player.alive || !this._assertPhase(this.PHASES.NIGHT)) {
            return null;
        }

        const alivePlayers = this.players.filter((p) => p.alive);

        if (player.role === "MAFIA") {
            const mafiaPlayers = alivePlayers.filter((p) => p.role === "MAFIA");
            const mafiaTargets = alivePlayers.filter((p) => p.role !== "MAFIA");
            return {
                players:   mafiaTargets.map((p) => this._serializePlayer(p, null)),
                lastTarget:this.lastMafiaTargetPlayerId,
                teamCount: mafiaPlayers.length,
                self:      this._serializePlayer(player, "MAFIA"),
            };
        }

        if (player.role === "DOCTOR") {
            return {
                players: alivePlayers
                    .filter((p) => p.playerId !== player.playerId)
                    .map((p) => this._serializePlayer(p, null)),
                lastTarget: this.lastDoctorTargetPlayerId,
                self:       this._serializePlayer(player, "DOCTOR"),
            };
        }

        if (player.role === "DETECTIVE") {
            return {
                players: alivePlayers
                    .filter((p) => p.playerId !== player.playerId)
                    .map((p) => this._serializePlayer(p, null)),
                lastTarget: null,
                self:       this._serializePlayer(player, "DETECTIVE"),
            };
        }

        return null;
    }

    sendNightTargetsToPlayer(playerId) {
        const player = this._playerIdToPlayer.get(playerId);
        const payload = this._buildNightTargetsPayload(player);
        if (!player || !payload) return false;
        this._emitToPlayer(player.playerId, "night_targets", payload);
        return true;
    }

    _assertPhase(required) {
        return this.phase === required;
    }

    _getPublicPlayers() {
        return this.players.map((p) => this._serializePlayer(p, null));
    }

    _getPlayerBySocketId(socketId) {
        return this._socketToPlayer.get(socketId) || null;
    }

    _getPlayerByTargetRef(targetRef) {
        if (!targetRef || typeof targetRef !== "string") return null;
        return this._playerIdToPlayer.get(targetRef) || this._socketToPlayer.get(targetRef) || null;
    }

    updateSocketId(oldSocketId, newSocketId) {
        const player = this._socketToPlayer.get(oldSocketId);
        if (player) {
            player.socketId = newSocketId;
            player.connected = true;
            this._socketToPlayer.delete(oldSocketId);
            this._socketToPlayer.set(newSocketId, player);
            logger.debug("GAME", `Updated socket for player ${player.playerId} (${player.username})`);
        }
    }

    addSpectator(socketId) {
        if (!this.spectators.includes(socketId)) this.spectators.push(socketId);
    }

    removeSpectator(socketId) {
        this.spectators = this.spectators.filter((id) => id !== socketId);
    }

    resetGame() {
        console.log("[GameEngine] resetGame — clearing all state including lastTargets", {
            roomId:            this.roomId,
            instanceId:        this.instanceId,
            lastMafiaTarget:   this.lastMafiaTargetPlayerId,
            lastDoctorTarget:  this.lastDoctorTargetPlayerId,
        });

        if (this._pendingTimer) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }

        this.gameOver    = false;
        this.gameStarted = false;
        this.round       = 1;
        this.phase       = this.PHASES.LOBBY;
        this.votes       = {};
        this.chatEnabled = true;

        this.lastDoctorTargetPlayerId = null;
        this.lastMafiaTargetPlayerId  = null;

        this.players.forEach((p) => {
            p.alive = true;
            p.role  = null;
        });

        this.nightActions = { mafiaTargetPlayerId: null, doctorSavePlayerId: null, detectiveChecks: [] };
        this.nightActionStatus = {
            mafia:     { done: false, playerId: null },
            doctor:    { done: false, playerId: null },
            detective: { done: false, playerId: null },
        };
        this.nightResults = {
            mafiaTargetPlayerId:     null,
            doctorSavePlayerId:      null,
            detectiveChecks: [],
            finalVictimPlayerId:     null,
        };
        this.gameStats = {
            nightKills:         [],
            votingEliminations: [],
            gameLog:            [],
            startTime:          Date.now(),
        };

        logger.adminAct("resetGame", this.roomId);
        this._sendNightStatusToAdmin();
        this._emitRoomState();
        this.broadcast("back_to_lobby", {});
    }

    startGame() {
        console.log("[GameEngine] startGame", {
            roomId:     this.roomId,
            instanceId: this.instanceId,
        });

        if (this.gameStarted) {
            logger.warn("GAME", "startGame called twice - ignored", { roomId: this.roomId });
            return;
        }

        this.gameStarted = true;
        this.gameOver    = false;
        this.round       = 1;
        this.assignRoles();

        this.players.forEach((player) => {
            this._emitToPlayer(player.playerId, "game_started", {
                roomId: this.roomId,
                role:   player.role,
                playerId: player.playerId,
            });
        });

        if (this.adminId) {
            this.io.to(this.adminId).emit("game_started", {
                roomId: this.roomId,
                role:   "ADMIN",
            });
        }

        this._emitRoomState();

        if (this._pendingTimer) clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.phase       = this.PHASES.DAY;
            this.chatEnabled = true;
            logger.phase(this.phase, this.round, this.roomId);
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
            this._emitRoomState();
        }, 2000);
    }

    assignRoles() {
        const count = this.players.length;
        const shuffled = [...this.players];
        for (let i = count - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        shuffled.forEach((p) => {
            p.role  = "CITIZEN";
            p.alive = true;
        });

        let mafiaCount = 1;
        if (count >= 7 && count <= 9) mafiaCount = 2;
        else if (count >= 10)         mafiaCount = 3;

        let idx = 0;
        for (let m = 0; m < mafiaCount; m++) shuffled[idx++].role = "MAFIA";
        shuffled[idx++].role = "DOCTOR";
        if (count >= 5) shuffled[idx++].role = "DETECTIVE";

        logger.info("GAME", "Roles assigned", {
            roomId: this.roomId,
            roles:  this.players.map((p) => `${p.username}:${p.role}`).join(", "),
        });
    }

    startNight() {
        if (this.gameOver) return;

        console.log("[GameEngine] startNight", {
            roomId:           this.roomId,
            instanceId:       this.instanceId,
            round:            this.round,
            lastMafiaTarget:  this.lastMafiaTargetPlayerId,
            lastDoctorTarget: this.lastDoctorTargetPlayerId,
        });

        this.phase = this.PHASES.NIGHT;

        this.nightActions = { mafiaTargetPlayerId: null, doctorSavePlayerId: null, detectiveChecks: [] };
        this.nightActionStatus = {
            mafia:     { done: false, playerId: null },
            doctor:    { done: false, playerId: null },
            detective: { done: false, playerId: null },
        };
        this.chatEnabled = true;
        this._sendNightStatusToAdmin();

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        this._emitRoomState();
        this.players
            .filter((p) => p.alive && (p.role === "MAFIA" || p.role === "DOCTOR" || p.role === "DETECTIVE"))
            .forEach((player) => this.sendNightTargetsToPlayer(player.playerId));
    }

    registerMafiaKill(socketId, targetRef) {
        const player = this._getPlayerBySocketId(socketId);
        if (!player || player.role !== "MAFIA" || !player.alive) {
            return { rejected: true, reason: "NOT_MAFIA" };
        }

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            this._emitRoleError(player.playerId, "mafia_error", ERROR_TYPES.WRONG_PHASE,
                "لا يمكن تنفيذ هذا الإجراء خارج مرحلة الليل");
            return { rejected: true, reason: ERROR_TYPES.WRONG_PHASE };
        }

        if (this.nightActionStatus.mafia.done) {
            this._emitRoleError(player.playerId, "mafia_error", ERROR_TYPES.ACTION_USED,
                "لقد قمت بتحديد هدف بالفعل هذه الليلة");
            return { rejected: true, reason: ERROR_TYPES.ACTION_USED };
        }

        const target = this._getPlayerByTargetRef(targetRef);
        if (!target || !target.alive) {
            this._emitRoleError(player.playerId, "mafia_error", ERROR_TYPES.INVALID_TARGET,
                "الهدف غير صالح أو ميت");
            return { rejected: true, reason: ERROR_TYPES.INVALID_TARGET };
        }

        if (target.role === "MAFIA") {
            this._emitRoleError(player.playerId, "mafia_error", ERROR_TYPES.INVALID_TARGET,
                "لا يمكنك استهداف أحد أفراد المافيا");
            return { rejected: true, reason: ERROR_TYPES.INVALID_TARGET };
        }

        // ✅ منع استهداف نفس اللاعب ليلتين متتاليتين
        if (false && this.lastMafiaTargetPlayerId !== null && this.lastMafiaTargetPlayerId === target.playerId) {
            this._emitRoleError(player.playerId, "mafia_error",
                ERROR_TYPES.MAFIA_REPEAT_TARGET,
                "لا يمكنك استهداف نفس اللاعب مرتين ❌");
            return { rejected: true, reason: ERROR_TYPES.MAFIA_REPEAT_TARGET };
        }

        this.nightActions.mafiaTargetPlayerId = target.playerId;
        this.nightActionStatus.mafia = { done: true, playerId: player.playerId };
        logger.kill(player.username, target.username, this.round);

        this.players
            .filter((p) => p.role === "MAFIA" && p.alive && p.playerId !== player.playerId)
            .forEach((m) => {
                this._emitToPlayer(m.playerId, "mafia_suggestion", {
                    suggestedBy:    player.username,
                    targetId:       target.playerId,
                    targetSocketId: target.socketId,
                    targetPlayerId: target.playerId,
                    targetUsername: target.username,
                });
            });

        this._sendNightStatusToAdmin();

        this._emitToPlayer(player.playerId, "mafia_action_registered", {
            ok:             true,
            targetId:       target.playerId,
            targetSocketId: target.socketId,
            targetPlayerId: target.playerId,
            targetUsername: target.username,
            round:          this.round,
        });

        console.log("[GameEngine] Mafia action accepted", {
            roomId:         this.roomId,
            round:          this.round,
            targetPlayerId: target.playerId,
            targetUsername: target.username,
        });

        return { ok: true, targetPlayerId: target.playerId };
    }

    registerDoctorSave(socketId, targetRef) {
        const player = this._getPlayerBySocketId(socketId);
        if (!player || player.role !== "DOCTOR" || !player.alive) {
            return { rejected: true, reason: "NOT_DOCTOR" };
        }

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            this._emitRoleError(player.playerId, "doctor_error", ERROR_TYPES.WRONG_PHASE,
                "لا يمكنك الحماية خارج مرحلة الليل");
            return { rejected: true, reason: ERROR_TYPES.WRONG_PHASE };
        }

        if (this.nightActionStatus.doctor.done) {
            this._emitRoleError(player.playerId, "doctor_error", ERROR_TYPES.ACTION_USED,
                "لقد قمت بتحديد من تحمي بالفعل هذه الليلة");
            return { rejected: true, reason: ERROR_TYPES.ACTION_USED };
        }

        const target = this._getPlayerByTargetRef(targetRef);
        if (!target || !target.alive) {
            this._emitRoleError(player.playerId, "doctor_error", ERROR_TYPES.INVALID_TARGET,
                "الهدف غير صالح أو ميت");
            return { rejected: true, reason: ERROR_TYPES.INVALID_TARGET };
        }

        if (player.playerId === target.playerId) {
            this._emitRoleError(player.playerId, "doctor_error", ERROR_TYPES.SELF_TARGET,
                "لا يمكنك حماية نفسك");
            return { rejected: true, reason: ERROR_TYPES.SELF_TARGET };
        }

        // ✅ منع حماية نفس اللاعب ليلتين متتاليتين
        if (false && this.lastDoctorTargetPlayerId !== null && this.lastDoctorTargetPlayerId === target.playerId) {
            this._emitRoleError(player.playerId, "doctor_error",
                ERROR_TYPES.DOCTOR_REPEAT_TARGET,
                "لا يمكنك حماية نفس اللاعب مرتين ❌");
            return { rejected: true, reason: ERROR_TYPES.DOCTOR_REPEAT_TARGET };
        }

        this.nightActions.doctorSavePlayerId = target.playerId;
        this.nightActionStatus.doctor = { done: true, playerId: player.playerId };
        logger.save(player.username, target.username, this.round);

        this._sendNightStatusToAdmin();

        this._emitToPlayer(player.playerId, "doctor_action_registered", {
            ok:             true,
            targetId:       target.playerId,
            targetSocketId: target.socketId,
            targetPlayerId: target.playerId,
            targetUsername: target.username,
            round:          this.round,
        });

        console.log("[GameEngine] Doctor action accepted", {
            roomId:         this.roomId,
            round:          this.round,
            targetPlayerId: target.playerId,
            targetUsername: target.username,
        });

        return { ok: true, targetPlayerId: target.playerId };
    }

    registerDetectiveCheck(socketId, targetRef) {
        const player = this._getPlayerBySocketId(socketId);
        if (!player || player.role !== "DETECTIVE" || !player.alive) return;
        const socket = this.io.sockets.sockets.get(socketId);

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            if (socket) emitError(socket, ERROR_TYPES.WRONG_PHASE, "لا يمكنك التحقيق خارج مرحلة الليل");
            return;
        }

        if (this.nightActionStatus.detective.done) {
            if (socket) emitError(socket, ERROR_TYPES.ACTION_USED, "لقد قمت بالتحقيق بالفعل هذه الليلة");
            return;
        }

        const target = this._getPlayerByTargetRef(targetRef);
        if (!target || !target.alive) {
            if (socket) emitError(socket, ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }

        if (player.playerId === target.playerId) {
            if (socket) emitError(socket, ERROR_TYPES.SELF_TARGET, "لا يمكنك التحقيق في نفسك");
            return;
        }

        const result = target.role === "MAFIA" ? "MAFIA" : "NOT MAFIA";

        this.nightActions.detectiveChecks.push({
            detectivePlayerId: player.playerId,
            targetPlayerId:    target.playerId,
            targetUsername:    target.username,
            result,
        });
        this.nightActionStatus.detective = { done: true, playerId: player.playerId };

        this._emitToPlayer(player.playerId, "detective_result", {
            username: target.username,
            playerId: target.playerId,
            role:     result,
        });

        logger.check(player.username, target.username, result);
        this._sendNightStatusToAdmin();
    }

    endNight() {
        if (this.gameOver) return;

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            logger.warn("GAME", "endNight called outside NIGHT phase", { phase: this.phase });
            return;
        }

        const { mafiaTargetPlayerId, doctorSavePlayerId, detectiveChecks } = this.nightActions;
        const finalVictimPlayerId = (mafiaTargetPlayerId && mafiaTargetPlayerId !== doctorSavePlayerId) ? mafiaTargetPlayerId : null;

        // Update last targets (stable playerId)
        // If a role acted this night, store their target for the consecutive-night restriction.
        // If a role did NOT act (skipped), clear the restriction so it doesn't persist forever.
        this.lastMafiaTargetPlayerId = mafiaTargetPlayerId || null;
        console.log("[Persist] lastMafiaTargetPlayerId updated in endNight:", this.lastMafiaTargetPlayerId);

        this.lastDoctorTargetPlayerId = doctorSavePlayerId || null;
        console.log("[Persist] lastDoctorTargetPlayerId updated in endNight:", this.lastDoctorTargetPlayerId);

        console.log("[GameEngine] endNight — final state", {
            roomId:                  this.roomId,
            round:                   this.round,
            mafiaTargetPlayerId,
            doctorSavePlayerId,
            finalVictimPlayerId,
            persistedLastMafiaTarget:  this.lastMafiaTargetPlayerId,
            persistedLastDoctorTarget: this.lastDoctorTargetPlayerId,
        });

        this.nightResults = {
            mafiaTargetPlayerId,
            doctorSavePlayerId,
            detectiveChecks: detectiveChecks || [],
            finalVictimPlayerId,
            timestamp:       Date.now(),
        };

        this.phase       = this.PHASES.NIGHT_REVIEW;
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);

        if (this.adminId) {
            const resultForAdmin = {
                mafiaTarget: this.players.find(p => p.playerId === mafiaTargetPlayerId)?.username || null,
                doctorSave:  this.players.find(p => p.playerId === doctorSavePlayerId)?.username || null,
                finalVictim: this.players.find(p => p.playerId === finalVictimPlayerId)?.username || null,
                mafiaTargetId: mafiaTargetPlayerId,
                doctorSaveId: doctorSavePlayerId,
                finalVictimId: finalVictimPlayerId,
            };
            this.io.to(this.adminId).emit("night_review", resultForAdmin);
        }

        this.broadcast("phase_changed", {
            phase:   this.phase,
            round:   this.round,
            message: "انتهى الليل، بانتظار القصة...",
        });
        this._emitRoomState();
    }

    executeNightResults() {
        let mafiaTargetPlayerId = this.nightResults.mafiaTargetPlayerId;
        let doctorSavePlayerId  = this.nightResults.doctorSavePlayerId;
        let finalVictimPlayerId = this.nightResults.finalVictimPlayerId;

        // Fallback: if nightResults empty, use nightActions
        if (!mafiaTargetPlayerId && this.nightActions.mafiaTargetPlayerId) {
            mafiaTargetPlayerId = this.nightActions.mafiaTargetPlayerId;
        }
        if (!doctorSavePlayerId && this.nightActions.doctorSavePlayerId) {
            doctorSavePlayerId = this.nightActions.doctorSavePlayerId;
        }
        if (!finalVictimPlayerId && mafiaTargetPlayerId && mafiaTargetPlayerId !== doctorSavePlayerId) {
            finalVictimPlayerId = mafiaTargetPlayerId;
        }

        // Update last targets BEFORE clearing nightActions
        // Same logic as endNight: unconditionally set so skipped nights clear the restriction
        this.lastMafiaTargetPlayerId = mafiaTargetPlayerId || null;
        console.log("[Persist] lastMafiaTargetPlayerId updated in executeNightResults:", this.lastMafiaTargetPlayerId);

        this.lastDoctorTargetPlayerId = doctorSavePlayerId || null;
        console.log("[Persist] lastDoctorTargetPlayerId updated in executeNightResults:", this.lastDoctorTargetPlayerId);

        const mafiaTarget = this._playerIdToPlayer.get(mafiaTargetPlayerId);
        const doctorSave  = this._playerIdToPlayer.get(doctorSavePlayerId);
        const finalVictim = this._playerIdToPlayer.get(finalVictimPlayerId);

        if (mafiaTargetPlayerId) {
            const saved = mafiaTargetPlayerId === doctorSavePlayerId;
            this.gameStats.nightKills.push({
                round:    this.round,
                username: mafiaTarget?.username || "Unknown",
                saved,
            });
            this.gameStats.gameLog.push({
                round: this.round,
                type:  saved ? "save" : "kill",
                icon:  saved ? "✚" : "🔪",
                text:  saved
                    ? `تم استهداف ${mafiaTarget?.username} لكن أنقذه الطبيب`
                    : `تم قتل ${mafiaTarget?.username} في الليل`,
            });
        } else {
            this.gameStats.gameLog.push({
                round: this.round,
                type:  "quiet",
                icon:  "🌙",
                text:  "مرت الليلة بسلام",
            });
        }

        if (finalVictim && finalVictim.alive) {
            finalVictim.alive = false;
            this.broadcast("player_killed", {
                id: finalVictim.playerId,
                socketId: finalVictim.socketId,
                username: finalVictim.username,
                playerId: finalVictim.playerId,
            });
        }

        this._emitRoomState();

        // Reset night data for next night
        this.nightActions = { mafiaTargetPlayerId: null, doctorSavePlayerId: null, detectiveChecks: [] };
        this.nightActionStatus = {
            mafia:     { done: false, playerId: null },
            doctor:    { done: false, playerId: null },
            detective: { done: false, playerId: null },
        };
        this.nightResults = {
            mafiaTargetPlayerId:     null,
            doctorSavePlayerId:      null,
            detectiveChecks: [],
            finalVictimPlayerId:     null,
        };
        this._sendNightStatusToAdmin();
    }

    startDay() {
        if (this.gameOver) return;

        console.log("[GameEngine] startDay", {
            roomId:           this.roomId,
            round:            this.round + 1,
            lastMafiaTarget:  this.lastMafiaTargetPlayerId,
            lastDoctorTarget: this.lastDoctorTargetPlayerId,
        });

        this.phase       = this.PHASES.DAY;
        this.round      += 1;
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        this._emitRoomState();
    }

    startVoting() {
        if (this.gameOver) return;

        this.phase       = this.PHASES.VOTING;
        this.votes       = {};
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("voting_started", {});
        this._emitRoomState();
        this.broadcast("phase_changed", { phase: this.phase, round: this.round, message: "حان وقت التصويت!" });
    }

    registerVote(socketId, targetRef) {
        const socket = this.io.sockets.sockets.get(socketId);

        if (!this._assertPhase(this.PHASES.VOTING)) {
            if (socket) emitError(socket, ERROR_TYPES.WRONG_PHASE, "التصويت غير مسموح حالياً");
            return;
        }

        const player = this._getPlayerBySocketId(socketId);
        if (!player || !player.alive) {
            if (socket) emitError(socket, ERROR_TYPES.PLAYER_DEAD, "اللاعبون الموتى لا يصوتون");
            return;
        }

        if (this.votes[player.playerId]) {
            if (socket) emitError(socket, ERROR_TYPES.ALREADY_VOTED, "لقد صوتت بالفعل");
            return;
        }

        const target = this._getPlayerByTargetRef(targetRef);
        if (!target || !target.alive) {
            if (socket) emitError(socket, ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }

        this.votes[player.playerId] = target.playerId;
        logger.vote(player.username, target.username, this.round);

        const alivePlayers = this.players.filter((p) => p.alive).length;
        const totalVotes   = Object.keys(this.votes).length;
        const remaining    = alivePlayers - totalVotes;

        const count = {};
        Object.values(this.votes).forEach((targetPlayerId) => {
            count[targetPlayerId] = (count[targetPlayerId] || 0) + 1;
        });

        this.broadcast("vote_update", { votes: count, remaining });
    }

    endVoting() {
        if (this.gameOver) return;

        const count = {};
        Object.values(this.votes).forEach((targetPlayerId) => {
            count[targetPlayerId] = (count[targetPlayerId] || 0) + 1;
        });

        let maxVotes   = 0;
        let topPlayerIds = [];

        for (const playerId in count) {
            if (count[playerId] > maxVotes) {
                maxVotes   = count[playerId];
                topPlayerIds = [playerId];
            } else if (count[playerId] === maxVotes) {
                topPlayerIds.push(playerId);
            }
        }

        if (topPlayerIds.length === 1) {
            const victim = this._playerIdToPlayer.get(topPlayerIds[0]);
            if (victim) {
                victim.alive = false;
                this.gameStats.votingEliminations.push({
                    round:    this.round,
                    username: victim.username,
                    role:     victim.role,
                });
                this.gameStats.gameLog.push({
                    round: this.round,
                    type:  "vote",
                    icon:  "🗳",
                    text:  `تم إقصاء ${victim.username} بالتصويت (${victim.role})`,
                });
            }
            this._emitRoleAware("voting_result", {
                eliminated: victim?.username,
                role:       victim?.role,
                tie:        false,
            }, {
                eliminated: victim?.username,
                role:       null,
                tie:        false,
            });
        } else {
            this.broadcast("voting_result", { eliminated: null, tie: true });
        }

        this._emitRoomState();

        if (this.checkWinCondition()) return;

        if (this._pendingTimer) clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            if (this.gameOver) return;
            this.phase       = this.PHASES.DAY;
            this.chatEnabled = true;
            logger.phase(this.phase, this.round, this.roomId);
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
            this._emitRoomState();
        }, 4000);
    }

    checkWinCondition() {
        const activePlayers  = this.players.filter((p) => GAME_ROLES.has(p.role));
        const mafiaAlive     = activePlayers.filter((p) => p.role === "MAFIA" && p.alive).length;
        const citizensAlive  = activePlayers.filter((p) => p.role !== "MAFIA" && p.alive).length;

        if (mafiaAlive === 0)              { this.endGame("CITIZENS"); return true; }
        if (mafiaAlive >= citizensAlive)   { this.endGame("MAFIA");    return true; }
        return false;
    }

    endGame(winner) {
        if (this._pendingTimer) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }

        this.gameOver    = true;
        this.phase       = this.PHASES.GAME_OVER;
        this.chatEnabled = true;

        const duration = Math.floor((Date.now() - this.gameStats.startTime) / 1000);
        const rounds   = this.round;

        logger.win(winner, this.roomId, rounds);

        const roles = this.players.map((p) => ({
            username: p.username,
            role:     p.role,
            alive:    p.alive,
            avatar:   p.avatar || "😎",
            color:    p.color  || "#1e293b",
        }));

        this._emitRoleAware("game_over", {
            winner,
            roles,
            rounds,
            duration: this._formatDuration(duration),
            stats: {
                nightKills:         this.gameStats.nightKills,
                votingEliminations: this.gameStats.votingEliminations,
                gameLog:            this.gameStats.gameLog,
                duration,
            },
        }, {
            winner,
            roles: roles.map((player) => ({ ...player, role: null })),
            rounds,
            duration: this._formatDuration(duration),
            stats: {
                nightKills:         this.gameStats.nightKills,
                votingEliminations: this.gameStats.votingEliminations,
                gameLog:            this.gameStats.gameLog,
                duration,
            },
        });
    }

    _formatDuration(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }
}

module.exports = GameEngine;
