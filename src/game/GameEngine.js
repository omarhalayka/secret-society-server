// @ts-nocheck
class GameEngine {

    constructor(players, io, roomId, adminId = null) {
        this.players   = players;
        this.io        = io;
        this.roomId    = roomId;
        this.adminId   = adminId;
        this.spectators = [];

        this.PHASES = {
            LOBBY:        "LOBBY",
            NIGHT:        "NIGHT",
            DAY:          "DAY",
            VOTING:       "VOTING",
            NIGHT_REVIEW: "NIGHT_REVIEW",
            GAME_OVER:    "GAME_OVER"
        };

        this.phase    = this.PHASES.LOBBY;
        this.round    = 1;
        this.gameOver = false;
        this.chatEnabled = true;
        this._pendingTimer = null;

        this.votes = {};

        this.nightActions = {
            mafiaTarget:     null,
            doctorSave:      null,
            detectiveChecks: []
        };

        this.nightActionStatus = {
            mafia:     { done: false, username: null },
            doctor:    { done: false, username: null },
            detective: { done: false, username: null },
        };

        this.nightResults = {
            mafiaTarget:     null,
            doctorSave:      null,
            detectiveChecks: [],
            finalVictim:     null,
            summary:         {}
        };

        // ─── Doctor restrictions: آخر لاعب أنقذه الطبيب ───
        this.lastDoctorTarget = null;

        // ─── game stats ───
        this.gameStats = {
            nightKills:          [],
            votingEliminations:  [],
            gameLog:             [],
            startTime:           Date.now(),
        };
    }

    // ─── spectators ───
    addSpectator(socketId) {
        if (!this.spectators.includes(socketId)) this.spectators.push(socketId);
    }
    removeSpectator(socketId) {
        this.spectators = this.spectators.filter(id => id !== socketId);
    }

    // ─── broadcast ───
    broadcast(event, data) {
        this.io.to(this.roomId).emit(event, data);
    }

    _sendNightStatusToAdmin() {
        if (!this.adminId) return;
        this.io.to(this.adminId).emit("night_action_status", this.nightActionStatus);
    }

    // ================= RESET =================
    resetGame() {
        this.gameOver    = false;
        this.round       = 1;
        this.phase       = this.PHASES.LOBBY;
        this.votes       = {};
        this.chatEnabled = true;
        this.lastDoctorTarget = null; // ─── reset doctor memory ───

        this.players.forEach(p => { p.alive = true; p.role = null; });

        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };

        this.nightActionStatus = {
            mafia:     { done: false, username: null },
            doctor:    { done: false, username: null },
            detective: { done: false, username: null },
        };

        this.nightResults = {
            mafiaTarget: null, doctorSave: null,
            detectiveChecks: [], finalVictim: null, summary: {}
        };

