// src/game/GameEngine.js
// @ts-nocheck
const logger = require("../utils/logger");
const { emitError, ERROR_TYPES } = require("../utils/errors");

const GAME_ROLES = new Set(["MAFIA", "DOCTOR", "DETECTIVE", "CITIZEN"]);

class GameEngine {
    constructor(players, io, roomId, adminId = null) {
        this.players = players;
        this.io = io;
        this.roomId = roomId;
        this.adminId = adminId;
        this.spectators = [];

        this.PHASES = {
            LOBBY: "LOBBY",
            NIGHT: "NIGHT",
            DAY: "DAY",
            VOTING: "VOTING",
            NIGHT_REVIEW: "NIGHT_REVIEW",
            GAME_OVER: "GAME_OVER",
        };

        this.phase = this.PHASES.LOBBY;
        this.round = 1;
        this.gameOver = false;
        this.gameStarted = false;
        this.chatEnabled = true;
        this._pendingTimer = null;

        this.votes = {};
        this.lastDoctorTarget = null;
        this.lastMafiaTarget = null;

        this.nightActions = {
            mafiaTarget: null,
            doctorSave: null,
            detectiveChecks: [],
        };

        this.nightActionStatus = {
            mafia: { done: false, username: null },
            doctor: { done: false, username: null },
            detective: { done: false, username: null },
        };

        this.nightResults = {
            mafiaTarget: null,
            doctorSave: null,
            detectiveChecks: [],
            finalVictim: null,
        };

        this.gameStats = {
            nightKills: [],
            votingEliminations: [],
            gameLog: [],
            startTime: Date.now(),
        };
    }

    broadcast(event, data) {
        this.io.to(this.roomId).emit(event, data);
    }

    _emitToPlayer(playerId, event, data) {
        this.io.to(playerId).emit(event, data);
    }

    _emitRoleError(playerId, event, type, message, extra = {}) {
        this._emitToPlayer(playerId, event, { type, message, ...extra });
        emitError(this.io.to(playerId), type, message, extra);
    }

    _sendNightStatusToAdmin() {
        if (!this.adminId) return;
        this._emitToPlayer(this.adminId, "night_action_status", this.nightActionStatus);
    }

    _getAlivePlayer(playerId) {
        const player = this.players.find((p) => p.id === playerId);
        if (!player || !player.alive) return null;
        return player;
    }

    _assertPhase(required) {
        return this.phase === required;
    }

    addSpectator(socketId) {
        if (!this.spectators.includes(socketId)) this.spectators.push(socketId);
    }

    removeSpectator(socketId) {
        this.spectators = this.spectators.filter((id) => id !== socketId);
    }

    resetGame() {
        if (this._pendingTimer) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }

        this.gameOver = false;
        this.gameStarted = false;
        this.round = 1;
        this.phase = this.PHASES.LOBBY;
        this.votes = {};
        this.chatEnabled = true;
        this.lastDoctorTarget = null;
        this.lastMafiaTarget = null;

