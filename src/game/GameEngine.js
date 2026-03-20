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
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: []
        };

        // تتبع مين خلّص اختياره بالليل — للأدمن فقط
        this.nightActionStatus = {
            mafia:     { done: false, username: null },
            doctor:    { done: false, username: null },
            detective: { done: false, username: null },
        };

        this.nightResults = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: [],
            finalVictim:    null,
            summary:        {}
        };

        // ─── إحصائيات اللعبة للـ Win Screen ───
        this.gameStats = {
            startTime:          Date.now(),
            nightKills:         [], // { round, username, saved }
            votingEliminations: [], // { round, username, tie }
            gameLog:            [], // { round, type, icon, text }
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

    // ─── helper: بعث حالة اختيارات الليل للأدمن فقط ───
    _sendNightStatusToAdmin() {
        if (!this.adminId) return;
        this.io.to(this.adminId).emit("night_action_status", this.nightActionStatus);
    }

    // ================= RESET =================
    resetGame() {
        this.gameOver = false;
        this.round    = 1;
        this.phase    = this.PHASES.LOBBY;
        this.votes    = {};
        this.chatEnabled = true;

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
            startTime:          Date.now(),
            nightKills:         [],
            votingEliminations: [],
            gameLog:            [],
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

        // نبدأ بـ DAY — الأدمن يتحكم بالتبديل
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            this.broadcast("phase_changed", { phase: this.phase, round: this.round });
        }, 2000);
    }

    // ================= ROLES =================
    assignRoles() {
        for (let i = this.players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        }
        this.players.forEach(p => { p.role = "CITIZEN"; p.alive = true; });

        // ─── توزيع الأدوار حسب العدد ───
        const count = this.players.length;
        const mafiaCount = count <= 6 ? 1 : count <= 9 ? 2 : 3;
        // دكتور دايماً 1، محقق دايماً 1 (إلا لو 4 لاعبين بدون محقق)
        const hasDetective = count >= 5;

        let roleIndex = 0;
        // مافيا
        for (let i = 0; i < mafiaCount; i++) {
            this.players[roleIndex++].role = "MAFIA";
        }
        // دكتور
        this.players[roleIndex++].role = "DOCTOR";
        // محقق
        if (hasDetective) {
            this.players[roleIndex++].role = "DETECTIVE";
        }
        // الباقي مواطنين (بالفعل محددين)

        console.log(`Roles assigned (${count} players, ${mafiaCount} mafia):`);
        this.players.forEach(p => console.log(`  ${p.username} -> ${p.role}`));
    }

    // ================= NIGHT =================
    startNight() {
        if (this.gameOver) return;
        this.phase = this.PHASES.NIGHT;
        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };

        // reset حالة الاختيارات
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
        // لو في مافيا ثانية اختارت قبل — نتجاهل
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
        this.nightActions.doctorSave = targetId;
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

        const result = target.role; // نبعث الدور الحقيقي: MAFIA / DOCTOR / CITIZEN / DETECTIVE

        this.nightActions.detectiveChecks.push({
            detectiveId: playerId, targetId,
            targetUsername: target.username, result
        });

        // النتيجة تروح فقط للمحقق
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

        // نتائج الليل للأدمن فقط
        if (this.adminId) {
            console.log("Sending night review to admin:", this.nightResults);
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
            const target   = this.players.find(p => p.id === mafiaTarget);
            const saved    = mafiaTarget === doctorSave;
            // سجّل في الإحصائيات
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
        } else if (!mafiaTarget) {
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

        const count = {};
        Object.values(this.votes).forEach(target => {
            count[target] = (count[target] || 0) + 1;
        });
        this.broadcast("vote_update", count);
    }

    endVoting() {
        if (this.gameOver) return;

        const count = {};
        Object.values(this.votes).forEach(target => {
            count[target] = (count[target] || 0) + 1;
        });

        let maxVotes  = 0;
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
            if (victim) victim.alive = false;
            this.broadcast("voting_result", { eliminated: victim?.username, tie: false });
            // سجّل في الإحصائيات
            this.gameStats.votingEliminations.push({
                round: this.round, username: victim?.username, tie: false
            });
            this.gameStats.gameLog.push({
                round: this.round, type: "vote", icon: "⚖️",
                text:  `${victim?.username} was eliminated by vote`
            });
        } else {
            this.broadcast("voting_result", { eliminated: null, tie: true });
            this.gameStats.votingEliminations.push({
                round: this.round, username: null, tie: true
            });
            this.gameStats.gameLog.push({
                round: this.round, type: "tie", icon: "🤝",
                text:  "Vote ended in a tie — no one eliminated"
            });
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

        const roles    = this.players.map(p => ({ username: p.username, role: p.role, alive: p.alive }));
        const duration = Math.floor((Date.now() - this.gameStats.startTime) / 60000); // بالدقائق

        this.broadcast("game_over", {
            winner,
            roles,
            rounds:             this.round,
            duration:           duration > 0 ? `${duration} min` : "< 1 min",
            nightKills:         this.gameStats.nightKills,
            votingEliminations: this.gameStats.votingEliminations,
            gameLog:            this.gameStats.gameLog,
        });
    }
}

module.exports = GameEngine;