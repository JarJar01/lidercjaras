"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_VERSION = "lidercjaras-jatekmenet-2026-10-22-1";

app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "Lidércjárás", version: APP_VERSION });
});
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "index.html")));
app.get("/lobby", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "lobby.html")));
app.use(express.static(PUBLIC_DIR));

const rooms = new Map();
const ROLE_KEYS = ["spirits", "healer", "villagers", "hunters", "fool"];
const ROLE_LABELS = {
    spirits: "Lidérc",
    healer: "Gyógyító",
    villagers: "Falusi",
    hunters: "Vadász",
    fool: "Bolond"
};
const ROLE_PLURALS = {
    spirits: "Lidércek",
    healer: "Gyógyító",
    villagers: "Falusiak",
    hunters: "Vadászok",
    fool: "Bolondok"
};
const WINNER_LABELS = {
    spirits: "A lidércek győztek",
    villagers: "A falu győzött",
    fool: "A bolond győzött",
    draw: "A játék döntetlennel ért véget"
};
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const NIGHT_PHASES = new Set(["night-spirits", "night-healer", "night-hunters", "night-fool"]);

function cleanText(value, maxLength) {
    return String(value ?? "")
        .replace(/[<>]/g, "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim()
        .slice(0, maxLength);
}
function cleanPlayerName(value) { return cleanText(value, 16); }
function normalizeName(value) { return cleanPlayerName(value).toLocaleLowerCase("hu-HU"); }

function nameIsInActiveRoom(username, exceptSocketId = null) {
    const wanted = normalizeName(username);
    for (const room of rooms.values()) {
        if (room.game?.phase === "game-over") continue;
        for (const player of room.players.values()) {
            if (player.connected !== false && player.id !== exceptSocketId && normalizeName(player.username) === wanted) {
                return true;
            }
        }
    }
    return false;
}

function normalizeRoles(input) {
    if (!input || typeof input !== "object") return null;
    const roles = {};
    for (const key of ROLE_KEYS) {
        const value = Number(input[key]);
        if (!Number.isInteger(value) || value < 0 || value > MAX_PLAYERS) return null;
        roles[key] = value;
    }
    const total = ROLE_KEYS.reduce((sum, key) => sum + roles[key], 0);
    if (total < MIN_PLAYERS || total > MAX_PLAYERS) return null;
    return { roles, total };
}

function shuffle(items) {
    const list = [...items];
    for (let i = list.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function makeRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
        code = "";
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
    } while (rooms.has(code));
    return code;
}

function publicRoom(room) {
    return {
        code: room.code,
        name: room.name,
        hostId: room.hostId,
        roles: { ...room.roles },
        capacity: room.capacity,
        playerCount: [...room.players.values()].filter((p) => p.connected !== false).length,
        started: room.started,
        players: [...room.players.values()].filter((p) => p.connected !== false).map((player) => ({
            id: player.id,
            username: player.username,
            ready: Boolean(player.ready),
            isHost: player.id === room.hostId
        }))
    };
}
function sendRoomState(room) { io.to(room.code).emit("room-updated", publicRoom(room)); }
function sendRoomList(target = io) {
    const list = [...rooms.values()]
        .filter((room) => !room.started)
        .map(publicRoom)
        .sort((a, b) => a.name.localeCompare(b.name, "hu-HU"));
    target.emit("rooms-list", list);
}
function sendRoomError(socket, message) { socket.emit("room-error", message); }
function livingPlayers(room) {
    return [...room.players.values()].filter((player) => player.alive !== false && player.connected !== false);
}
function livingRolePlayers(room, role) { return livingPlayers(room).filter((player) => player.role === role); }

function gamePublicState(room) {
    const game = room.game;
    const living = livingPlayers(room);
    const state = {
        roomName: room.name,
        phase: game.phase,
        endsAt: game.endsAt,
        round: game.round,
        message: game.message || "",
        players: [...room.players.values()].map((player) => ({
            id: player.id,
            username: player.username,
            alive: player.alive !== false,
            connected: player.connected !== false,
            isHost: player.id === room.hostId
        })),
        alivePlayerIds: living.map((player) => player.id),
        lastNightDeaths: (game.lastNightDeaths || []).map((item) => ({ username: item.username })),
        lastVoteResult: game.lastVoteResult || null,
        votesCast: game.phase === "day" ? game.votes.size : 0,
        votesEligible: game.phase === "day" ? living.length : 0,
        winner: game.winner || null,
        winnerLabel: game.winner ? WINNER_LABELS[game.winner] : null
    };
    return state;
}
function emitGameState(room) {
    if (!room || !room.game) return;
    io.to(room.code).emit("game-state", gamePublicState(room));
}
function clearGameTimer(room) {
    if (room?.game?.timer) {
        clearTimeout(room.game.timer);
        room.game.timer = null;
    }
}
function startPhase(room, phase, seconds, message = "") {
    if (!room || !room.game || rooms.get(room.code) !== room || room.game.phase === "game-over") return;
    clearGameTimer(room);
    room.game.phase = phase;
    room.game.endsAt = seconds === null ? null : Date.now() + seconds * 1000;
    room.game.message = message;
    io.to(room.code).emit("game-phase", {
        phase,
        endsAt: room.game.endsAt,
        round: room.game.round,
        message,
        alivePlayerIds: livingPlayers(room).map((player) => player.id)
    });
    emitGameState(room);
    if (seconds !== null) {
        room.game.timer = setTimeout(() => advanceGamePhase(room), seconds * 1000);
    }
}

function getWinner(room) {
    const living = livingPlayers(room);
    if (living.length === 0) return "draw";
    const spirits = living.filter((player) => player.role === "spirits").length;
    const others = living.length - spirits;
    if (spirits === 0) return "villagers";
    if (spirits >= others) return "spirits";
    return null;
}
function endGame(room, winner) {
    if (!room?.game || room.game.phase === "game-over") return;
    clearGameTimer(room);
    room.game.winner = winner;
    room.game.pendingWinner = null;
    room.game.phase = "game-over";
    room.game.endsAt = null;
    room.game.message = WINNER_LABELS[winner] || "A játéknak vége.";
    emitGameState(room);
    io.to(room.code).emit("game-ended", {
        winner,
        winnerLabel: WINNER_LABELS[winner] || "A játéknak vége.",
        message: room.game.message
    });
    console.log(`Véget ért a(z) ${room.name} játék. Győztes: ${winner}`);
}

function startNightRound(room) {
    const winner = getWinner(room);
    if (winner) {
        endGame(room, winner);
        return;
    }
    room.game.round += 1;
    room.game.spiritActions = new Map();
    room.game.healerTargetId = null;
    room.game.hunterActions = new Map();
    room.game.nightAttackTargetId = null;
    room.game.lastNightDeaths = [];
    room.game.pendingWinner = null;
    startPhase(room, "night-spirits", 15, "A falu elcsendesült. A lidércek titokban döntenek.");
}

function resolveSpiritActions(room) {
    const game = room.game;
    const spirits = livingRolePlayers(room, "spirits");
    if (spirits.length === 0) return null;
    const submitted = spirits.map((player) => game.spiritActions.get(player.id)).filter(Boolean);
    if (submitted.length !== spirits.length) return null;

    if (spirits.length === 1) {
        const action = submitted[0];
        return action.type === "attack" ? action.targetId : null;
    }

    // Több lidérc esetén csak az egyhangú, azonos célpontra adott támadás sikerül.
    if (!submitted.every((action) => action.type === "attack" && action.targetId === submitted[0].targetId)) {
        return null;
    }
    return submitted[0].targetId;
}

function resolveNight(room) {
    const game = room.game;
    const deadIds = new Set();
    const spiritTargetId = game.nightAttackTargetId;
    const protectedId = game.healerTargetId;

    if (spiritTargetId && spiritTargetId !== protectedId) {
        const target = room.players.get(spiritTargetId);
        if (target && target.alive !== false && target.connected !== false) deadIds.add(target.id);
    }

    // Minden élő vadász legfeljebb egy lövést adhat le. Ártatlan célpontnál a vadász is meghal.
    for (const hunter of livingRolePlayers(room, "hunters")) {
        if (!game.hunterActions.has(hunter.id)) continue;
        const targetId = game.hunterActions.get(hunter.id);
        if (!targetId) continue; // passzolt
        const target = room.players.get(targetId);
        if (!target || target.alive === false || target.connected === false) continue;
        deadIds.add(target.id);
        if (target.role !== "spirits") deadIds.add(hunter.id);
    }

    const deaths = [];
    for (const playerId of deadIds) {
        const player = room.players.get(playerId);
        if (player && player.alive !== false) {
            player.alive = false;
            deaths.push({ id: player.id, username: player.username });
        }
    }
    game.lastNightDeaths = deaths;
    const winner = getWinner(room);
    game.pendingWinner = winner;
    const message = deaths.length
        ? `Hajnalodik. Az éjszaka áldozatai: ${deaths.map((item) => item.username).join(", ")}.`
        : "Hajnalodik. Senki sem halt meg az éjjel.";
    startPhase(room, "dawn-result", 5, message);
}

function resolveVotes(room) {
    const game = room.game;
    if (!game || game.phase !== "day") return;
    clearGameTimer(room);
    const living = livingPlayers(room);
    const counts = new Map([["skip", 0]]);
    for (const player of living) {
        const vote = game.votes.has(player.id) ? game.votes.get(player.id) : "skip";
        if (vote === "skip") {
            counts.set("skip", (counts.get("skip") || 0) + 1);
            continue;
        }
        const target = room.players.get(vote);
        if (!target || target.alive === false || target.connected === false || target.id === player.id) {
            counts.set("skip", (counts.get("skip") || 0) + 1);
            continue;
        }
        counts.set(vote, (counts.get(vote) || 0) + 1);
    }
    for (const player of living) if (!counts.has(player.id)) counts.set(player.id, 0);
    const highest = Math.max(0, ...counts.values());
    const top = [...counts.entries()].filter(([, count]) => count === highest && count > 0);

    let expelled = null;
    if (top.length === 1 && top[0][0] !== "skip") {
        expelled = room.players.get(top[0][0]) || null;
        if (expelled && expelled.alive !== false) expelled.alive = false;
        else expelled = null;
    }

    const results = [...counts.entries()]
        .filter(([, count]) => count > 0)
        .map(([key, votes]) => ({ name: key === "skip" ? "SKIP" : (room.players.get(key)?.username || "Ismeretlen"), votes }))
        .sort((a, b) => b.votes - a.votes);

    if (expelled) {
        game.lastVoteResult = { expelledName: expelled.username, counts: results };
        game.message = `A falu ${expelled.username} játékost szavazta ki.`;
    } else {
        game.lastVoteResult = { expelledName: null, counts: results };
        game.message = top.length > 1
            ? "Döntetlen született, senki sem esik ki."
            : "A falu a SKIP lehetőséget választotta. Senki sem esik ki.";
    }

    let winner = null;
    if (expelled && expelled.role === "fool") winner = "fool";
    else winner = getWinner(room);
    game.pendingWinner = winner;
    startPhase(room, "vote-result", 5, game.message);
}

function advanceGamePhase(room) {
    if (!room || rooms.get(room.code) !== room || !room.game || room.game.phase === "game-over") return;
    room.game.timer = null;
    switch (room.game.phase) {
        case "countdown":
            startPhase(room, "intro", 30, "Ismerkedjetek, beszélgessetek! Hamarosan leszáll az éjszaka.");
            break;
        case "intro":
            startNightRound(room);
            break;
        case "night-spirits": {
            room.game.nightAttackTargetId = resolveSpiritActions(room);
            if (livingRolePlayers(room, "healer").length > 0) {
                startPhase(room, "night-healer", 10, "A gyógyító kiválaszthat egyetlen játékost, akit megvéd.");
            } else if (livingRolePlayers(room, "hunters").length > 0) {
                startPhase(room, "night-hunters", 10, "A vadászok köre következik.");
            } else if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", 10, "A bolond kivárja az éjszakát.");
            } else {
                resolveNight(room);
            }
            break;
        }
        case "night-healer":
            if (livingRolePlayers(room, "hunters").length > 0) {
                startPhase(room, "night-hunters", 10, "A vadászok köre következik.");
            } else if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", 10, "A bolond kivárja az éjszakát.");
            } else {
                resolveNight(room);
            }
            break;
        case "night-hunters":
            if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", 10, "A bolond kivárja az éjszakát.");
            } else {
                resolveNight(room);
            }
            break;
        case "night-fool":
            resolveNight(room);
            break;
        case "dawn-result":
            if (room.game.pendingWinner) {
                endGame(room, room.game.pendingWinner);
            } else {
                room.game.votes = new Map();
                room.game.lastVoteResult = null;
                startPhase(room, "day", 45, "Nappal van. Beszéljétek meg a történteket, majd szavazzatok vagy válasszátok a SKIP lehetőséget.");
            }
            break;
        case "day":
            resolveVotes(room);
            break;
        case "vote-result":
            if (room.game.pendingWinner) endGame(room, room.game.pendingWinner);
            else startNightRound(room);
            break;
        default:
            break;
    }
}

