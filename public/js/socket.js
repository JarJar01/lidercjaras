(() => {
    "use strict";
    if (typeof window.io !== "function") {
        console.warn("[Kiiszik] Socket.IO nem érhető el; az online lobby nem használható, a helyi mód igen.");
        return;
    }
    const socket = window.io();
    window.kiiszikSocket = socket;
    socket.on("connect", () => {
        console.info("[Kiiszik] Kapcsolódva a szerverhez.");
        socket.emit("kiiszik:ping");
    });
    socket.on("kiiszik:server-ready", (data) => console.info(data?.message || "Kiiszik szerver elérhető."));
    socket.on("kiiszik:pong", () => console.info("[Kiiszik] Kapcsolat teszt sikeres."));
    socket.on("connect_error", (error) => console.warn("[Kiiszik] Socket kapcsolat hiba:", error.message));
})();