        this.gameStats = {
            nightKills: [], votingEliminations: [], gameLog: [], startTime: Date.now(),
        };

        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
        this.broadcast("back_to_lobby", {});
    }

    // ================= START GAME =================
    startGame() {
        this.gameOver = false;
        this.round    = 1;
        this.assignRoles();

        this.players.forEach(player => {
            this.io.to(player.id).emit("game_started", {
                roomId: this.roomId,
                role:   player.role
            });
        });

        if (this.adminId) {
            this.io.to(this.adminId).emit("game_started", {
                roomId: this.roomId,
                role:   "ADMIN"
            });
        }

        this.broadcast("room_state", {
            players: this.players,
            phase:   this.PHASES.LOBBY,
            round:   this.round
        });

        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }

        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        }, 2000);
    }

    // ================= ROLES =================
    assignRoles() {
        const count = this.players.length;
        for (let i = count - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        }
        this.players.forEach(p => { p.role = "CITIZEN"; p.alive = true; });

        let mafiaCount = 1;
        if (count >= 7 && count <= 9) mafiaCount = 2;
        else if (count >= 10)         mafiaCount = 3;

        let idx = 0;
        for (let m = 0; m < mafiaCount; m++) this.players[idx++].role = "MAFIA";
        this.players[idx++].role = "DOCTOR";
        if (count >= 5) this.players[idx++].role = "DETECTIVE";

        console.log("Roles assigned:");
        this.players.forEach(p => console.log(`  ${p.username} -> ${p.role}`));
    }

    // ================= NIGHT =================
    startNight() {
        if (this.gameOver) return;
        this.phase = this.PHASES.NIGHT;
        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };

        this.nightActionStatus = {
            mafia:     { done: false, username: null },
            doctor:    { done: false, username: null },
            detective: { done: false, username: null },
        };

        this.chatEnabled = true;
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
    }

    registerMafiaKill(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "MAFIA" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        if (this.nightActions.mafiaTarget) return;

        this.nightActions.mafiaTarget = targetId;
        console.log(`  Mafia targeted: ${targetId} (by ${player.username})`);

        this.nightActionStatus.mafia = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    registerDoctorSave(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DOCTOR" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        // ─── Doctor restriction 1: ما يحمي نفسه ───
        if (playerId === targetId) {
            this.io.to(playerId).emit("doctor_error", {
                message: "لا يمكنك حماية نفسك ❌"
            });
            return;
        }

        // ─── Doctor restriction 2: ما يحمي نفس الشخص مرتين متتاليتين ───
        if (this.lastDoctorTarget === targetId) {
            this.io.to(playerId).emit("doctor_error", {
                message: "لا يمكنك حماية نفس الشخص مرتين متتاليتين ❌"
            });
            return;
        }

        this.nightActions.doctorSave = targetId;
        this.lastDoctorTarget        = targetId; // احفظ آخر إنقاذ
        console.log(`  Doctor saved: ${targetId}`);

        this.nightActionStatus.doctor = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    registerDetectiveCheck(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DETECTIVE" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        const target = this.players.find(p => p.id === targetId);
        if (!target) return;

        const result = target.role === "MAFIA" ? "MAFIA" : "NOT MAFIA";

        this.nightActions.detectiveChecks.push({
            detectiveId: playerId, targetId,
            targetUsername: target.username, result
        });

        this.io.to(playerId).emit("detective_result", {
            username: target.username,
            role:     result
        });

        console.log(`  Detective checked ${target.username} -> ${result}`);

        this.nightActionStatus.detective = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    endNight() {
        if (this.gameOver) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        const { mafiaTarget, doctorSave, detectiveChecks } = this.nightActions;
        const finalVictim = (mafiaTarget && mafiaTarget !== doctorSave) ? mafiaTarget : null;

        this.nightResults = {
            mafiaTarget, doctorSave,
            detectiveChecks: detectiveChecks || [],
            finalVictim, timestamp: Date.now()
        };

        this.phase = this.PHASES.NIGHT_REVIEW;
        this.chatEnabled = true;

        if (this.adminId) {
            this.io.to(this.adminId).emit("night_review", this.nightResults);
        }

        this.broadcast("phase_changed", {
            phase:   this.phase,
            round:   this.round,
            message: "The night has ended. Waiting for the story..."
        });
    }

    executeNightResults() {
        const { finalVictim, mafiaTarget, doctorSave } = this.nightResults;

        if (mafiaTarget) {
            const target = this.players.find(p => p.id === mafiaTarget);
            const saved  = mafiaTarget === doctorSave;
            this.gameStats.nightKills.push({
                round:    this.round,
                username: target?.username || "Unknown",
                saved
            });
            this.gameStats.gameLog.push({
                round: this.round,
                type:  saved ? "save" : "kill",
                icon:  saved ? "✚" : "🔪",
                text:  saved
                    ? `${target?.username} was targeted but saved by the Doctor`
                    : `${target?.username} was killed in the night`
            });
        } else {
            this.gameStats.gameLog.push({
                round: this.round, type: "quiet", icon: "🌙",
                text:  "The night passed in silence"
            });
        }

        if (finalVictim) {
            const victim = this.players.find(p => p.id === finalVictim);
            if (victim && victim.alive) {
                victim.alive = false;
                this.broadcast("player_killed", { id: victim.id, username: victim.username });
            }
        }

        this.nightResults = {
            mafiaTarget: null, doctorSave: null,
            detectiveChecks: [], finalVictim: null, summary: {}
        };
    }

    // ================= DAY =================
    startDay() {
        if (this.gameOver) return;
        this.phase = this.PHASES.DAY;
        this.round++;
        this.chatEnabled = true;
        this.broadcast("phase_changed", { phase: this.phase, round: this.round });
    }

    // ================= VOTING =================
    startVoting() {
        if (this.gameOver) return;
        this.phase = this.PHASES.VOTING;
        this.votes = {};
        this.chatEnabled = true;
        this.broadcast("voting_started", {});
    }

    registerVote(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || !player.alive) return;
        if (this.phase !== this.PHASES.VOTING) return;
        if (this.votes[playerId]) return;

        this.votes[playerId] = targetId;

        const alivePlayers = this.players.filter(p => p.alive).length;
        const totalVotes   = Object.keys(this.votes).length;
        const remaining    = alivePlayers - totalVotes;

        const count = {};
        Object.values(this.votes).forEach(target => {
            count[target] = (count[target] || 0) + 1;
        });

        this.broadcast("vote_update", { votes: count, remaining });
    }

    endVoting() {
        if (this.gameOver) return;

        const count = {};
        Object.values(this.votes).forEach(target => {
            count[target] = (count[target] || 0) + 1;
        });

        let maxVotes   = 0;
        let topPlayers = [];

        for (const id in count) {
            if (count[id] > maxVotes) {
                maxVotes   = count[id];
                topPlayers = [id];
            } else if (count[id] === maxVotes) {
                topPlayers.push(id);
            }
        }

        if (topPlayers.length === 1) {
            const victim = this.players.find(p => p.id === topPlayers[0]);
            if (victim) {
                victim.alive = false;
                this.gameStats.votingEliminations.push({
                    round:    this.round,
                    username: victim.username,
                    role:     victim.role
                });
                this.gameStats.gameLog.push({
                    round: this.round, type: "vote", icon: "🗳",
                    text:  `${victim.username} was eliminated by vote (${victim.role})`
                });
            }
            this.broadcast("voting_result", { eliminated: victim?.username, role: victim?.role, tie: false });
        } else {
            this.broadcast("voting_result", { eliminated: null, tie: true });
        }

        if (this.checkWinCondition()) return;

        setTimeout(() => {
            if (this.gameOver) return;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        }, 4000);
    }

    // ================= WIN CHECK =================
    checkWinCondition() {
        const mafiaAlive    = this.players.filter(p => p.role === "MAFIA" && p.alive).length;
        const citizensAlive = this.players.filter(p => p.role !== "MAFIA" && p.alive).length;

        if (mafiaAlive === 0)            { this.endGame("CITIZENS"); return true; }
        if (mafiaAlive >= citizensAlive) { this.endGame("MAFIA");    return true; }
        return false;
    }

    endGame(winner) {
        this.gameOver = true;
        this.phase    = this.PHASES.GAME_OVER;
        this.chatEnabled = true;

        const duration = Math.floor((Date.now() - this.gameStats.startTime) / 1000);

        const roles = this.players.map(p => ({ username: p.username, role: p.role, alive: p.alive }));
        this.broadcast("game_over", {
            winner,
            roles,
            stats: {
                nightKills:         this.gameStats.nightKills,
                votingEliminations: this.gameStats.votingEliminations,
                gameLog:            this.gameStats.gameLog,
                duration,
            }
        });
    }
}

module.exports = GameEngine;