function sendPrivateRole(socket, room, player) {
    const teamMembers = ["spirits", "hunters"].includes(player.role)
        ? livingRolePlayers(room, player.role).map((member) => ({ id: member.id, username: member.username }))
        : [];
    socket.emit("private-role", {
        role: player.role,
        label: ROLE_LABELS[player.role],
        teamMembers,
        roleDescription: {
            spirits: "Éjszaka titokban válassz célpontot. Több lidérc esetén mindenkinek ugyanazt a célpontot kell választania.",
            healer: "Éjszakánként egyetlen játékost védhetsz meg, akár saját magadat is.",
            villagers: "Nincs éjszakai képességed. Figyelj, beszélgess, és próbáld megtalálni a lidérceket.",
            hunters: "A vadászok körében egyetlen célpontra lőhetsz, vagy passzolhatsz. Ha ártatlant találsz el, te is meghalsz.",
            fool: "Nincs éjszakai képességed. Próbáld elérni, hogy a falu szavazzon ki téged. Akkor te nyersz."
        }[player.role]
    });
}

function joinSocketToRoom(socket, room, username) {
    socket.data.roomId = room.code;
    socket.data.username = username;
    room.players.set(socket.id, { id: socket.id, username, ready: false, connected: true, alive: true });
    socket.join(room.code);
    socket.emit("room-joined", publicRoom(room));
    sendRoomState(room);
    sendRoomList();
}

