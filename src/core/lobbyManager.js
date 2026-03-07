class LobbyManager {
    constructor() {
        this.players = new Map();
    }

    addPlayer(socket) {
        const player = {
            id: socket.id,
            username: `Guest_${socket.id.substring(0, 5)}`,
            connectedAt: Date.now()
        };

        this.players.set(socket.id, player);

        console.log(`Player added: ${player.username}`);
        console.log(`Total players: ${this.players.size}`);

        return player;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);

        if (player) {
            this.players.delete(socketId);
            console.log(`Player removed: ${player.username}`);
            console.log(`Total players: ${this.players.size}`);
        }
    }

    updateUsername(socketId, newUsername) {
        const player = this.players.get(socketId);

        if (player) {
            player.username = newUsername;
            console.log(`Username updated: ${newUsername}`);
            return player;
        }

        return null;
    }

    getPlayer(socketId) {
        return this.players.get(socketId);
    }

    getAllPlayers() {
        return Array.from(this.players.values());
    }

    getPlayerCount() {
        return this.players.size;
    }
}

module.exports = new LobbyManager();