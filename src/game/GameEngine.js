class GameEngine {

    constructor(players, io, roomId, adminId = null) {
        this.players   = players;
        this.io        = io;
        this.roomId    = roomId;
        this.adminId   = adminId;
        this.spectators = []; // قائمة socket IDs للمشاهدين

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
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: []
        };

        this.nightResults = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: [],
            finalVictim:    null,
            summary:        {}
        };

        // ✅ FIX: الشات مفتوح دائماً للكل
        this.chatEnabled = true;

        // تتبع الـ timers المعلقة عشان نلغيها عند reset
        this._pendingTimer = null;

        // ─── سجل الأحداث للـ Stats/Timeline ───
        this.gameLog = [];          // كل حدث مهم: { round, type, text, icon }
        this.nightKills = [];       // { round, killed, killedBy, saved }
        this.votingEliminations = []; // { round, eliminated, tie }
        this.gameStartTime = null;
    }

    // ─── تسجيل مشاهد ───
    addSpectator(socketId) {
        if (!this.spectators.includes(socketId)) {
            this.spectators.push(socketId);
        }
    }

    removeSpectator(socketId) {
        this.spectators = this.spectators.filter(id => id !== socketId);
    }

    // ─── helper: نشر لكل من في الغرفة + الأدمن + المشاهدين ───
    broadcast(event, data) {
        this.io.to(this.roomId).emit(event, data);
    }

    // ================= RESET =================
    resetGame() {
        this.gameOver = false;
        this.round    = 1;
        this.phase    = this.PHASES.LOBBY;
        this.votes    = {};

        this.players.forEach(p => {
            p.alive = true;
            p.role  = null;
        });

        this.nightActions = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: []
        };

        this.nightResults = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: [],
            finalVictim:    null,
            summary:        {}
        };

        // ✅ FIX: الشات يرجع مفتوح بعد الـ reset
        this.chatEnabled = true;

        // إلغاء أي timer معلق عشان ما يبدأ startNight من جولة قديمة
        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }

        this.gameLog = [];
        this.nightKills = [];
        this.votingEliminations = [];
        this.gameStartTime = null;

        this.broadcast("back_to_lobby", {});
    }

    // ================= START GAME =================
    startGame() {
        this.gameOver = false;
        this.round    = 1;
        this.gameLog  = [];
        this.nightKills = [];
        this.votingEliminations = [];
        this.gameStartTime = Date.now();
        this.assignRoles();

        // بعث game_started لكل لاعب بدوره الجديد
        this.players.forEach(player => {
            this.io.to(player.id).emit("game_started", {
                roomId: this.roomId,
                role:   player.role
            });
        });

        // بعث game_started للأدمن إن وجد
        if (this.adminId) {
            this.io.to(this.adminId).emit("game_started", {
                roomId: this.roomId,
                role:   "ADMIN"
            });
        }

        // بعث room_state للكل بالأدوار الجديدة
        this.broadcast("room_state", {
            players: this.players,
            phase:   this.PHASES.LOBBY,
            round:   this.round
        });

        // إلغاء أي timer معلق من جولة سابقة
        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
        // بدء الليل بعد 1.5 ثانية
        // 2 ثانية: وقت كافي لـ GameScene تخلص create() + setupSocketListeners()
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this.startNight();
        }, 2000);
    }

    // ================= ROLES =================
    assignRoles() {
        // خلط عشوائي مباشرة على this.players (Fisher-Yates)
        for (let i = this.players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        }
        // إعادة تعيين الأدوار لكل اللاعبين
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
        this.nightActions = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: []
        };
        // ✅ FIX: الشات يبقى مفتوح بالليل أيضاً
        this.chatEnabled = true;

        this.broadcast("phase_changed", {
            phase: this.phase,
            round: this.round
        });
    }

    registerMafiaKill(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "MAFIA" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        this.nightActions.mafiaTarget = targetId;
        console.log(`  Mafia targeted: ${targetId}`);
    }

    registerDoctorSave(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DOCTOR" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        this.nightActions.doctorSave = targetId;
        console.log(`  Doctor saved: ${targetId}`);
    }

    registerDetectiveCheck(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DETECTIVE" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;

        const target = this.players.find(p => p.id === targetId);
        if (!target) return;

        const result = target.role === "MAFIA" ? "MAFIA" : "NOT MAFIA";

        this.nightActions.detectiveChecks.push({
            detectiveId:    playerId,
            targetId:       targetId,
            targetUsername: target.username,
            result
        });

        // ✅ النتيجة تروح فقط للمحقق
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

        const finalVictim = (mafiaTarget && mafiaTarget !== doctorSave)
            ? mafiaTarget : null;

        this.nightResults = {
            mafiaTarget,
            doctorSave,
            detectiveChecks: detectiveChecks || [],
            finalVictim,
            timestamp: Date.now()
        };

        // ─── سجل في gameLog ───
        const killedPlayer  = finalVictim  ? this.players.find(p => p.id === finalVictim)  : null;
        const savedPlayer   = doctorSave   ? this.players.find(p => p.id === doctorSave)   : null;
        const mafiaPlayer   = mafiaTarget  ? this.players.find(p => p.id === mafiaTarget)  : null;

        if (killedPlayer) {
            this.nightKills.push({ round: this.round, killed: killedPlayer.username, saved: false });
            this.gameLog.push({ round: this.round, type: "kill", icon: "🔪", text: `${killedPlayer.username} was eliminated by the Mafia` });
        } else if (mafiaPlayer && savedPlayer) {
            this.nightKills.push({ round: this.round, killed: mafiaPlayer.username, saved: true, savedBy: savedPlayer.username });
            this.gameLog.push({ round: this.round, type: "save", icon: "💊", text: `${mafiaPlayer.username} was targeted but saved by the Doctor` });
        } else {
            this.gameLog.push({ round: this.round, type: "quiet", icon: "🌙", text: `Night ${this.round}: No one was eliminated` });
        }

        this.phase = this.PHASES.NIGHT_REVIEW;
        // ✅ FIX: الشات يبقى مفتوح بـ NIGHT_REVIEW
        this.chatEnabled = true;

        // نتائج الليل للأدمن
        if (this.adminId) {
            console.log("Sending night review to admin:", this.nightResults);
            this.io.to(this.adminId).emit("night_review", this.nightResults);
        }

        // ✅ FIX: نبعث night_review للمافيا/دكتور/محقق أيضاً عشان يشوفوا overlay
        this.players.forEach(p => {
            if (["MAFIA", "DOCTOR", "DETECTIVE"].includes(p.role) && p.alive) {
                this.io.to(p.id).emit("night_review", this.nightResults);
            }
        });

        this.broadcast("phase_changed", {
            phase:   this.phase,
            round:   this.round,
            message: "The night has ended. Waiting for the story..."
        });
    }

    executeNightResults() {
        const { finalVictim } = this.nightResults;

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

        // تنظيف نتائج الليل
        this.nightResults = {
            mafiaTarget:    null,
            doctorSave:     null,
            detectiveChecks: [],
            finalVictim:    null,
            summary:        {}
        };
    }

    // ================= DAY =================
    startDay() {
        if (this.gameOver) return;
        this.phase = this.PHASES.DAY;
        this.round++;
        // ✅ FIX: الشات دائماً مفتوح
        this.chatEnabled = true;

        this.broadcast("phase_changed", {
            phase: this.phase,
            round: this.round
        });
    }

    // ================= VOTING =================
    startVoting() {
        if (this.gameOver) return;
        this.phase = this.PHASES.VOTING;
        this.votes = {};
        // ✅ FIX: الشات مفتوح بالتصويت
        this.chatEnabled = true;

        this.broadcast("voting_started", {});
    }

    registerVote(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        // ✅ FIX: فقط اللاعبين الأحياء يصوّتون — الأدمن والمشاهد لا
        if (!player || !player.alive) return;
        if (this.phase !== this.PHASES.VOTING) return;
        if (this.votes[playerId]) return; // صوّت مرة واحدة فقط

        this.votes[playerId] = targetId;

        // إحصاء الأصوات
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

            this.broadcast("voting_result", {
                eliminated: victim?.username,
                tie: false
            });
            // سجل في gameLog
            if (victim) {
                this.votingEliminations.push({ round: this.round, eliminated: victim.username, tie: false });
                this.gameLog.push({ round: this.round, type: "vote", icon: "🗳️", text: `${victim.username} was voted out by the citizens` });
            }
        } else {
            this.broadcast("voting_result", {
                eliminated: null,
                tie: true
            });
            // سجل في gameLog
            this.votingEliminations.push({ round: this.round, eliminated: null, tie: true });
            this.gameLog.push({ round: this.round, type: "tie", icon: "⚖️", text: `Round ${this.round}: No one was voted out (tie)` });
        }

        if (this.checkWinCondition()) return;
        this.startNight();
    }

    // ================= WIN CHECK =================
    checkWinCondition() {
        const mafiaAlive    = this.players.filter(p => p.role === "MAFIA"  && p.alive).length;
        const citizensAlive = this.players.filter(p => p.role !== "MAFIA"  && p.alive).length;

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

    // ✅ FIX: endGame يدعم إنهاء قسري من الأدمن
    endGame(winner) {
        this.gameOver = true;
        this.phase    = this.PHASES.GAME_OVER;
        this.chatEnabled = true; // الشات يبقى مفتوح بعد انتهاء اللعبة

        const roles = this.players.map(p => ({
            username: p.username,
            role:     p.role,
            avatar:   p.avatar   || "😎",
            color:    p.color    || "#1e293b",
            alive:    p.alive
        }));

        const durationMs   = this.gameStartTime ? Date.now() - this.gameStartTime : 0;
        const durationMins = Math.floor(durationMs / 60000);
        const durationSecs = Math.floor((durationMs % 60000) / 1000);

        this.broadcast("game_over", {
            winner,
            roles,
            gameLog:            this.gameLog,
            nightKills:         this.nightKills,
            votingEliminations: this.votingEliminations,
            rounds:             this.round,
            duration:           `${durationMins}m ${durationSecs}s`
        });
    }
}

module.exports = GameEngine;