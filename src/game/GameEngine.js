class GameEngine {

    constructor(players, io, roomId, adminId = null) {
        this.players    = players;
        this.io         = io;
        this.roomId     = roomId;
        this.adminId    = adminId;
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

        this.votes = {};
        this.nightActions = {
            mafiaTarget:     null,
            doctorSave:      null,
            detectiveChecks: []
        };

        this.nightResults = {
            mafiaTarget:     null,
            doctorSave:      null,
            detectiveChecks: [],
            finalVictim:     null,
            summary:         {}
        };

        // الشات مفتوح دائماً للكل
        this.chatEnabled = true;

        this._pendingTimer = null;
    }

    // ─── مشاهدين ───
    addSpectator(socketId) {
        if (!this.spectators.includes(socketId)) this.spectators.push(socketId);
    }
    removeSpectator(socketId) {
        this.spectators = this.spectators.filter(id => id !== socketId);
    }

    // ─── broadcast لكل الغرفة ───
    broadcast(event, data) {
        this.io.to(this.roomId).emit(event, data);
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
        this.nightResults = { mafiaTarget: null, doctorSave: null, detectiveChecks: [], finalVictim: null, summary: {} };

        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }

        this.broadcast("back_to_lobby", {});
    }

    // ================= START GAME =================
    startGame() {
        this.gameOver = false;
        this.round    = 1;
        this.assignRoles();

        // game_started لكل لاعب بدوره
        this.players.forEach(player => {
            this.io.to(player.id).emit("game_started", {
                roomId: this.roomId,
                role:   player.role
            });
        });

        // game_started للأدمن
        if (this.adminId) {
            this.io.to(this.adminId).emit("game_started", {
                roomId: this.roomId,
                role:   "ADMIN"
            });
        }

        // room_state للكل — مرة واحدة فقط
        this.broadcast("room_state", {
            players: this.players,
            phase:   this.PHASES.LOBBY,
            round:   this.round
        });

        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }

        // بدء الليل بعد 2.5 ثانية — وقت كافي لـ GameScene تبني نفسها
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.startNight();
        }, 2500);
    }

    // ================= ROLES =================
    assignRoles() {
        for (let i = this.players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        }
        this.players.forEach(p => { p.role = "CITIZEN"; p.alive = true; });
        this.players[0].role = "MAFIA";
        this.players[1].role = "DOCTOR";
        this.players[2].role = "DETECTIVE";

        console.log("Roles assigned:");
        this.players.forEach(p => console.log(`  ${p.username} -> ${p.role}`));
    }

    // ================= NIGHT =================
    startNight() {
        if (this.gameOver) return;
        this.phase = this.PHASES.NIGHT;
        this.chatEnabled = true;
        this.nightActions = { mafiaTarget: null, doctorSave: null, detectiveChecks: [] };

        this.broadcast("phase_changed", {
            phase: this.phase,
            round: this.round
        });
    }

    registerMafiaKill(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "MAFIA" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        const target = this.players.find(p => p.id === targetId);
        if (!target || !target.alive) return;
        this.nightActions.mafiaTarget = targetId;
        console.log(`  Mafia targeted: ${target.username}`);
    }

    registerDoctorSave(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DOCTOR" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        const target = this.players.find(p => p.id === targetId);
        if (!target || !target.alive) return;
        this.nightActions.doctorSave = targetId;
        console.log(`  Doctor saved: ${target.username}`);
    }

    registerDetectiveCheck(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DETECTIVE" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        const target = this.players.find(p => p.id === targetId);
        if (!target || !target.alive) return;

        const result = target.role; // يرجع الدور الحقيقي: MAFIA / DOCTOR / CITIZEN

        this.nightActions.detectiveChecks.push({
            detectiveId:    playerId,
            targetId,
            targetUsername: target.username,
            result
        });

        // نتيجة التحقيق للمحقق فقط
        this.io.to(playerId).emit("detective_result", {
            username: target.username,
            role:     result
        });

        console.log(`  Detective checked ${target.username} -> ${result}`);
    }

    endNight() {
        if (this.gameOver) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        const { mafiaTarget, doctorSave, detectiveChecks } = this.nightActions;
        const finalVictim = (mafiaTarget && mafiaTarget !== doctorSave) ? mafiaTarget : null;

        this.nightResults = {
            mafiaTarget,
            doctorSave,
            detectiveChecks: detectiveChecks || [],
            finalVictim,
            timestamp: Date.now()
        };

        this.phase = this.PHASES.NIGHT_REVIEW;
        this.chatEnabled = true;

        // night_review للأدمن فقط — اللاعبين يشوفون النتائج بعد admin_reveal
        if (this.adminId) {
            console.log("Sending night review to admin:", this.nightResults);
            this.io.to(this.adminId).emit("night_review", this.nightResults);
            // phase_changed = NIGHT_REVIEW للأدمن فقط عشان يشوف الـ drawer
            this.io.to(this.adminId).emit("phase_changed", {
                phase:   this.PHASES.NIGHT_REVIEW,
                round:   this.round,
                message: "Night ended. Write the story and reveal."
            });
        }
        // اللاعبون يبقوا على شاشاتهم بدون تغيير حتى يكشف الأدمن
    }

    // FIX: executeNightResults ترجع النتائج قبل التنظيف
    executeNightResults() {
        // نحفظ النتائج قبل ما نمسحها
        const savedResults = {
            mafiaTarget:     this.nightResults.mafiaTarget,
            doctorSave:      this.nightResults.doctorSave,
            detectiveChecks: this.nightResults.detectiveChecks || [],
            finalVictim:     this.nightResults.finalVictim,
        };

        const { finalVictim } = savedResults;

        if (finalVictim) {
            const victim = this.players.find(p => p.id === finalVictim);
            if (victim && victim.alive) {
                victim.alive = false;
                this.broadcast("player_killed", {
                    id:       victim.id,
                    username: victim.username
                });
            }
        }

        // تنظيف
        this.nightResults = {
            mafiaTarget: null, doctorSave: null,
            detectiveChecks: [], finalVictim: null, summary: {}
        };

        // نرجع النتائج المحفوظة عشان socketHandler يستخدمها في night_results_revealed
        return savedResults;
    }

    // ================= DAY =================
    startDay() {
        if (this.gameOver) return;
        this.phase = this.PHASES.DAY;
        this.round++;
        this.chatEnabled = true;

        this.broadcast("phase_changed", {
            phase: this.phase,
            round: this.round
        });

        // نبعث room_state محدث بعد startDay عشان الكل يشوف الـ alive status الصحيح
        this.broadcast("room_state", {
            players: this.players,
            phase:   this.phase,
            round:   this.round
        });
    }

    // ================= VOTING =================
    startVoting() {
        if (this.gameOver) return;
        this.phase = this.PHASES.VOTING;
        this.votes = {};
        this.chatEnabled = true;

        // نبعث room_state أولاً عشان الكليانت يحدّث اللاعبين قبل الـ overlay
        this.broadcast("room_state", {
            players: this.players,
            phase:   this.phase,
            round:   this.round
        });

        // ثم voting_started بعد تأخير صغير
        setTimeout(() => {
            this.broadcast("voting_started", {});
        }, 150);
    }

    registerVote(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || !player.alive) return;
        if (this.phase !== this.PHASES.VOTING) return;
        if (this.votes[playerId]) return;

        // الهدف لازم يكون حي
        const target = this.players.find(p => p.id === targetId);
        if (!target || !target.alive) return;

        this.votes[playerId] = targetId;

        const count = {};
        Object.values(this.votes).forEach(t => { count[t] = (count[t] || 0) + 1; });
        this.broadcast("vote_update", count);
    }

    endVoting() {
        if (this.gameOver) return;

        const count = {};
        Object.values(this.votes).forEach(t => { count[t] = (count[t] || 0) + 1; });

        let maxVotes  = 0;
        let topPlayers = [];

        for (const id in count) {
            if (count[id] > maxVotes) { maxVotes = count[id]; topPlayers = [id]; }
            else if (count[id] === maxVotes) topPlayers.push(id);
        }

        if (topPlayers.length === 1) {
            const victim = this.players.find(p => p.id === topPlayers[0]);
            if (victim) victim.alive = false;
            this.broadcast("voting_result", { eliminated: victim?.username, tie: false });
        } else {
            this.broadcast("voting_result", { eliminated: null, tie: true });
        }

        if (this.checkWinCondition()) return;
        this.startNight();
    }

    // ================= WIN CHECK =================
    checkWinCondition() {
        const mafiaAlive    = this.players.filter(p => p.role === "MAFIA" && p.alive).length;
        const citizensAlive = this.players.filter(p => p.role !== "MAFIA" && p.alive).length;

        if (mafiaAlive === 0)              { this.endGame("CITIZENS"); return true; }
        if (mafiaAlive >= citizensAlive)   { this.endGame("MAFIA");    return true; }
        return false;
    }

    endGame(winner) {
        this.gameOver = true;
        this.phase    = this.PHASES.GAME_OVER;
        this.chatEnabled = true;

        const roles = this.players.map(p => ({ username: p.username, role: p.role }));
        this.broadcast("game_over", { winner, roles });
    }
}

module.exports = GameEngine;