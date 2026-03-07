require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

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

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});