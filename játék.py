const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// A weboldal fájljainak mappája
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
    console.log("Csatlakozott egy játékos:", socket.id);

    // Belépés egy voice chat szobába
    socket.on("join-room", ({ roomId, username } = {}) => {
        if (socket.data.roomId) return;

        const room = String(roomId || "")
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9-]/g, "")
            .slice(0, 20);

        const name = String(username || "Játékos")
            .trim()
            .slice(0, 24) || "Játékos";

        if (!room) {
            socket.emit("room-error", "Adj meg egy szobakódot!");
            return;
        }

        // Megnézzük, kik vannak már a szobában
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const existingPeers = roomSockets
            ? [...roomSockets].map((id) => ({
                id,
                username:
                    io.sockets.sockets.get(id)?.data.username || "Játékos"
            }))
            : [];

        if (existingPeers.length >= 8) {
            socket.emit("room-error", "A szoba megtelt! Maximum 8 játékos lehet.");
            return;
        }

        socket.data.roomId = room;
        socket.data.username = name;
        socket.join(room);

        // Az új játékos megkapja a már bent lévő játékosokat
        socket.emit("room-joined", {
            roomId: room,
            username: name,
            peers: existingPeers
        });

        // A többiek értesülnek az új játékos érkezéséről
        socket.to(room).emit("peer-joined", {
            id: socket.id,
            username: name
        });

        console.log(`${name} belépett ebbe a szobába: ${room}`);
    });

    // WebRTC hangkapcsolat jelzéseinek továbbítása
    socket.on("signal", ({ to, data } = {}) => {
        const room = socket.data.roomId;
        if (!room || !to || !data) return;

        const target = io.sockets.sockets.get(to);

        // Csak ugyanazon szoba játékosai kommunikálhatnak így
        if (!target || target.data.roomId !== room) return;

        io.to(to).emit("signal", {
            from: socket.id,
            data
        });
    });

    // Kilépés a szobából
    socket.on("leave-room", () => {
        leaveRoom(socket);
    });

    socket.on("disconnect", () => {
        leaveRoom(socket);
        console.log("Kilépett egy játékos:", socket.id);
    });
});

function leaveRoom(socket) {
    const room = socket.data.roomId;

    if (!room) return;

    socket.to(room).emit("peer-left", {
        id: socket.id
    });

    socket.leave(room);
    socket.data.roomId = null;
    socket.data.username = null;
}

const PORT = 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`A szerver fut: http://localhost:${PORT}`);
});