const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true, credentials: false },
    maxHttpBufferSize: 1e6
});

const PORT = Number(process.env.PORT) || 3002;
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "html", "index.html");
const rooms = new Map();
const QUESTION_BANK = require("./public/game/question-bank.json");
let cameraOrderSequence = 0;

app.disable("x-powered-by");
app.get("/", (req, res) => res.sendFile(INDEX_FILE));
app.get("/health", (req, res) => res.json({ ok: true, project: "Kiiszik", activeRooms: rooms.size }));
app.use(express.static(PUBLIC_DIR));

function cleanText(value, maxLength = 32) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}
function validName(value) {
    const name = cleanText(value, 20);
    return [...name].length >= 2 ? name : "Játékos";
}
function hashPassword(password) {
    return crypto.createHash("sha256").update(String(password)).digest("hex");
}
function makeRoomCode() {
    let code;
    do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); }
    while (rooms.has(code));
    return code;
}
function findRoomForSocket(socket) {
    const code = socket.data.roomCode;
    return code ? rooms.get(code) : null;
}
function cleanAvatar(value) {
    if (typeof value !== "string" || value.length > 100000) return null;
    return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) ? value : null;
}
function roomView(room) {
    return {
        code: room.code,
        name: room.name,
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        waitMinutes: room.waitMinutes,
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
        started: room.started,
        players: room.players.map((player) => ({
            id: player.id,
            name: player.name,
            avatarUrl: player.avatarUrl || null,
            ready: player.ready,
            voice: player.voice,
            camera: Boolean(player.camera),
            cameraOrder: player.cameraOrder || 0,
            hasPenaltyRecording: Boolean(player.penaltyRecording),
            isHost: player.id === room.hostId
        }))
    };
}
function sendRoomState(room) {
    io.to(room.code).emit("room:state", roomView(room));
    io.emit("room:list-updated");
}
function sendRoomList(socket) {
    // Jelszó-védettség szándékosan nincs megadva a keresési eredményben.
    const list = [...rooms.values()]
        .filter((room) => !room.started && room.players.length < room.maxPlayers && Date.now() < room.expiresAt)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((room) => ({
            code: room.code,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: room.maxPlayers,
            waitMinutes: room.waitMinutes,
            hostName: room.players.find((player) => player.id === room.hostId)?.name || "Játékos"
        }));
    socket.emit("room:list-result", list);
}
function emitAction(socket, ok, message) {
    socket.emit("room:action-result", { ok, message });
}
function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
}
function sampleTwo(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, 2);
}
function makeGameBoard() {
    return Array.from({ length: 100 }, () => {
        const roll = Math.random();
        return roll < 0.54 ? "white" : roll < 0.82 ? "yellow" : "red";
    });
}
function gamePlayer(room, playerId) {
    return room.game && room.game.players[playerId] ? room.game.players[playerId] : null;
}
function gameLog(room, message, type = "info") {
    if (!room.game) return;
    room.game.logs.push({ id: crypto.randomBytes(4).toString("hex"), at: Date.now(), message: cleanText(message, 220), type });
    if (room.game.logs.length > 40) room.game.logs.splice(0, room.game.logs.length - 40);
}
function activeGamePlayer(room) {
    return room.game && room.players.find((player) => player.id === room.game.currentPlayerId);
}
function gameStateFor(room, viewerId) {
    const game = room.game;
    if (!game) return null;
    const voters = room.players.filter((player) => player.id !== game.currentPlayerId);
    const voteCounts = {};
    if (game.pending && game.pending.votes) {
        Object.values(game.pending.votes).forEach((optionId) => { voteCounts[optionId] = (voteCounts[optionId] || 0) + 1; });
    }
    const myState = gamePlayer(room, viewerId);
    return {
        roomCode: room.code,
        board: game.board,
        phase: game.phase,
        turnNumber: game.turnNumber,
        turnIndex: game.turnIndex,
        currentPlayerId: game.currentPlayerId,
        turnEndsAt: game.turnEndsAt,
        paused: game.paused,
        pauseVotes: Object.values(game.pauseVotes || {}).filter(Boolean).length,
        resumeVotes: Object.values(game.pauseVotes || {}).filter((value) => !value).length,
        pauseVoteCount: Object.keys(game.pauseVotes || {}).length,
        pauseRequest: game.pauseRequest ? {
            id: game.pauseRequest.id,
            requesterId: game.pauseRequest.requesterId,
            requesterName: game.pauseRequest.requesterName,
            action: game.pauseRequest.action,
            yesVotes: Object.values(game.pauseRequest.votes || {}).filter(Boolean).length,
            noVotes: Object.values(game.pauseRequest.votes || {}).filter((value) => !value).length,
            voteCount: Object.keys(game.pauseRequest.votes || {}).length,
            playerCount: room.players.length,
            myVote: Object.prototype.hasOwnProperty.call(game.pauseRequest.votes || {}, viewerId) ? Boolean(game.pauseRequest.votes[viewerId]) : null
        } : null,
        lastRoll: game.lastRoll,
        pending: game.pending ? {
            id: game.pending.id,
            type: game.pending.type,
            text: game.pending.text,
            options: game.pending.options,
            chosenOptionId: game.pending.chosenOptionId || null,
            targetId: game.pending.targetId || null,
            resolved: Boolean(game.pending.resolved),
            sipCount: game.pending.sipCount || null,
            votes: voteCounts,
            myVote: game.pending.votes ? (game.pending.votes[viewerId] || null) : null,
            voterCount: voters.length,
            submittedVotes: Object.keys(game.pending.votes || {}).length,
            revealText: game.pending.revealText || null
        } : null,
        players: room.players.map((player) => {
            const state = gamePlayer(room, player.id) || {};
            return {
                id: player.id,
                name: player.name,
                nickname: state.nickname || null,
                nicknameTurns: state.nicknameTurns || 0,
                barkTurns: state.barkTurns || 0,
                flamingoTurns: state.flamingoTurns || 0,
                avatarUrl: player.avatarUrl || null,
                voice: Boolean(player.voice),
                camera: Boolean(player.camera),
                cameraOrder: player.cameraOrder || 0,
                position: state.position || 0,
                shield: Boolean(state.shield),
                curseImmune: Boolean(state.curseImmune),
                forceOne: Boolean(state.forceOne),
                bonusRoll: state.bonusRoll || 0,
                skipTurns: state.skipTurns || 0,
                finished: Boolean(state.finished),
                isHost: player.id === room.hostId,
                hasPenaltyRecording: Boolean(player.penaltyRecording)
            };
        }),
        privateHand: myState ? myState.cards : [],
        logs: game.logs.slice(-22),
        chat: game.chat.slice(-35),
        winnerId: game.winnerId || null,
        gameOver: Boolean(game.gameOver),
        myId: viewerId
    };
}
function publishGameState(room) {
    if (!room || !room.game) return;
    for (const player of room.players) {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) playerSocket.emit("game:state", gameStateFor(room, player.id));
    }
}
function clearGameTimeout(game) {
    if (game && game.turnTimeout) {
        clearTimeout(game.turnTimeout);
        game.turnTimeout = null;
    }
}
function armGameTimeout(room) {
    const game = room.game;
    if (!game) return;
    clearGameTimeout(game);
    if (game.paused || game.gameOver || !game.turnEndsAt) return;
    const remaining = Math.max(0, game.turnEndsAt - Date.now());
    game.turnTimeout = setTimeout(() => handleGameTimeout(room), remaining + 20);
    if (game.turnTimeout.unref) game.turnTimeout.unref();
}
function takeRandomCard(state) {
    const pool = [...QUESTION_BANK.curses, ...QUESTION_BANK.shields, ...QUESTION_BANK.boosts];
    const card = randomItem(pool);
    state.cards.push({ ...card, instanceId: crypto.randomBytes(5).toString("hex") });
    return card;
}
function freePositionBehind(room, playerId, fromPosition, spaces) {
    const game = room.game;
    const occupied = new Set(room.players.filter((player) => player.id !== playerId).map((player) => gamePlayer(room, player.id)?.position ?? -1));
    let position = Math.max(0, fromPosition - spaces);
    while (position > 0 && occupied.has(position)) position -= 1;
    if (occupied.has(position)) {
        for (let candidate = 0; candidate <= 100; candidate += 1) {
            if (!occupied.has(candidate)) return candidate;
        }
    }
    return position;
}
function moveBackward(room, playerId, spaces, reason = "Átok") {
    const state = gamePlayer(room, playerId);
    const player = room.players.find((item) => item.id === playerId);
    if (!state || !player) return;
    const from = state.position;
    const destination = freePositionBehind(room, playerId, from, spaces);
    state.position = destination;
    gameLog(room, `${player.name} ${from - destination} mezőt visszalépett. (${reason})`, "curse");
    io.to(room.code).emit("game:move-back", { playerId, from, to: destination, spaces: from - destination, reason });
}
function createGamePending(room) {
    const game = room.game;
    const player = activeGamePlayer(room);
    if (!game || !player) return;
    const state = gamePlayer(room, player.id);
    const color = game.board[Math.max(0, Math.min(99, state.position - 1))] || "white";
    game.pending = null;
    if (color === "white") {
        game.phase = "action";
        game.pending = { id: crypto.randomBytes(4).toString("hex"), type: "white", options: sampleTwo(QUESTION_BANK.white).map((text, index) => ({ id: `w${index}`, text })), resolved: false, votes: {} };
        gameLog(room, `${player.name} fehér mezőre lépett: kérdést választ és kijelöl valakit.`, "white");
    } else if (color === "yellow") {
        game.phase = "action";
        game.pending = { id: crypto.randomBytes(4).toString("hex"), type: "yellow", options: sampleTwo(QUESTION_BANK.yellow).map((text, index) => ({ id: `y${index}`, text })), resolved: false, votes: {} };
        gameLog(room, `${player.name} sárga mezőre lépett: a társaság szavaz.`, "yellow");
        if (room.players.filter((other) => other.id !== player.id).length === 0) resolveYellowVote(room, true);
    } else {
        const amount = 1;
        const text = randomItem(QUESTION_BANK.red);
        game.phase = "action";
        game.pending = { id: crypto.randomBytes(4).toString("hex"), type: "red", text, resolved: true, sipCount: amount, votes: {} };
        gameLog(room, `Piros mező! Mindenki választhat: ${amount} korty vagy alkoholmentes alternatíva.`, "red");
    }
    if (Math.random() < 0.27) {
        const card = takeRandomCard(state);
        gameLog(room, `${player.name} talált egy titkos kártyát.`, "card");
        const ownerSocket = io.sockets.sockets.get(player.id);
        if (ownerSocket) ownerSocket.emit("game:private-notice", { message: `Kártyát találtál: ${card.title}. A kártyáid között megtalálod.` });
    }
    game.turnEndsAt = Date.now() + 60_000;
    armGameTimeout(room);
    publishGameState(room);
}
function resolveYellowVote(room, forceTieBreak = false) {
    const game = room.game;
    const pending = game && game.pending;
    if (!pending || pending.type !== "yellow" || pending.resolved) return;
    const voteCounts = new Map(pending.options.map((option) => [option.id, 0]));
    Object.values(pending.votes || {}).forEach((optionId) => {
        if (voteCounts.has(optionId)) voteCounts.set(optionId, voteCounts.get(optionId) + 1);
    });
    const maxVotes = Math.max(0, ...voteCounts.values());
    const candidates = pending.options.filter((option) => (voteCounts.get(option.id) || 0) === maxVotes);
    const winner = candidates.length > 1 ? randomItem(candidates) : candidates[0];
    pending.chosenOptionId = winner.id;
    pending.text = winner.text;
    pending.resolved = true;
    pending.sipCount = 1;
    const active = activeGamePlayer(room);
    if (active) gameLog(room, `A szavazás eredménye: „${winner.text}”. ${active.name} választ ${pending.sipCount} korty és alkoholmentes alternatíva között.`, "yellow");
    publishGameState(room);
}
function resolveNicknameVote(room, forceTieBreak = false) {
    const game = room && room.game;
    const pending = game && game.pending;
    if (!pending || pending.type !== "nickname" || pending.resolved) return;
    const counts = new Map(pending.options.map((option) => [option.id, 0]));
    Object.values(pending.votes || {}).forEach((optionId) => { if (counts.has(optionId)) counts.set(optionId, counts.get(optionId) + 1); });
    const maxVotes = Math.max(0, ...counts.values());
    const candidates = pending.options.filter((option) => (counts.get(option.id) || 0) === maxVotes);
    const winner = candidates.length > 1 ? randomItem(candidates) : candidates[0];
    const targetState = gamePlayer(room, pending.targetId);
    const targetPlayer = room.players.find((player) => player.id === pending.targetId);
    if (targetState && targetPlayer && winner) {
        targetState.nickname = winner.text;
        targetState.nicknameTurns = 3;
        gameLog(room, `A társaság ${targetPlayer.name} becenevének ezt választotta: ${winner.text}. A név 3 saját körig érvényes.`, "curse");
    }
    game.pending = null;
    game.phase = "turn";
    game.turnEndsAt = Date.now() + 60_000;
    armGameTimeout(room);
    publishGameState(room);
}
function resolveWhiteAuto(room) {
    const game = room.game;
    const pending = game && game.pending;
    const active = activeGamePlayer(room);
    if (!pending || pending.type !== "white" || pending.resolved || !active) return;
    const option = randomItem(pending.options);
    const target = randomItem(room.players.filter((player) => player.id !== active.id));
    pending.chosenOptionId = option.id;
    pending.targetId = target ? target.id : active.id;
    pending.text = option.text;
    pending.resolved = true;
    pending.sipCount = 1;
    gameLog(room, `Az idő lejárt: ${target ? target.name : active.name} kapta ezt a kérdést: „${option.text}”. A válasz választható, a büntetés ${pending.sipCount} korty vagy alkoholmentes alternatíva.`, "white");
}
function handleGameTimeout(room) {
    const game = room && room.game;
    if (!game || game.gameOver || game.paused) return;
    game.turnTimeout = null;
    if (game.phase === "moving") return;
    if (game.pending && !game.pending.resolved) {
        if (game.pending.type === "white") resolveWhiteAuto(room);
        else if (game.pending.type === "yellow") resolveYellowVote(room, true);
        else if (game.pending.type === "nickname") { resolveNicknameVote(room, true); return; }
    }
    const active = activeGamePlayer(room);
    if (active) gameLog(room, `${active.name} ideje lejárt, következik a következő játékos.`, "timer");
    advanceGameTurn(room);
}
function beginGameTurn(room) {
    const game = room && room.game;
    if (!game || game.gameOver || room.players.length === 0) return;
    const player = activeGamePlayer(room);
    if (!player) {
        game.order = room.players.map((item) => item.id);
        game.turnIndex = 0;
        game.currentPlayerId = game.order[0];
        return beginGameTurn(room);
    }
    const state = gamePlayer(room, player.id);
    state.curseImmune = false; // a hatos utáni átokvédelem a következő saját kör elejéig tart
    if (state.secretCurses.length) {
        const curse = state.secretCurses.shift();
        if (state.shield) {
            state.shield = false;
            gameLog(room, `${player.name} pajzsa felfogott egy titkos átkot!`, "shield");
            io.to(room.code).emit("game:curse-revealed", { playerId: player.id, text: "A pajzsod felfogott egy átkot!" });
        } else {
            gameLog(room, `${player.name} átok alá került: ${curse.title}.`, "curse");
            io.to(room.code).emit("game:curse-revealed", { playerId: player.id, text: `Titkos átok aktiválódott: ${curse.title}. ${curse.description}` });
            if (curse.id === "nickname") {
                game.phase = "action";
                game.pending = {
                    id: crypto.randomBytes(4).toString("hex"), type: "nickname", targetId: player.id,
                    text: `${player.name} becenevéről dönt a társaság.`,
                    options: [{ id: "dog-name", text: "Kutyakapitány" }, { id: "sparrow-name", text: "Verébvezér" }],
                    resolved: false, votes: {}
                };
                game.turnEndsAt = Date.now() + 30_000;
                armGameTimeout(room);
                publishGameState(room);
                return;
            }
            if (curse.id === "freeze") state.skipTurns = Math.max(state.skipTurns, 2);
            else if (curse.id === "ones") state.forceOne = true;
            else if (curse.id === "back") state.curseBack = 3;
            else if (curse.id === "bark") state.barkTurns = Math.max(state.barkTurns || 0, 2);
            else if (curse.id === "flamingo") state.flamingoTurns = Math.max(state.flamingoTurns || 0, 1);
        }
    }
    if (state.curseBack > 0) {
        const amount = state.curseBack;
        state.curseBack = 0;
        moveBackward(room, player.id, amount, "Titkos átok");
    }
    if (state.skipTurns > 0) {
        state.skipTurns -= 1;
        game.phase = "action";
        game.pending = { id: crypto.randomBytes(4).toString("hex"), type: "skipped", text: `${player.name}, ezt a kört egy átok miatt ki kell hagynod. Még ${state.skipTurns} kihagyott kör marad.`, resolved: true, votes: {} };
        game.turnEndsAt = Date.now() + 60_000;
        armGameTimeout(room);
        publishGameState(room);
        return;
    }
    game.phase = "turn";
    game.pending = null;
    game.lastRoll = null;
    game.turnEndsAt = Date.now() + 60_000;
    armGameTimeout(room);
    publishGameState(room);
}
function advanceGameTurn(room) {
    const game = room && room.game;
    if (!game || game.gameOver || room.players.length === 0) return;
    clearGameTimeout(game);
    const oldCurrent = game.currentPlayerId;
    const oldState = gamePlayer(room, oldCurrent);
    if (oldState) {
        if (oldState.nicknameTurns > 0) { oldState.nicknameTurns -= 1; if (oldState.nicknameTurns <= 0) { oldState.nicknameTurns = 0; oldState.nickname = null; } }
        if (oldState.barkTurns > 0) oldState.barkTurns -= 1;
        if (oldState.flamingoTurns > 0) oldState.flamingoTurns -= 1;
    }
    game.order = room.players.map((player) => player.id);
    if (!game.order.length) return;
    const oldIndex = game.order.indexOf(oldCurrent);
    game.turnIndex = oldIndex >= 0 ? oldIndex : Math.max(-1, Math.min(game.turnIndex, game.order.length - 1));
    game.turnIndex = (game.turnIndex + 1) % game.order.length;
    game.currentPlayerId = game.order[game.turnIndex];
    game.turnNumber += 1;
    game.pending = null;
    game.lastRoll = null;
    game.phase = "turn";
    game.pauseVotes = {};
    gameLog(room, `Következik: ${room.players.find((player) => player.id === game.currentPlayerId)?.name || "Játékos"}.`, "turn");
    beginGameTurn(room);
}
function startOnlineGame(room) {
    const now = Date.now();
    room.game = {
        board: makeGameBoard(),
        order: room.players.map((player) => player.id),
        players: Object.fromEntries(room.players.map((player) => [player.id, {
            position: 0, cards: [], shield: false, curseImmune: false,
            forceOne: false, bonusRoll: 0, skipTurns: 0, curseBack: 0,
            secretCurses: [], finished: false, nickname: null, nicknameTurns: 0, barkTurns: 0, flamingoTurns: 0
        }])),
        currentPlayerId: room.players[0].id,
        turnIndex: 0,
        turnNumber: 1,
        phase: "turn",
        turnEndsAt: now + 60_000,
        paused: false,
        pausedAt: null,
        pauseVotes: {},
        pauseRequest: null,
        lastRoll: null,
        pending: null,
        logs: [], chat: [],
        winnerId: null,
        gameOver: false,
        turnTimeout: null,
        moveTimeout: null
    };
    gameLog(room, `Elindult a Kiiszik parti ${room.players.length} játékossal. Start: BEJÁRAT, cél: WC.`, "start");
    armGameTimeout(room);
}
function finishGameMove(room, playerId, from, destination, dieValue, spacesMoved) {
    const game = room && room.game;
    if (!game || game.gameOver || game.phase !== "moving" || game.currentPlayerId !== playerId) return;
    const mover = gamePlayer(room, playerId);
    const player = room.players.find((item) => item.id === playerId);
    if (!mover || !player) return;
    mover.position = destination;
    const occupied = destination < 100 ? room.players.find((other) => other.id !== playerId && (gamePlayer(room, other.id)?.position === destination)) : null;
    if (occupied) {
        const targetState = gamePlayer(room, occupied.id);
        const targetFrom = targetState.position;
        const spacesBack = 2 + Math.floor(Math.random() * 3);
        const newPosition = freePositionBehind(room, occupied.id, targetFrom, spacesBack);
        targetState.position = newPosition;
        gameLog(room, `BUMM! ${player.name} nekiment ${occupied.name} játékosnak. ${occupied.name} ${targetFrom - newPosition} mezőt hátracsúszik!`, "collision");
        io.to(room.code).emit("game:collision", { attackerId: player.id, attackerName: player.name, targetId: occupied.id, targetName: occupied.name, from: targetFrom, to: newPosition, spacesBack: targetFrom - newPosition, tile: destination });
        if (occupied.penaltyRecording) {
            io.to(room.code).emit("game:penalty-voice", { playerId: occupied.id, playerName: occupied.name, dataUrl: occupied.penaltyRecording, isTest: false, spacesBack: targetFrom - newPosition, reason: "Kiütés a pályán" });
        }
    }
    gameLog(room, `${player.name} ${dieValue}-t dobott, ${spacesMoved} mezőt lépett (${from} → ${destination}).`, "move");
    if (destination >= 100) {
        mover.finished = true;
        game.winnerId = playerId;
        game.gameOver = true;
        game.phase = "finished";
        game.pending = null;
        game.turnEndsAt = null;
        clearGameTimeout(game);
        gameLog(room, `🏆 ${player.name} elérte a WC-t és megnyerte a partit!`, "winner");
        publishGameState(room);
        return;
    }
    game.phase = "action";
    createGamePending(room);
}
function syncGameAfterLeave(room, removedId) {
    if (!room.game) return;
    const game = room.game;
    if (game.pauseRequest) {
        if (game.pauseRequest.requesterId === removedId) {
            game.pauseRequest = null;
            game.pauseVotes = {};
        } else if (game.pauseRequest.votes) {
            delete game.pauseRequest.votes[removedId];
            game.pauseVotes = game.pauseRequest.votes;
        }
    }
    delete game.players[removedId];
    const wasCurrent = game.currentPlayerId === removedId;
    const oldIndex = game.order.indexOf(removedId);
    game.order = room.players.map((player) => player.id);
    if (!game.order.length) return;
    if (wasCurrent) {
        game.turnIndex = Math.max(-1, oldIndex - 1);
        game.currentPlayerId = game.order[(game.turnIndex + 1) % game.order.length];
        game.turnIndex = game.order.indexOf(game.currentPlayerId);
        game.turnNumber += 1;
        game.pending = null;
        game.lastRoll = null;
        game.phase = "turn";
        gameLog(room, "A soron következő játékos kilépett; a parti folytatódik.", "system");
        beginGameTurn(room);
    } else {
        game.turnIndex = Math.max(0, game.order.indexOf(game.currentPlayerId));
        publishGameState(room);
    }
}

