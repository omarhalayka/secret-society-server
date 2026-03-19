require("dotenv").config();

const express = require("express");
const http    = require("http");
const https   = require("https");
const { Server } = require("socket.io");
const cors    = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: [
            "https://secret-society-client.vercel.app",
            "http://localhost:5173"
        ],
        methods: ["GET", "POST"]
    }
});

const initializeSocket = require("./src/websocket/socketHandler");
initializeSocket(io);

app.get("/", (req, res) => {
    res.send("Secret Society Server Running");
});

app.get("/ping", (req, res) => {
    res.send("pong");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // ─── Keep-alive: نبعث ping كل 14 دقيقة عشان Render ما ينام ───
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        const url = `${RENDER_URL}/ping`;
        const lib = url.startsWith("https") ? https : http;
        lib.get(url, (res) => {
            console.log(`Keep-alive ping: ${res.statusCode}`);
        }).on("error", (err) => {
            console.warn("Keep-alive failed:", err.message);
        });
    }, 14 * 60 * 1000); // كل 14 دقيقة
});