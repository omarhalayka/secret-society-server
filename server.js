const { PeerServer } = require("peer");

const port = process.env.PORT || 9000;

const peerServer = PeerServer({
    port,
    path: "/voice",
    allow_discovery: false,
    proxied: true, // مهم عشان Render
});

peerServer.on("connection", (client) => {
    console.log(`✅ Peer connected: ${client.getId()}`);
});

peerServer.on("disconnect", (client) => {
    console.log(`❌ Peer disconnected: ${client.getId()}`);
});

console.log(`🎤 PeerJS Voice Server running on port ${port}`);