function removePlayer(socket, { reason = "left", notifySocket = true } = {}) {
    const room = findRoomForSocket(socket);
    if (!room) {
        delete socket.data.roomCode;
        return;
    }
    const roomCode = room.code;
    broadcastVoicePeerLeft(roomCode, socket.id);
    const wasHost = room.hostId === socket.id;
    const hadGame = Boolean(room.game);
    room.players = room.players.filter((player) => player.id !== socket.id);
    if (room.players.length === 0) {
        if (room.game) {
            clearGameTimeout(room.game);
            if (room.game.moveTimeout) clearTimeout(room.game.moveTimeout);
        }
        rooms.delete(roomCode);
    } else {
        if (wasHost) {
            room.hostId = room.players[0].id;
            room.players[0].ready = false;
        }
        if (hadGame) syncGameAfterLeave(room, socket.id);
        sendRoomState(room);
    }
    socket.leave(roomCode);
    delete socket.data.roomCode;
    if (notifySocket && reason === "left") socket.emit("room:leave-result", { ok: true });
    io.emit("room:list-updated");
}
function broadcastVoicePeerLeft(roomCode, socketId) {
    io.to(roomCode).emit("voice:peer-left", { id: socketId });
}

io.on("connection", (socket) => {
    console.log(`[Kiiszik] Kapcsolódott: ${socket.id}`);
    socket.emit("kiiszik:server-ready", { connected: true, message: "Kiiszik szerver elérhető." });
    socket.on("kiiszik:ping", () => socket.emit("kiiszik:pong", { ok: true }));

    socket.on("room:list", () => sendRoomList(socket));

    // A kliens külön is kérheti az állapotot, hogy a várószoba megnyitása
    // ne függjön attól, hogy a létrehozási választ követő broadcast megérkezett-e.
    socket.on("room:state-request", () => {
        const room = findRoomForSocket(socket);
        if (room && room.players.some((player) => player.id === socket.id)) {
            socket.emit("room:state", roomView(room));
        }
    });

    socket.on("room:create", (payload = {}) => {
        removePlayer(socket, { notifySocket: false });
        const playerName = validName(payload.playerName);
        const requestedName = cleanText(payload.name, 32);
        const name = requestedName || `${playerName} szobája`;
        const maxPlayers = Math.max(2, Math.min(8, Number.parseInt(payload.maxPlayers, 10) || 4));
        const supportedWaits = [5, 10, 15, 30, 60];
        const requestedWait = Number.parseInt(payload.waitMinutes, 10) || 10;
        const waitMinutes = supportedWaits.includes(requestedWait) ? requestedWait : 10;
        const password = String(payload.password || "").slice(0, 64);
        const now = Date.now();
        const code = makeRoomCode();
        const player = { id: socket.id, name: playerName, avatarUrl: cleanAvatar(payload.avatarUrl), ready: false, voice: false, camera: false, cameraOrder: 0, penaltyRecording: null, lastPenaltyTestAt: 0 };
        const room = {
            code, name, hostId: socket.id, maxPlayers, waitMinutes,
            passwordHash: password ? hashPassword(password) : null,
            createdAt: now, expiresAt: now + waitMinutes * 60_000,
            started: false, players: [player]
        };
        rooms.set(code, room);
        socket.join(code);
        socket.data.roomCode = code;
        // A szoba teljes állapotát az eredményben is elküldjük: a kliensnek
        // így nem kell egy külön broadcastra várnia a várószoba megjelenítéséhez.
        socket.emit("room:create-result", { ok: true, code, room: roomView(room) });
        sendRoomState(room);
    });

    socket.on("room:join", (payload = {}) => {
        const code = cleanText(payload.code, 8).toUpperCase();
        const room = rooms.get(code);
        if (!room || Date.now() >= room.expiresAt) {
            socket.emit("room:join-result", { ok: false, reason: "NOT_FOUND", message: "A szoba már nem érhető el." });
            return;
        }
        if (room.started) {
            socket.emit("room:join-result", { ok: false, reason: "STARTED", message: "Ez a parti már elindult." });
            return;
        }
        if (room.passwordHash) {
            const password = String(payload.password || "").slice(0, 64);
            if (!password) {
                socket.emit("room:join-result", { ok: false, reason: "PASSWORD_REQUIRED", message: "Szobajelszó szükséges." });
                return;
            }
            if (hashPassword(password) !== room.passwordHash) {
                socket.emit("room:join-result", { ok: false, reason: "BAD_PASSWORD", message: "Hibás jelszó." });
                return;
            }
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit("room:join-result", { ok: false, reason: "FULL", message: "A szoba megtelt." });
            return;
        }
        if (socket.data.roomCode === code) {
            socket.emit("room:join-result", { ok: true, code, room: roomView(room) });
            sendRoomState(room);
            return;
        }
        removePlayer(socket, { notifySocket: false });
        room.players.push({ id: socket.id, name: validName(payload.playerName), avatarUrl: cleanAvatar(payload.avatarUrl), ready: false, voice: false, camera: false, cameraOrder: 0, penaltyRecording: null, lastPenaltyTestAt: 0 });
        socket.join(code);
        socket.data.roomCode = code;
        socket.emit("room:join-result", { ok: true, code, room: roomView(room) });
        sendRoomState(room);
    });

    socket.on("room:ready", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room || room.started) return;
        const player = room.players.find((item) => item.id === socket.id);
        if (!player) return;
        player.ready = Boolean(payload.ready);
        sendRoomState(room);
    });

    socket.on("room:kick", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room || room.hostId !== socket.id || room.started) {
            emitAction(socket, false, "Csak a szoba vezetője rúghat ki játékost.");
            return;
        }
        const targetId = String(payload.targetId || "");
        if (targetId === socket.id) return emitAction(socket, false, "Saját magadat nem rúghatod ki.");
        const target = room.players.find((player) => player.id === targetId);
        if (!target) return emitAction(socket, false, "A játékos már nincs a szobában.");
        room.players = room.players.filter((player) => player.id !== targetId);
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit("room:kicked", { message: "A szobavezető eltávolított a szobából." });
            targetSocket.leave(room.code);
            delete targetSocket.data.roomCode;
        }
        broadcastVoicePeerLeft(room.code, targetId);
        sendRoomState(room);
        emitAction(socket, true, `${target.name} kikerült a szobából.`);
    });

    socket.on("room:transfer-leader", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room || room.hostId !== socket.id || room.started) {
            emitAction(socket, false, "Csak a szoba vezetője adhatja át a vezetést.");
            return;
        }
        const targetId = String(payload.targetId || "");
        const target = room.players.find((player) => player.id === targetId);
        if (!target) return emitAction(socket, false, "A kiválasztott játékos már nincs a szobában.");
        room.hostId = targetId;
        room.players.forEach((player) => { player.ready = false; });
        sendRoomState(room);
        emitAction(socket, true, `${target.name} lett az új Alkoholista király. Mindenkinek újra készen kell állnia.`);
    });

    socket.on("room:start", () => {
        const room = findRoomForSocket(socket);
        if (!room) return emitAction(socket, false, "Nem vagy online szobában.");
        if (room.started) return emitAction(socket, false, "A parti már elindult.");
        if (room.hostId !== socket.id) return emitAction(socket, false, "A partit csak az Alkoholista király indíthatja el.");
        if (room.players.length < 2) return emitAction(socket, false, "Legalább két játékos szükséges.");
        if (!room.players.every((player) => player.ready)) return emitAction(socket, false, "Minden játékosnak készen kell állnia.");
        room.started = true;
        startOnlineGame(room);
        sendRoomState(room);
        // A game:state azután megy ki, hogy a kliens a room:started eseménnyel
        // felépítette a játéktábla felületét.
        io.to(room.code).emit("room:started", { code: room.code });
        publishGameState(room);
        io.emit("room:list-updated");
    });

    socket.on("game:request-state", () => {
        const room = findRoomForSocket(socket);
        if (!room || !room.players.some((player) => player.id === socket.id)) {
            socket.emit("game:state-error", { message: "A szerver nem találja az online szobádat. Lépj vissza a lobbyba, és indítsd el újra a partit." });
            return;
        }
        if (!room.started || !room.game) {
            socket.emit("game:state-error", { message: "A szoba még nem rendelkezik aktív játékállapottal. A szobavezető indítsa el a partit újra." });
            return;
        }
        socket.emit("game:state", gameStateFor(room, socket.id));
    });

    socket.on("game:roll", () => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        if (!room || !room.started || !game) return emitAction(socket, false, "A játék még nem indult el.");
        if (game.gameOver) return emitAction(socket, false, "A parti már véget ért.");
        if (game.paused) return emitAction(socket, false, "A parti szünetel.");
        if (game.currentPlayerId !== socket.id) return emitAction(socket, false, "Most nem te következel.");
        if (game.phase !== "turn" || game.pending) return emitAction(socket, false, "Most nem lehet dobni.");
        if (game.turnEndsAt && Date.now() >= game.turnEndsAt) {
            handleGameTimeout(room);
            return;
        }
        clearGameTimeout(game);
        const state = gamePlayer(room, socket.id);
        const dieValue = state.forceOne ? 1 : 1 + Math.floor(Math.random() * 6);
        state.forceOne = false;
        if (dieValue === 6) state.curseImmune = true;
        const bonus = Math.min(2, Math.max(0, state.bonusRoll || 0));
        state.bonusRoll = 0;
        const spacesMoved = Math.max(1, Math.min(8, dieValue + bonus));
        const from = state.position;
        const destination = Math.min(100, from + spacesMoved);
        game.phase = "moving";
        game.turnEndsAt = null;
        game.lastRoll = { playerId: socket.id, value: dieValue, spacesMoved, from, to: destination };
        io.to(room.code).emit("game:move-start", { playerId: socket.id, playerName: room.players.find((p) => p.id === socket.id)?.name || "Játékos", from, to: destination, roll: dieValue, spacesMoved });
        publishGameState(room);
        game.moveTimeout = setTimeout(() => finishGameMove(room, socket.id, from, destination, dieValue, spacesMoved), Math.min(7500, Math.max(2300, spacesMoved * 600 + 1800)));
        if (game.moveTimeout.unref) game.moveTimeout.unref();
    });

    socket.on("game:vote", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const pending = game && game.pending;
        if (!room || !game || game.gameOver || game.paused || !pending || !["yellow", "nickname"].includes(pending.type) || pending.resolved) return;
        if (socket.id === game.currentPlayerId) return socket.emit("game:private-notice", { message: "A sárga mezőn a többi játékos szavaz; most te vagy a célpont." });
        const optionId = String(payload.optionId || "");
        if (!pending.options.some((option) => option.id === optionId)) return;
        pending.votes[socket.id] = optionId;
        const voters = room.players.filter((player) => player.id !== game.currentPlayerId);
        if (voters.length && voters.every((player) => pending.votes[player.id])) {
            if (pending.type === "nickname") resolveNicknameVote(room, false);
            else resolveYellowVote(room, false);
        } else publishGameState(room);
    });

    socket.on("game:white-choose", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const pending = game && game.pending;
        if (!room || !game || game.gameOver || game.paused || game.currentPlayerId !== socket.id || !pending || pending.type !== "white" || pending.resolved) return;
        const option = pending.options.find((item) => item.id === String(payload.optionId || ""));
        const targetId = String(payload.targetId || "");
        const target = room.players.find((player) => player.id === targetId && player.id !== socket.id);
        if (!option || !target) return socket.emit("game:private-notice", { message: "Válassz egy kérdést és egy másik játékost." });
        pending.chosenOptionId = option.id;
        pending.text = option.text;
        pending.targetId = target.id;
        pending.resolved = true;
        pending.sipCount = 1;
        gameLog(room, `${room.players.find((player) => player.id === socket.id)?.name || "Játékos"} ezt választotta: „${option.text}”. Célpont: ${target.name}. Válasz vagy ${pending.sipCount} korty / alkoholmentes alternatíva.`, "white");
        publishGameState(room);
    });

    socket.on("game:complete", () => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        if (!room || !game || game.gameOver || game.paused) return;
        if (game.currentPlayerId !== socket.id) return emitAction(socket, false, "A kört csak az aktuális játékos zárhatja le.");
        if (game.phase === "moving") return;
        if (game.phase !== "action" || !game.pending || !game.pending.resolved) return emitAction(socket, false, "Előbb fejezd be a mező feladatát.");
        advanceGameTurn(room);
    });

    socket.on("game:card-play", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const ownerState = game && gamePlayer(room, socket.id);
        if (!room || !game || game.gameOver || !ownerState) return;
        const cardIndex = ownerState.cards.findIndex((card) => card.instanceId === String(payload.cardId || ""));
        if (cardIndex < 0) return socket.emit("game:private-notice", { message: "Ez a kártya már nincs a kezedben." });
        const card = ownerState.cards[cardIndex];
        if (card.kind === "curse") {
            const targetId = String(payload.targetId || "");
            const target = room.players.find((player) => player.id === targetId && player.id !== socket.id);
            const targetState = target && gamePlayer(room, target.id);
            if (!target || !targetState) return socket.emit("game:private-notice", { message: "Válassz másik célpontot az átokhoz." });
            if (targetState.shield || targetState.curseImmune) {
                return socket.emit("game:private-notice", { message: targetState.shield ? `${target.name} pajzs alatt áll; az átok nem hatott.` : `${target.name} hatos dobás utáni átokvédelem alatt áll.` });
            }
            ownerState.cards.splice(cardIndex, 1);
            targetState.secretCurses.push({ id: card.id, title: card.title, description: card.description, fromPlayerId: socket.id, fromName: room.players.find((player) => player.id === socket.id)?.name || "Játékos" });
            socket.emit("game:private-notice", { message: `Titokban átkot tettél ${target.name} játékosra: ${card.title}. A kártya elhasználódott.` });
            publishGameState(room); // a célpont kliensének állapota nem tartalmazza a titkos átkot
            return;
        }
        ownerState.cards.splice(cardIndex, 1);
        if (card.kind === "shield") {
            ownerState.shield = true;
            gameLog(room, `${room.players.find((player) => player.id === socket.id)?.name || "Játékos"} nyilvános pajzsot aktivált.`, "shield");
        } else if (card.id === "cleanse") {
            if (ownerState.secretCurses.length) {
                ownerState.secretCurses.shift();
                gameLog(room, `${room.players.find((player) => player.id === socket.id)?.name || "Játékos"} eltávolított egy rá váró átkot.`, "boost");
            } else {
                ownerState.cards.splice(cardIndex, 0, card);
                return socket.emit("game:private-notice", { message: "Nincs eltávolítható átok. A kártyát megtartottad." });
            }
        } else {
            ownerState.bonusRoll = Math.min(2, (ownerState.bonusRoll || 0) + (card.id === "lucky" ? 2 : 1));
            gameLog(room, `${room.players.find((player) => player.id === socket.id)?.name || "Játékos"} bónuszt tett félre a következő dobására.`, "boost");
        }
        publishGameState(room);
    });

    socket.on("game:pause-request", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const player = room && room.players.find((item) => item.id === socket.id);
        if (!room || !game || !player || game.gameOver) return;
        if (game.pauseRequest) {
            return socket.emit("game:private-notice", { message: "Már folyamatban van egy szünetről szóló szavazás." });
        }
        const action = game.paused ? "resume" : "pause";
        game.pauseRequest = {
            id: crypto.randomBytes(6).toString("hex"),
            requesterId: socket.id,
            requesterName: player.name,
            action,
            votes: {}
        };
        game.pauseVotes = {};
        gameLog(room, action === "pause"
            ? `${player.name} szünetet kér. A társaság szavaz.`
            : `${player.name} szeretné folytatni a partit. A társaság szavaz.`, "pause");
        publishGameState(room);
    });

    socket.on("game:pause-vote", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const player = room && room.players.find((item) => item.id === socket.id);
        const request = game && game.pauseRequest;
        if (!room || !game || !player || game.gameOver || !request || payload.requestId !== request.id) return;
        if (Object.prototype.hasOwnProperty.call(request.votes, socket.id)) return;
        request.votes[socket.id] = Boolean(payload.yes);
        game.pauseVotes = request.votes;
        const values = Object.values(request.votes);
        const yes = values.filter(Boolean).length;
        const no = values.filter((value) => !value).length;
        const needed = Math.floor(room.players.length / 2) + 1;
        if (yes >= needed) {
            if (request.action === "pause" && !game.paused) {
                game.paused = true;
                game.pausedAt = Date.now();
                clearGameTimeout(game);
                gameLog(room, "A társaság megszavazta a szünetet.", "pause");
            } else if (request.action === "resume" && game.paused) {
                const pausedFor = Math.max(0, Date.now() - (game.pausedAt || Date.now()));
                game.paused = false;
                game.pausedAt = null;
                if (game.turnEndsAt) game.turnEndsAt += pausedFor;
                gameLog(room, "A társaság megszavazta a parti folytatását.", "pause");
                armGameTimeout(room);
            }
            game.pauseRequest = null;
            game.pauseVotes = {};
        } else if (no >= needed || values.length >= room.players.length) {
            const outcome = no >= needed ? "elutasította" : "szavazategyenlőség miatt nem fogadta el";
            gameLog(room, `A társaság ${outcome} a(z) ${request.action === "pause" ? "szünetkérést" : "folytatási kérést"}.`, "pause");
            game.pauseRequest = null;
            game.pauseVotes = {};
        }
        publishGameState(room);
    });

    socket.on("game:chat", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const game = room && room.game;
        const player = room && room.players.find((item) => item.id === socket.id);
        if (!room || !game || !player || game.gameOver) return;
        const message = cleanText(payload.message, 180);
        if (!message) return;
        game.chat.push({ id: crypto.randomBytes(4).toString("hex"), playerId: player.id, name: player.name, message, at: Date.now() });
        if (game.chat.length > 40) game.chat.splice(0, game.chat.length - 40);
        publishGameState(room);
    });

    socket.on("room:leave", () => removePlayer(socket, { reason: "left", notifySocket: true }));

    // Rövid, játékos által készített büntetőhang. Csak az adott online szobában
    // tároljuk, a szoba megszűnésekor vagy a játékos kilépésekor eltűnik.
    socket.on("penalty:recording-save", (payload = {}) => {
        const room = findRoomForSocket(socket);
        const player = room && room.players.find((item) => item.id === socket.id);
        if (!room || !player) {
            socket.emit("penalty:recording-saved", { ok: false, message: "Előbb lépj be egy online szobába." });
            return;
        }
        if (room.started && player.penaltyRecording) {
            socket.emit("penalty:recording-saved", { ok: false, message: "A már feltöltött büntetőhangot játék közben nem lehet felülírni." });
            return;
        }
        const dataUrl = typeof payload.dataUrl === "string" ? payload.dataUrl : "";
        const header = dataUrl.slice(0, dataUrl.indexOf(","));
        const validAudioHeader = /^data:audio\/(?:webm|ogg|mp4|mpeg|wav|x-wav)(?:;[^,]*)?;base64$/i.test(header);
        if (!dataUrl || dataUrl.length > 240000 || !validAudioHeader || dataUrl.indexOf(",") < 0) {
            socket.emit("penalty:recording-saved", { ok: false, message: "A felvétel túl nagy vagy nem támogatott hangformátumú. Készíts legfeljebb 5 másodperces felvételt." });
            return;
        }
        player.penaltyRecording = dataUrl;
        socket.emit("penalty:recording-saved", { ok: true });
        sendRoomState(room);
    });

    socket.on("penalty:recording-clear", () => {
        const room = findRoomForSocket(socket);
        const player = room && room.players.find((item) => item.id === socket.id);
        if (!room || !player) {
            socket.emit("penalty:recording-cleared", { ok: false, message: "Nem vagy online szobában." });
            return;
        }
        if (room.started) {
            socket.emit("penalty:recording-cleared", { ok: false, message: "A játék már elindult; a felvételt nem lehet törölni." });
            return;
        }
        player.penaltyRecording = null;
        socket.emit("penalty:recording-cleared", { ok: true });
        sendRoomState(room);
    });

    socket.on("penalty:recording-test", () => {
        const room = findRoomForSocket(socket);
        const player = room && room.players.find((item) => item.id === socket.id);
        if (!room || !player || !player.penaltyRecording) {
            socket.emit("room:action-result", { ok: false, message: "Előbb készíts és ments el egy büntető hangfelvételt." });
            return;
        }
        if (room.started) {
            socket.emit("room:action-result", { ok: false, message: "A próba-lejátszás csak a lobbyban érhető el." });
            return;
        }
        const now = Date.now();
        if (now - (player.lastPenaltyTestAt || 0) < 2500) {
            socket.emit("room:action-result", { ok: false, message: "Várj egy kicsit a következő próba előtt." });
            return;
        }
        player.lastPenaltyTestAt = now;
        io.to(room.code).emit("game:penalty-voice", {
            playerId: player.id,
            playerName: player.name,
            dataUrl: player.penaltyRecording,
            isTest: true,
            spacesBack: 3,
            reason: "Próba-lejátszás"
        });
    });

    // A játéktábla büntetés eseménye: játékindítás után csak az Alkoholista
    // király küldhet érvényes céljátékost és hátralépési mezőszámot.
    socket.on("game:penalty-trigger", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room || !room.started || room.hostId !== socket.id) {
            emitAction(socket, false, "A büntetőhangot játék közben csak az Alkoholista király aktiválhatja.");
            return;
        }
        const targetId = String(payload.targetId || "");
        const target = room.players.find((player) => player.id === targetId);
        if (!target) return emitAction(socket, false, "A kiválasztott játékos már nincs a szobában.");
        if (!target.penaltyRecording) return emitAction(socket, false, `${target.name} játékosnak nincs elmentett büntető hangfelvétele.`);
        const requestedSpaces = Number.parseInt(payload.spacesBack, 10) || 3;
        const spacesBack = Math.max(1, Math.min(10, requestedSpaces));
        const reason = cleanText(payload.reason || "Kiütötték", 60) || "Kiütötték";
        io.to(room.code).emit("game:penalty-voice", {
            playerId: target.id,
            playerName: target.name,
            dataUrl: target.penaltyRecording,
            isTest: false,
            spacesBack,
            reason
        });
    });

    // Opcionális WebRTC hang- és videójelzés; a hang/kép nem kerül a Node szerverre.
    socket.on("voice:toggle", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room) {
            socket.emit("voice:status", { ok: false, message: "Hang és webkamera csak online szobában használható." });
            return;
        }
        const player = room.players.find((item) => item.id === socket.id);
        if (!player) return;
        const wasActive = Boolean(player.voice || player.camera);
        const wasCamera = Boolean(player.camera);
        player.voice = Boolean(payload.enabled);
        player.camera = Boolean(payload.cameraEnabled);
        // A kamera a bekapcsolás időpontja szerint kerül sorba. Kikapcsoláskor
        // elveszíti a helyét; újra bekapcsolva a sor végére kerül.
        if (player.camera && !wasCamera) player.cameraOrder = ++cameraOrderSequence;
        if (!player.camera) player.cameraOrder = 0;
        const mediaActive = Boolean(player.voice || player.camera);
        if (mediaActive) {
            socket.emit("voice:peers", room.players.filter((item) => item.id !== socket.id && (item.voice || item.camera)).map((item) => ({ id: item.id, name: item.name })));
            socket.to(room.code).emit("voice:peer-available", { id: socket.id, name: player.name });
            socket.emit("voice:status", { ok: true, message: `Bekapcsolva: ${[player.voice ? "mikrofon" : "", player.camera ? "webkamera" : ""].filter(Boolean).join(" és ")}.` });
        } else {
            if (wasActive) broadcastVoicePeerLeft(room.code, socket.id);
            socket.emit("voice:status", { ok: true, message: "A mikrofon és a webkamera ki van kapcsolva." });
        }
        sendRoomState(room);
        if (room.game) publishGameState(room);
    });

    socket.on("voice:signal", (payload = {}) => {
        const room = findRoomForSocket(socket);
        if (!room || !payload.targetId || !payload.signal) return;
        const sender = room.players.find((player) => player.id === socket.id);
        const receiver = room.players.find((player) => player.id === String(payload.targetId));
        if (!sender || !receiver || !(sender.voice || sender.camera) || !(receiver.voice || receiver.camera)) return;
        const targetSocket = io.sockets.sockets.get(receiver.id);
        if (targetSocket && targetSocket.data.roomCode === room.code) {
            targetSocket.emit("voice:signal", { from: socket.id, signal: payload.signal });
        }
    });

    socket.on("disconnect", (reason) => {
        removePlayer(socket, { reason: "disconnect", notifySocket: false });
        console.log(`[Kiiszik] Kapcsolat bontva: ${socket.id} (${reason})`);
    });
});

// A várakozási idő lejárta előtt nem törlünk elindított partit.
setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (!room.started && now >= room.expiresAt) {
            io.to(room.code).emit("room:expired", { message: "A szoba várakozási ideje lejárt." });
            for (const player of room.players) {
                const playerSocket = io.sockets.sockets.get(player.id);
                if (playerSocket) {
                    playerSocket.leave(room.code);
                    delete playerSocket.data.roomCode;
                }
            }
            rooms.delete(room.code);
            io.emit("room:list-updated");
        }
    }
}, 5000);

server.listen(PORT, () => {
    console.log("\n====================================");
    console.log("        KIISZIK SZERVER FUT");
    console.log(`        http://localhost:${PORT}`);
    console.log("        Online lobby + hang/video signalling");
    console.log("====================================\n");
});
server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(`A ${PORT}-es port már foglalt. Indítsd más porton: set PORT=3003 && npm start`);
    } else console.error("Szerverhiba:", error);
    process.exitCode = 1;
});
