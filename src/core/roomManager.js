const { v4: uuidv4 } = require("uuid");
const GameEngine = require("../game/GameEngine");

class RoomManager {
    constructor() {
        this.rooms = new Map();
    }

    createRoom(players, io, adminId = null) {
        const roomId = uuidv4();

        // تحويل اللاعبين إلى شكل داخلي للغرفة
        const roomPlayers = players.map(p => ({
            id: p.id,
            username: p.username,
            role: null, // سيتم تعيينه لاحقاً
            alive: true
        }));

        const room = {
            id: roomId,
            players: roomPlayers,
            engine: null
        };

        // إنشاء المحرك وربطه مع تمرير adminId
        room.engine = new GameEngine(roomPlayers, io, roomId, adminId);

        this.rooms.set(roomId, room);

        console.log(`Room created: ${roomId}`);
        console.log(`Players in room: ${roomPlayers.length}`);

        return room;
    }

    getRoom(roomId) {
        return this.rooms.get(roomId);
    }

    removeRoom(roomId) {
        if (this.rooms.has(roomId)) {
            this.rooms.delete(roomId);
            console.log(`Room removed: ${roomId}`);
        }
    }

    getAllRooms() {
        return Array.from(this.rooms.values());
    }
}

module.exports = new RoomManager();