        this.players.forEach((p) => {
            p.alive = true;
            p.role = null;
        });

        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };
        this.nightActionStatus = {
            mafia: { done: false, username: null },
            doctor: { done: false, username: null },
            detective: { done: false, username: null },
        };
        this.nightResults = {
            mafiaTarget: null,
            doctorSave: null,
            detectiveChecks: [],
            finalVictim: null,
        };
        this.gameStats = {
            nightKills: [],
            votingEliminations: [],
            gameLog: [],
            startTime: Date.now(),
        };

        logger.adminAct("resetGame", this.roomId);
        this.broadcast("back_to_lobby", {});
    }

    startGame() {
        if (this.gameStarted) {
            logger.warn("GAME", "startGame called twice - ignored", { roomId: this.roomId });
            return;
        }

        this.gameStarted = true;
        this.gameOver = false;
        this.round = 1;
        this.assignRoles();

        this.players.forEach((player) => {
            this._emitToPlayer(player.id, "game_started", {
                roomId: this.roomId,
                role: player.role,
            });
        });

        if (this.adminId) {
            this._emitToPlayer(this.adminId, "game_started", {
                roomId: this.roomId,
                role: "ADMIN",
            });
        }

        this.broadcast("room_state", {
            players: this._getPublicPlayers(),
            phase: this.PHASES.LOBBY,
            round: this.round,
        });

        if (this._pendingTimer) clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            logger.phase(this.phase, this.round, this.roomId);
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        }, 2000);
    }

    _getPublicPlayers() {
        return this.players.map((p) => ({
            id: p.id,
            username: p.username,
            alive: p.alive,
            avatar: p.avatar || "😎",
            color: p.color || "#1e293b",
            role: null,
        }));
    }

    assignRoles() {
        const count = this.players.length;

        for (let i = count - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        }

        this.players.forEach((p) => {
            p.role = "CITIZEN";
            p.alive = true;
        });

        let mafiaCount = 1;
        if (count >= 7 && count <= 9) mafiaCount = 2;
        else if (count >= 10) mafiaCount = 3;

        let idx = 0;
        for (let m = 0; m < mafiaCount; m += 1) this.players[idx++].role = "MAFIA";
        this.players[idx++].role = "DOCTOR";
        if (count >= 5) this.players[idx++].role = "DETECTIVE";

        logger.info("GAME", "Roles assigned", {
            roomId: this.roomId,
            roles: this.players.map((p) => `${p.username}:${p.role}`).join(", "),
        });
    }

    startNight() {
        if (this.gameOver) return;

        this.phase = this.PHASES.NIGHT;
        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };
        this.nightActionStatus = {
            mafia: { done: false, username: null },
            doctor: { done: false, username: null },
            detective: { done: false, username: null },
        };
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
    }

    registerMafiaKill(playerId, targetId) {
        const player = this._getAlivePlayer(playerId);
        if (!player || player.role !== "MAFIA") return;

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            this._emitRoleError(playerId, "mafia_error", ERROR_TYPES.WRONG_PHASE, "لا يمكن تنفيذ هذا الإجراء خارج مرحلة الليل");
            return;
        }

        const target = this.players.find((p) => p.id === targetId);
        if (!target || !target.alive) {
            this._emitRoleError(playerId, "mafia_error", ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }
        if (target.role === "MAFIA") {
            this._emitRoleError(playerId, "mafia_error", ERROR_TYPES.INVALID_TARGET, "لا يمكنك استهداف أحد أفراد المافيا");
            return;
        }
        console.log("Last Mafia Target:", this.lastMafiaTarget);
        console.log("New Target:", targetId);
        if (this.lastMafiaTarget === targetId) {
            const error = { error: "MAFIA_REPEAT_TARGET" };
            this._emitRoleError(playerId, "mafia_error", ERROR_TYPES.MAFIA_REPEAT_TARGET, "لا يمكنك استهداف نفس اللاعب ليلتين متتاليتين", error);
            return error;
        }

        this.nightActions.mafiaTarget = targetId;
        logger.kill(player.username, target.username, this.round);

        this.players
            .filter((p) => p.role === "MAFIA" && p.alive && p.id !== playerId)
            .forEach((m) => {
                this._emitToPlayer(m.id, "mafia_suggestion", {
                    suggestedBy: player.username,
                    targetId,
                    targetUsername: target.username,
                });
            });

        this.nightActionStatus.mafia = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    registerDoctorSave(playerId, targetId) {
        const player = this._getAlivePlayer(playerId);
        if (!player || player.role !== "DOCTOR") return;

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            this._emitRoleError(playerId, "doctor_error", ERROR_TYPES.WRONG_PHASE, "لا يمكنك الحماية خارج مرحلة الليل");
            return;
        }

        const target = this.players.find((p) => p.id === targetId);
        if (!target || !target.alive) {
            this._emitRoleError(playerId, "doctor_error", ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }
        if (playerId === targetId) {
            this._emitRoleError(playerId, "doctor_error", ERROR_TYPES.SELF_TARGET, "لا يمكنك حماية نفسك");
            return;
        }
        console.log("Last Doctor Target:", this.lastDoctorTarget);
        console.log("New Target:", targetId);
        if (this.lastDoctorTarget === targetId) {
            const error = { error: "DOCTOR_REPEAT_TARGET" };
            this._emitRoleError(playerId, "doctor_error", ERROR_TYPES.DOCTOR_REPEAT_TARGET, "لا يمكنك حماية نفس اللاعب ليلتين متتاليتين", error);
            return error;
        }

        this.nightActions.doctorSave = targetId;
        logger.save(player.username, target.username, this.round);

        this.nightActionStatus.doctor = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    registerDetectiveCheck(playerId, targetId) {
        const player = this._getAlivePlayer(playerId);
        if (!player || player.role !== "DETECTIVE") return;

        if (!this._assertPhase(this.PHASES.NIGHT)) {
            emitError(this.io.to(playerId), ERROR_TYPES.WRONG_PHASE, "لا يمكنك التحقيق خارج مرحلة الليل");
            return;
        }

        const target = this.players.find((p) => p.id === targetId);
        if (!target || !target.alive) {
            emitError(this.io.to(playerId), ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }
        if (playerId === targetId) {
            emitError(this.io.to(playerId), ERROR_TYPES.SELF_TARGET, "لا يمكنك التحقيق في نفسك");
            return;
        }

        const result = target.role === "MAFIA" ? "MAFIA" : "NOT MAFIA";
        this.nightActions.detectiveChecks.push({
            detectiveId: playerId,
            targetId,
            targetUsername: target.username,
            result,
        });

        this._emitToPlayer(playerId, "detective_result", {
            username: target.username,
            id: target.id,
            role: result,
        });

        logger.check(player.username, target.username, result);
        this.nightActionStatus.detective = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    endNight() {
        if (this.gameOver) return;
        if (!this._assertPhase(this.PHASES.NIGHT)) {
            logger.warn("GAME", "endNight called outside NIGHT phase", { phase: this.phase });
            return;
        }

        const { mafiaTarget, doctorSave, detectiveChecks } = this.nightActions;
        const finalVictim = mafiaTarget && mafiaTarget !== doctorSave ? mafiaTarget : null;

        if (mafiaTarget) this.lastMafiaTarget = mafiaTarget;
        if (doctorSave) this.lastDoctorTarget = doctorSave;

        this.nightResults = {
            mafiaTarget,
            doctorSave,
            detectiveChecks: detectiveChecks || [],
            finalVictim,
            timestamp: Date.now(),
        };

        this.phase = this.PHASES.NIGHT_REVIEW;
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);

        if (this.adminId) {
            this._emitToPlayer(this.adminId, "night_review", this.nightResults);
        }

        this.broadcast("phase_changed", {
            phase: this.phase,
            round: this.round,
            message: "انتهى الليل، بانتظار القصة...",
        });
    }

    executeNightResults() {
        const { finalVictim, mafiaTarget, doctorSave } = this.nightResults;

        if (mafiaTarget) {
            const target = this.players.find((p) => p.id === mafiaTarget);
            const saved = mafiaTarget === doctorSave;

            this.gameStats.nightKills.push({
                round: this.round,
                username: target?.username || "Unknown",
                saved,
            });
            this.gameStats.gameLog.push({
                round: this.round,
                type: saved ? "save" : "kill",
                icon: saved ? "✚" : "🔪",
                text: saved
                    ? `${target?.username} was targeted but saved by the Doctor`
                    : `${target?.username} was killed in the night`,
            });
        } else {
            this.gameStats.gameLog.push({
                round: this.round,
                type: "quiet",
                icon: "🌙",
                text: "The night passed in silence",
            });
        }

        if (finalVictim) {
            const victim = this.players.find((p) => p.id === finalVictim);
            if (victim && victim.alive) {
                victim.alive = false;
                this.broadcast("player_killed", { id: victim.id, username: victim.username });
            }
        }

        this.nightResults = {
            mafiaTarget: null,
            doctorSave: null,
            detectiveChecks: [],
            finalVictim: null,
        };
    }

    startDay() {
        if (this.gameOver) return;

        this.phase = this.PHASES.DAY;
        this.round += 1;
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
    }

    startVoting() {
        if (this.gameOver) return;

        this.phase = this.PHASES.VOTING;
        this.votes = {};
        this.chatEnabled = true;

        logger.phase(this.phase, this.round, this.roomId);
        this.broadcast("voting_started", {});
    }

    registerVote(playerId, targetId) {
        if (!this._assertPhase(this.PHASES.VOTING)) {
            emitError(this.io.to(playerId), ERROR_TYPES.WRONG_PHASE, "التصويت غير مسموح حالياً");
            return;
        }

        const player = this._getAlivePlayer(playerId);
        if (!player) {
            emitError(this.io.to(playerId), ERROR_TYPES.PLAYER_DEAD, "اللاعبون الموتى لا يصوتون");
            return;
        }

        if (this.votes[playerId]) {
            emitError(this.io.to(playerId), ERROR_TYPES.ALREADY_VOTED, "لقد صوتت بالفعل");
            return;
        }

        const target = this.players.find((p) => p.id === targetId);
        if (!target || !target.alive) {
            emitError(this.io.to(playerId), ERROR_TYPES.INVALID_TARGET, "الهدف غير صالح أو ميت");
            return;
        }

        this.votes[playerId] = targetId;
        logger.vote(player.username, target.username, this.round);

        const alivePlayers = this.players.filter((p) => p.alive).length;
        const totalVotes = Object.keys(this.votes).length;
        const remaining = alivePlayers - totalVotes;

        const count = {};
        Object.values(this.votes).forEach((id) => {
            count[id] = (count[id] || 0) + 1;
        });

        this.broadcast("vote_update", { votes: count, remaining });
    }

    endVoting() {
        if (this.gameOver) return;

        const count = {};
        Object.values(this.votes).forEach((id) => {
            count[id] = (count[id] || 0) + 1;
        });

        let maxVotes = 0;
        let topPlayers = [];

        for (const id in count) {
            if (count[id] > maxVotes) {
                maxVotes = count[id];
                topPlayers = [id];
            } else if (count[id] === maxVotes) {
                topPlayers.push(id);
            }
        }

        if (topPlayers.length === 1) {
            const victim = this.players.find((p) => p.id === topPlayers[0]);
            if (victim) {
                victim.alive = false;
                this.gameStats.votingEliminations.push({
                    round: this.round,
                    username: victim.username,
                    role: victim.role,
                });
                this.gameStats.gameLog.push({
                    round: this.round,
                    type: "vote",
                    icon: "🗳",
                    text: `${victim.username} was eliminated by vote (${victim.role})`,
                });
            }
            this.broadcast("voting_result", {
                eliminated: victim?.username,
                role: victim?.role,
                tie: false,
            });
        } else {
            this.broadcast("voting_result", { eliminated: null, tie: true });
        }

        if (this.checkWinCondition()) return;

        if (this._pendingTimer) clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            if (this.gameOver) return;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            logger.phase(this.phase, this.round, this.roomId);
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        }, 4000);
    }

    checkWinCondition() {
        const activePlayers = this.players.filter((p) => GAME_ROLES.has(p.role));
        const mafiaAlive = activePlayers.filter((p) => p.role === "MAFIA" && p.alive).length;
        const citizensAlive = activePlayers.filter((p) => p.role !== "MAFIA" && p.alive).length;

        if (mafiaAlive === 0) {
            this.endGame("CITIZENS");
            return true;
        }
        if (mafiaAlive >= citizensAlive) {
            this.endGame("MAFIA");
            return true;
        }
        return false;
    }

    endGame(winner) {
        if (this._pendingTimer) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }

        this.gameOver = true;
        this.phase = this.PHASES.GAME_OVER;
        this.chatEnabled = true;

        const duration = Math.floor((Date.now() - this.gameStats.startTime) / 1000);
        const rounds = this.round;

        logger.win(winner, this.roomId, rounds);

        const roles = this.players.map((p) => ({
            username: p.username,
            role: p.role,
            alive: p.alive,
            avatar: p.avatar || "😎",
            color: p.color || "#1e293b",
        }));

        this.broadcast("game_over", {
            winner,
            roles,
            rounds,
            duration: this._formatDuration(duration),
            stats: {
                nightKills: this.gameStats.nightKills,
                votingEliminations: this.gameStats.votingEliminations,
                gameLog: this.gameStats.gameLog,
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