function leaveRoom(socket, notifyClient = false) {
    const roomCode = socket.data.roomId;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    socket.leave(roomCode);
    socket.data.roomId = null;
    socket.data.username = null;

    if (room) {
        const player = room.players.get(socket.id);
        if (room.started && room.game && room.game.phase !== "game-over" && player) {
            player.connected = false;
            player.alive = false;
            const winner = getWinner(room);
            if (winner) endGame(room, winner);
            else emitGameState(room);
            const stillConnected = [...room.players.values()].some((p) => p.connected !== false);
            if (!stillConnected) {
                clearGameTimer(room);
                rooms.delete(roomCode);
            }
        } else {
            room.players.delete(socket.id);
            if (room.players.size === 0) {
                clearGameTimer(room);
                rooms.delete(roomCode);
            } else if (!room.started && room.hostId === socket.id) {
                room.hostId = room.players.keys().next().value;
                sendRoomState(room);
            } else if (!room.started) {
                sendRoomState(room);
            }
        }
    }
    if (notifyClient) socket.emit("left-room");
    sendRoomList();
}

io.on("connection", (socket) => {
    console.log("Csatlakozott egy böngésző:", socket.id);
    sendRoomList(socket);

    socket.on("check-name", (rawName, callback) => {
        const username = cleanPlayerName(rawName);
        let result;
        if (username.length < 2) result = { ok: false, message: "A név legalább 2 karakter legyen." };
        else if (nameIsInActiveRoom(username)) result = { ok: false, message: "Ezt a nevet már használja egy aktív játékos. Válassz másik nevet." };
        else result = { ok: true };
        if (typeof callback === "function") callback(result);
    });

    socket.on("request-rooms", () => sendRoomList(socket));

    socket.on("create-room", (payload = {}) => {
        if (socket.data.roomId) return sendRoomError(socket, "Már bent vagy egy szobában.");
        const username = cleanPlayerName(payload.username);
        const roomName = cleanText(payload.roomName, 24);
        const roleData = normalizeRoles(payload.roles);
        if (username.length < 2) return sendRoomError(socket, "A játékosneved legalább 2 karakter legyen.");
        if (nameIsInActiveRoom(username)) return sendRoomError(socket, "Ezt a nevet már használja egy aktív játékos. Válassz másik nevet a kezdőoldalon.");
        if (roomName.length < 3) return sendRoomError(socket, "A szoba neve legalább 3 karakter legyen.");
        if (!roleData) return sendRoomError(socket, `A szerepkörök összege ${MIN_PLAYERS} és ${MAX_PLAYERS} játékos között legyen.`);
        const code = makeRoomCode();
        const room = {
            code, name: roomName, hostId: socket.id, roles: roleData.roles, capacity: roleData.total,
            players: new Map(), started: false, createdAt: Date.now(), game: null
        };
        rooms.set(code, room);
        joinSocketToRoom(socket, room, username);
        console.log(`${username} létrehozta a(z) ${roomName} szobát.`);
    });

    socket.on("join-room", (payload = {}) => {
        if (socket.data.roomId) return sendRoomError(socket, "Már bent vagy egy szobában. Előbb lépj ki a jelenlegiből.");
        const code = cleanText(payload.roomId, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
        const username = cleanPlayerName(payload.username);
        const room = rooms.get(code);
        if (username.length < 2) return sendRoomError(socket, "A játékosneved legalább 2 karakter legyen.");
        if (nameIsInActiveRoom(username)) return sendRoomError(socket, "Ezt a nevet már használja egy aktív játékos. Válassz másik nevet a kezdőoldalon.");
        if (!room || room.started) { sendRoomError(socket, "Ez a szoba már nem érhető el."); sendRoomList(socket); return; }
        if (room.players.size >= room.capacity) return sendRoomError(socket, "Ez a szoba megtelt.");
        joinSocketToRoom(socket, room, username);
        console.log(`${username} csatlakozott a(z) ${room.name} szobához.`);
    });

    socket.on("toggle-ready", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.started) return;
        const player = room.players.get(socket.id);
        if (!player) return;
        player.ready = Boolean(payload.ready);
        sendRoomState(room);
    });

    socket.on("kick-player", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.started || room.hostId !== socket.id) return sendRoomError(socket, "Csak a házigazda rúghat ki játékost.");
        const targetId = String(payload.targetId || "");
        if (!targetId || targetId === socket.id || !room.players.has(targetId)) return;
        const targetSocket = io.sockets.sockets.get(targetId);
        if (!targetSocket || targetSocket.data.roomId !== room.code) return;
        room.players.delete(targetId);
        targetSocket.leave(room.code);
        targetSocket.data.roomId = null;
        targetSocket.data.username = null;
        targetSocket.emit("kicked-from-room", { roomName: room.name });
        sendRoomState(room);
        sendRoomList();
    });

    socket.on("transfer-host", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.started || room.hostId !== socket.id) return sendRoomError(socket, "Csak a jelenlegi házigazda adhatja át a vezetést.");
        const targetId = String(payload.targetId || "");
        if (!targetId || targetId === socket.id || !room.players.has(targetId)) return;
        room.hostId = targetId;
        sendRoomState(room);
    });

    socket.on("start-game", () => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.started) return;
        if (room.hostId !== socket.id) return sendRoomError(socket, "A játékot csak a házigazda indíthatja el.");
        if (room.players.size !== room.capacity) return sendRoomError(socket, `A játék indításához minden helynek be kell telnie (${room.players.size}/${room.capacity}).`);
        if ([...room.players.values()].some((player) => !player.ready)) return sendRoomError(socket, "A játék csak akkor indulhat, ha minden játékos készen áll.");
        if (room.roles.spirits < 1) return sendRoomError(socket, "Legalább 1 lidércet állíts be, különben nem indulhat el a játék.");

        const roleList = [];
        for (const role of ROLE_KEYS) for (let i = 0; i < room.roles[role]; i++) roleList.push(role);
        if (roleList.length !== room.players.size) return sendRoomError(socket, "A szerepkörök összege nem egyezik a játékosok számával.");
        const shuffledRoles = shuffle(roleList);
        const shuffledPlayers = shuffle([...room.players.values()]);
        shuffledPlayers.forEach((player, index) => {
            player.role = shuffledRoles[index];
            player.alive = true;
            player.connected = true;
        });

        room.started = true;
        room.game = {
            phase: "countdown", endsAt: null, round: 0, timer: null, message: "A sötétség elnyeli a falut...",
            centerCards: Array.from({ length: 3 }, () => ROLE_KEYS[crypto.randomInt(ROLE_KEYS.length)]),
            spiritActions: new Map(), healerTargetId: null, hunterActions: new Map(), nightAttackTargetId: null,
            votes: new Map(), lastNightDeaths: [], lastVoteResult: null, pendingWinner: null, winner: null
        };

        io.to(room.code).emit("game-started", { room: publicRoom(room) });
        for (const player of room.players.values()) {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) sendPrivateRole(playerSocket, room, player);
        }
        startPhase(room, "countdown", 10, "A képernyő elsötétül. A szereped titokban kiosztásra került.");
        sendRoomState(room);
        sendRoomList();
        console.log(`Elindult a(z) ${room.name} játék.`);
    });

    // Lidérc-akció: több lidérc csak egyező célponttal tud támadni; egy lidérc nézhet középső kártyát.
    socket.on("spirit-action", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-spirits" || !player || player.role !== "spirits" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a lidérc képességét."); return;
        }
        if (room.game.spiritActions.has(socket.id)) { socket.emit("game-action-error", "Ebben a körben már választottál."); return; }
        const spirits = livingRolePlayers(room, "spirits");
        const type = String(payload.type || "");
        if (spirits.length === 1 && type === "peek") {
            const index = Number(payload.cardIndex);
            if (!Number.isInteger(index) || index < 0 || index > 2) { socket.emit("game-action-error", "Válassz egy középső kártyát."); return; }
            room.game.spiritActions.set(socket.id, { type: "peek", cardIndex: index });
            const role = room.game.centerCards[index];
            socket.emit("center-card-revealed", { cardIndex: index, role, label: ROLE_LABELS[role] });
            socket.emit("game-action-ack", { message: `A középső kártya szerepe: ${ROLE_LABELS[role]}.` });
            return;
        }
        if (type !== "attack") { socket.emit("game-action-error", spirits.length > 1 ? "Több lidérc esetén közösen kell célpontot választanotok." : "Válassz támadást vagy középső kártyát."); return; }
        const targetId = String(payload.targetId || "");
        const target = room.players.get(targetId);
        if (!target || target.alive === false || target.connected === false || target.role === "spirits") {
            socket.emit("game-action-error", "Válassz egy élő, nem lidérc játékost."); return;
        }
        room.game.spiritActions.set(socket.id, { type: "attack", targetId });
        socket.emit("game-action-ack", { message: spirits.length > 1 ? "Rögzítettük a választásodat. A támadás csak akkor sikerül, ha minden lidérc ugyanazt választja." : "A támadásod rögzítve." });
    });

    socket.on("healer-protect", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-healer" || !player || player.role !== "healer" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a gyógyító képességét."); return;
        }
        if (room.game.healerTargetId !== null) { socket.emit("game-action-error", "A gyógyító már kiválasztotta, kit véd meg erre az éjszakára."); return; }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.alive === false || target.connected === false) { socket.emit("game-action-error", "Válassz egy élő játékost."); return; }
        room.game.healerTargetId = target.id;
        socket.emit("game-action-ack", { message: `Védelem kiválasztva: ${target.username}. Ezen az éjszakán már nem módosítható.` });
    });

    socket.on("hunter-shoot", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-hunters" || !player || player.role !== "hunters" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a vadász képességét."); return;
        }
        if (room.game.hunterActions.has(socket.id)) { socket.emit("game-action-error", "Ebben a körben már lőttél vagy passzoltál."); return; }
        if (payload.pass === true) {
            room.game.hunterActions.set(socket.id, null);
            socket.emit("game-action-ack", { message: "Úgy döntöttél, hogy ebben a körben nem lősz." });
            return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost, vagy passzolj."); return;
        }
        room.game.hunterActions.set(socket.id, target.id);
        socket.emit("game-action-ack", { message: `A lövésed rögzítve: ${target.username}. Ebben a körben már nem módosítható.` });
    });

    // Privát gépes chat a lidérceknek a saját körükben, a vadászoknak pedig a vadász-körben.
    socket.on("team-chat-send", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || !player || player.alive === false || player.connected === false) return;
        const role = player.role;
        const correctPhase = (role === "spirits" && room.game.phase === "night-spirits") || (role === "hunters" && room.game.phase === "night-hunters");
        if (!correctPhase) { socket.emit("game-action-error", "A titkos csapatchat csak a saját éjszakai körödben használható."); return; }
        const text = cleanText(payload.text, 240);
        if (!text) return;
        const now = Date.now();
        if (player.lastTeamMessageAt && now - player.lastTeamMessageAt < 350) return;
        player.lastTeamMessageAt = now;
        const teammates = livingRolePlayers(room, role);
        for (const teammate of teammates) {
            io.to(teammate.id).emit("team-chat-message", {
                team: role,
                fromId: player.id,
                fromName: player.username,
                text,
                at: now
            });
        }
    });

    socket.on("day-vote", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "day" || !player || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem szavazhatsz."); return;
        }
        if (room.game.votes.has(socket.id)) { socket.emit("game-action-error", "Ebben a szavazásban már leadtad a voksodat."); return; }
        const targetId = String(payload.targetId || "skip");
        if (targetId !== "skip") {
            const target = room.players.get(targetId);
            if (!target || target.alive === false || target.connected === false || target.id === socket.id) {
                socket.emit("game-action-error", "Válassz egy másik, élő játékost, vagy a SKIP lehetőséget."); return;
            }
        }
        room.game.votes.set(socket.id, targetId);
        socket.emit("game-action-ack", { message: targetId === "skip" ? "Leadva: SKIP." : "A szavazatod rögzítve." });
        emitGameState(room); // Csak a leadott voksok száma látható, a választás nem.
        if (room.game.votes.size >= livingPlayers(room).length) resolveVotes(room);
    });

    // A voice chat csak azonos szobán belül jelzéseket cserél. A kliens éjszaka automatikusan némít.
    socket.on("voice-signal", (payload = {}) => {
        const roomCode = socket.data.roomId;
        const room = rooms.get(roomCode);
        const targetId = String(payload.to || "");
        const target = io.sockets.sockets.get(targetId);
        if (!roomCode || !target || target.data.roomId !== roomCode || !payload.data) return;
        if (room?.game && NIGHT_PHASES.has(room.game.phase)) return;
        io.to(targetId).emit("voice-signal", { from: socket.id, data: payload.data });
    });

    socket.on("leave-room", () => leaveRoom(socket, true));
    socket.on("disconnect", () => {
        leaveRoom(socket, false);
        console.log("Kilépett egy böngésző:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log("A Lidércjárás szerver elindult!");
    console.log(`Szerververzió: ${APP_VERSION}`);
    console.log(`Játék címe: http://localhost:${PORT}`);
    console.log(`Ellenőrzés: http://localhost:${PORT}/health`);
});
