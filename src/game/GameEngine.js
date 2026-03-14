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

        // ✅ FIX: الشات مفتوح دائماً للكل
        this.chatEnabled = true;

        // تتبع الـ timers المعلقة عشان نلغيها عند reset
        this._pendingTimer = null;
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

        // ✅ FIX: الشات يرجع مفتوح بعد الـ reset
        this.chatEnabled = true;

        // إلغاء أي timer معلق عشان ما يبدأ startNight من جولة قديمة
        if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }

        this.broadcast("back_to_lobby", {});
    }

    // ================= START GAME =================
    startGame() {
        this.gameOver = false;
        this.round    = 1;
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
        // reset حالة الاختيارات
        this.nightActionStatus = {
            mafia:     { done: false, username: null },
            doctor:    { done: false, username: null },
            detective: { done: false, username: null },
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

        // أبلغ الأدمن إن المافيا خلّصت
        this.nightActionStatus.mafia = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    registerDoctorSave(playerId, targetId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.role !== "DOCTOR" || !player.alive) return;
        if (this.phase !== this.PHASES.NIGHT) return;
        this.nightActions.doctorSave = targetId;
        console.log(`  Doctor saved: ${targetId}`);

        // أبلغ الأدمن إن الدكتور خلّص
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

        // أبلغ الأدمن إن المحقق خلّص
        this.nightActionStatus.detective = { done: true, username: player.username };
        this._sendNightStatusToAdmin();
    }

    // ─── helper: بعث حالة اختيارات الليل للأدمن فقط ───
    _sendNightStatusToAdmin() {
        if (!this.adminId) return;
        this.io.to(this.adminId).emit("night_action_status", this.nightActionStatus);
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

        this.phase = this.PHASES.NIGHT_REVIEW;
        this.chatEnabled = true;

        // نتائج الليل للأدمن فقط — المافيا/دكتور/محقق ما يشوفوا النتائج
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
        } else {
            this.broadcast("voting_result", {
                eliminated: null,
                tie: true
            });
        }

        if (this.checkWinCondition()) return;

        // ✅ انتقل لـ DAY — الأدمن يتحكم في البدء بالليل
        // أعطِ اللاعبين وقت كافي يشوفوا نتيجة التصويت (4 ثواني)
        // بعدها انتظر الأدمن يضغط START NIGHT
        setTimeout(() => {
            if (this.gameOver) return;
            this.phase = this.PHASES.DAY;
            this.chatEnabled = true;
            this.broadcast("phase_changed", {
                phase: this.phase,
                round: this.round
            });
        }, 4000);
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
            role:     p.role
        }));

        this.broadcast("game_over", { winner, roles });
    }
}

module.exports = GameEngine;