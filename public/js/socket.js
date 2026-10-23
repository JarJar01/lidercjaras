"use strict";

// A lobby és a névellenőrzés közös Socket.IO kapcsolata.
// Fontos: ezt a fájlt a /socket.io/socket.io.js után kell betölteni.
if (typeof window.io !== "function") {
    console.error("A Socket.IO kliens nem töltődött be. Ellenőrizd a /socket.io/socket.io.js útvonalat.");
} else {
    window.lidercSocket = window.io({
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        timeout: 10000
    });

    window.lidercSocket.on("connect", () => {
        console.info("Lidércjárás szerverkapcsolat létrejött:", window.lidercSocket.id);
    });

    window.lidercSocket.on("connect_error", (error) => {
        console.error("Lidércjárás Socket.IO kapcsolódási hiba:", error.message);
    });
}
