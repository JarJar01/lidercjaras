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
const APP_VERSION = "lidercjaras-bohoc-egyszeri-szabotazs-hangkevero-2026-10-23-7";

app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "Lidércjárás", version: APP_VERSION });
});
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "index.html")));
app.get("/lobby", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "lobby.html")));
app.use(express.static(PUBLIC_DIR));

const rooms = new Map();
const ROLE_KEYS = ["spirits", "healer", "villagers", "hunters", "fool", "swapper", "infectious"];
const ROLE_LABELS = {
    spirits: "Lidérc",
    healer: "Gyógyító",
    villagers: "Falusi",
    hunters: "Vadász",
    fool: "Bolond",
    swapper: "Bohóc lidérc",
    infectious: "Fertőző"
};
const ROLE_PLURALS = {
    spirits: "Lidércek",
    healer: "Gyógyító",
    villagers: "Falusiak",
    hunters: "Vadászok",
    fool: "Bolondok",
    swapper: "Bohóc lidérc",
    infectious: "Fertőző"
};
const WINNER_LABELS = {
    spirits: "A lidércek győztek",
    villagers: "A falu győzött",
    fool: "A bolond győzött",
    infectious: "A Fertőző győzött: mindenki megfertőződött",
    draw: "A játék döntetlennel ért véget"
};
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const NIGHT_PHASES = new Set(["night-swapper", "night-spirits", "night-healer", "night-hunters", "night-fool", "night-infectious"]);

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

function normalizeRoomSettings(input) {
    const defaults = {
        introSeconds: 30,
        daySeconds: 45,
        spiritsSeconds: 20,
        healerSeconds: 10,
        huntersSeconds: 10,
        foolSeconds: 10,
        swapperSeconds: 10,
        infectiousSeconds: 10
    };
    const source = input && typeof input === "object" ? input : {};
    const settings = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const raw = source[key] === undefined || source[key] === null || source[key] === ""
            ? fallback
            : Number(source[key]);
        if (!Number.isInteger(raw) || raw < 5 || raw > 3600) return null;
        settings[key] = raw;
    }
    return settings;
}

function fitRolesToPlayerCount(currentRoles, count) {
    const roles = { ...currentRoles };
    const sum = () => ROLE_KEYS.reduce((total, key) => total + roles[key], 0);
    roles.spirits = Math.max(1, Number(roles.spirits) || 0);

    while (sum() > count) {
        const reductionOrder = ["villagers", "fool", "swapper", "infectious", "hunters", "healer", "spirits"];
        const key = reductionOrder.find((candidate) => roles[candidate] > (candidate === "spirits" ? 1 : 0));
        if (!key) break;
        roles[key] -= 1;
    }
    if (sum() < count) roles.villagers += count - sum();
    return roles;
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
        settings: { ...(room.settings || normalizeRoomSettings()) },
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

function currentVoteDetails(room) {
    const game = room.game;
    // A többiek csak azt látják, hogy a játékos leadta-e a szavazatát; a célpont titkos.
    return livingPlayers(room).map((voter) => ({
        voterId: voter.id,
        voterName: voter.username,
        submitted: game.votes.has(voter.id)
    }));
}
function displayNameForPlayer(player, viewerId) {
    if (!player) return "Ismeretlen játékos";
    // A saját nevét mindenki eredetinek látja; a névcsere célpontja a bohóc álnévét sem látja.
    if (player.id === viewerId) return player.username;
    if (player.publicAlias && viewerId !== player.publicAliasTargetId) return player.publicAlias;
    return player.username;
}
function gamePublicState(room, viewerId = null) {
    const game = room.game;
    const living = livingPlayers(room);
    const rawVoteResult = game.lastVoteResult;
    const voteResult = rawVoteResult ? {
        expelledName: rawVoteResult.expelledId ? displayNameForPlayer(room.players.get(rawVoteResult.expelledId), viewerId) : null,
        counts: (rawVoteResult.counts || []).map((item) => ({
            name: item.targetId === "skip" ? "SKIP" : displayNameForPlayer(room.players.get(item.targetId), viewerId),
            votes: item.votes
        }))
    } : null;
    return {
        roomName: room.name,
        phase: game.phase,
        endsAt: game.endsAt,
        round: game.round,
        message: game.message || "",
        players: [...room.players.values()].map((player) => ({
            id: player.id,
            username: displayNameForPlayer(player, viewerId),
            alive: player.alive !== false,
            connected: player.connected !== false,
            isHost: player.id === room.hostId,
            // A hangszabotázs állapotát mindenki látja, kivéve az érintett játékost.
            voiceEffect: player.id !== viewerId ? (player.voiceSabotage || null) : null
        })),
        infectedSelf: Boolean(viewerId && game.infectedPlayerIds instanceof Set && game.infectedPlayerIds.has(viewerId)),
        alivePlayerIds: living.map((player) => player.id),
        lastNightDeaths: (game.lastNightDeaths || []).map((item) => ({
            username: displayNameForPlayer(room.players.get(item.id), viewerId)
        })),
        lastNightLog: game.lastNightLog || [],
        lastVoteResult: voteResult,
        votesCast: ["day", "vote-result"].includes(game.phase) ? game.votes.size : 0,
        votesEligible: game.phase === "day" ? living.length : 0,
        voteDetails: game.phase === "day" ? currentVoteDetails(room) : [],
        winner: game.winner || null,
        winnerLabel: game.winner ? WINNER_LABELS[game.winner] : null
    };
}
function emitGameState(room) {
    if (!room || !room.game) return;
    // A név és a titkos fertőzésjelzés miatt minden kliens személyre szabott állapotot kap.
    for (const player of room.players.values()) {
        if (player.connected === false) continue;
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) playerSocket.emit("game-state", gamePublicState(room, player.id));
    }
    const livingHealerCount = livingRolePlayers(room, "healer").length;
    for (const healer of livingRolePlayers(room, "healer")) {
        const healerSocket = io.sockets.sockets.get(healer.id);
        if (healerSocket) healerSocket.emit("healer-status", {
            livingCount: livingHealerCount,
            usesRemaining: room.game.healerUsesRemaining
        });
    }
}
function emitSpeakingToChannel(room, playerId, channel, speaking) {
    if (!room) return;
    const payload = { playerId, speaking: Boolean(speaking) };
    if (channel === "public") {
        io.to(room.code).emit("player-speaking", payload);
        return;
    }
    // A privát csatorna beszélőjelzése is csak a csapat tagjaihoz jut el.
    for (const teammate of livingRolePlayers(room, channel)) {
        io.to(teammate.id).emit("player-speaking", payload);
    }
}
function clearSpeaking(room) {
    if (!room || !(room.speakingChannels instanceof Map)) return;
    for (const [playerId, channel] of room.speakingChannels.entries()) {
        emitSpeakingToChannel(room, playerId, channel, false);
    }
    room.speakingChannels.clear();
}
function clearPlayerSpeaking(room, playerId) {
    if (!room || !(room.speakingChannels instanceof Map)) return;
    const channel = room.speakingChannels.get(playerId);
    if (!channel) return;
    room.speakingChannels.delete(playerId);
    emitSpeakingToChannel(room, playerId, channel, false);
}
function clearGameTimer(room) {
    if (room?.game?.timer) {
        clearTimeout(room.game.timer);
        room.game.timer = null;
    }
}
function startPhase(room, phase, seconds, message = "") {
    if (!room || !room.game || rooms.get(room.code) !== room || room.game.phase === "game-over") return;
    clearSpeaking(room);
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

function startHuntersPhase(room) {
    startPhase(room, "night-hunters", room.settings.huntersSeconds, "A vadászok köre következik.");
    const target = room.players.get(room.game.nightAttackTargetId);
    if (target && target.role === "hunters" && target.alive !== false && target.connected !== false && room.game.healerTargetId !== target.id) {
        // A célpont nem kapja meg a támadás okát; csak azt, hogy most nem használhatja a képességét.
        io.to(target.id).emit("hunter-action-locked", {
            message: "Ebben az éjszakában nem használhatod a vadász képességedet. Várd meg a reggelt."
        });
    }
}

function getWinner(room) {
    const living = livingPlayers(room);
    if (living.length === 0) return "draw";
    const game = room.game;
    const infectedIds = game?.infectedPlayerIds instanceof Set ? game.infectedPlayerIds : new Set();
    const infectiousAlive = living.some((player) => player.role === "infectious");
    if (infectiousAlive && living.every((player) => player.role === "infectious" || infectedIds.has(player.id))) {
        return "infectious";
    }
    const spirits = living.filter((player) => player.role === "spirits").length;
    const others = living.length - spirits;
    if (spirits === 0) return "villagers";
    if (spirits >= others) return "spirits";
    return null;
}
function endGame(room, winner) {
    if (!room?.game || room.game.phase === "game-over") return;
    clearSpeaking(room);
    clearGameTimer(room);
    for (const player of room.players.values()) {
        player.voiceSabotage = null;
        player.publicAlias = null;
    }
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

function startNightSpiritsPhase(room) {
    startPhase(room, "night-spirits", room.settings.spiritsSeconds, "A falu elcsendesült. A lidércek titokban döntenek.");
}

function startNightRound(room) {
    const winner = getWinner(room);
    if (winner) {
        endGame(room, winner);
        return;
    }
    room.game.round += 1;
    // A Bohóc lidérc hatásai a következő éjszakáig tartanak.
    for (const player of room.players.values()) {
        player.publicAlias = null;
        player.publicAliasTargetId = null;
        player.voiceSabotage = null;
    }
    room.game.spiritActions = new Map();
    room.game.swapperActions = new Map();
    room.game.infectiousActions = new Map();
    room.game.healerTargetId = null;
    room.game.healerActions = new Map();
    room.game.healerDisagreement = false;
    room.game.hunterActions = new Map();
    room.game.nightAttackTargetId = null;
    room.game.lastNightDeaths = [];
    room.game.pendingPublicEvents = [];
    room.game.pendingClownEffects = [];
    room.game.lastNightLog = [];
    room.game.pendingWinner = null;

    const clownAlive = livingPlayers(room).some((player) =>
        player.role === "spirits" && player.specialSpirit && !room.game.swapperUsedIds.has(player.id)
    );
    if (clownAlive) {
        startPhase(room, "night-swapper", room.settings.swapperSeconds, "A Bohóc lidérc titkos szabotázst választhat.");
    } else {
        startNightSpiritsPhase(room);
    }
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

function resolveHealerActions(room) {
    const game = room.game;
    if (!game) return;
    const healers = livingRolePlayers(room, "healer");
    if (healers.length <= 1) return; // Egyedül maradt gyógyítónál az egyéni, két alkalmas képesség érvényes.
    const choices = healers.map((healer) => game.healerActions.get(healer.id));
    const allVoted = choices.every((targetId) => typeof targetId === "string" && targetId.length > 0);
    const unanimous = allVoted && choices.every((targetId) => targetId === choices[0]);
    if (unanimous) {
        game.healerTargetId = choices[0];
        game.healerDisagreement = false;
    } else {
        game.healerTargetId = null;
        game.healerDisagreement = allVoted && new Set(choices).size > 1;
    }
}

function resolveSwapperActions(room) {
    const game = room.game;
    if (!game) return;
    game.pendingClownEffects = [];
    for (const clown of livingPlayers(room).filter((player) => player.role === "spirits" && player.specialSpirit)) {
        const action = game.swapperActions.get(clown.id);
        if (!action || typeof action !== "object") continue;
        const target = room.players.get(String(action.targetId || ""));
        const effect = String(action.effect || "");
        if (!target || target.id === clown.id || target.alive === false || target.connected === false) continue;
        if (!["rename", "mute"].includes(effect)) continue;
        game.pendingClownEffects.push({ clownId: clown.id, targetId: target.id, effect });
    }
}

function applyPendingClownEffects(room) {
    const game = room.game;
    if (!game || !Array.isArray(game.pendingClownEffects)) return;
    for (const action of game.pendingClownEffects) {
        const target = room.players.get(action.targetId);
        const clown = room.players.get(action.clownId);
        if (!target || !clown || target.alive === false || target.connected === false || clown.alive === false || clown.connected === false) continue;
        if (action.effect === "rename") {
            // A nevük a többiek nézetében felcserélődik; mindkét érintett a saját nevét látja.
            clown.publicAlias = target.username;
            clown.publicAliasTargetId = target.id;
            target.publicAlias = clown.username;
            target.publicAliasTargetId = clown.id;
            game.pendingPublicEvents.push({
                id: crypto.randomUUID(), type: "clown-rename",
                text: "Valakinek megváltozott a neve a játékoslistában.", at: Date.now()
            });
        } else if (action.effect === "mute") {
            target.voiceSabotage = "mute";
            game.pendingPublicEvents.push({
                id: crypto.randomUUID(), type: "clown-mute",
                text: "Egy játékos hangja elnémult erre a napra.", at: Date.now()
            });
        }
    }
    game.pendingClownEffects = [];
}

function sendInfectiousState(room) {
    if (!room?.game) return;
    const infectedPlayerIds = [...(room.game.infectedPlayerIds || new Set())];
    for (const player of livingRolePlayers(room, "infectious")) {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) playerSocket.emit("infectious-state", { infectedPlayerIds });
    }
}

function resolveInfectiousActions(room) {
    const game = room.game;
    if (!game || !(game.infectedPlayerIds instanceof Set)) return;
    let infectedSomeone = false;
    for (const infectious of livingRolePlayers(room, "infectious")) {
        const targetId = game.infectiousActions.get(infectious.id);
        const target = room.players.get(String(targetId || ""));
        if (!target || target.id === infectious.id || target.alive === false || target.connected === false) continue;
        if (game.infectedPlayerIds.has(target.id)) continue;
        game.infectedPlayerIds.add(target.id);
        infectedSomeone = true;
    }
    if (infectedSomeone) {
        game.pendingPublicEvents.push({
            id: crypto.randomUUID(),
            type: "infection",
            text: "Valaki megfertőződött.",
            at: Date.now()
        });
    }
}

function resolveNight(room) {
    const game = room.game;
    applyPendingClownEffects(room);
    const deadIds = new Set();
    const spiritTargetId = game.nightAttackTargetId;
    const protectedId = game.healerTargetId;
    let healerSavedTargetId = null;
    game.lastNightLog = [...(game.pendingPublicEvents || [])];
    game.pendingPublicEvents = [];
    if (game.healerDisagreement) {
        game.lastNightLog.push({
            id: crypto.randomUUID(),
            type: "healer-disagreement",
            text: "A gyógyítók nem értettek egyet, ezért a védelem nem sikerült.",
            at: Date.now()
        });
    }

    if (spiritTargetId && spiritTargetId === protectedId) {
        healerSavedTargetId = spiritTargetId;
    } else if (spiritTargetId) {
        const target = room.players.get(spiritTargetId);
        if (target && target.alive !== false && target.connected !== false) deadIds.add(target.id);
    }

    // Ha a lidércek már megölték a vadászt ezen az éjszakán, a vadász nem tud visszalőni.
    // Egyébként minden élő vadász legfeljebb egy lövést adhat le.
    for (const hunter of livingRolePlayers(room, "hunters")) {
        if (deadIds.has(hunter.id)) continue;
        if (!game.hunterActions.has(hunter.id)) continue;
        const action = game.hunterActions.get(hunter.id);
        if (!action || (typeof action === "object" && action.type !== "shoot")) continue; // passzolt vagy szerepet vizsgált
        const targetId = typeof action === "string" ? action : action.targetId;
        if (!targetId) continue;
        const target = room.players.get(targetId);
        if (!target || target.alive === false || target.connected === false) continue;
        deadIds.add(target.id);
        if (target.role !== "spirits") deadIds.add(hunter.id);
    }

    // Csak akkor közöljük, hogy a gyógyító megóvta a célpontot, ha az a játékos végül életben is maradt.
    if (healerSavedTargetId && !deadIds.has(healerSavedTargetId)) {
        const savedPlayer = room.players.get(healerSavedTargetId);
        if (savedPlayer && savedPlayer.alive !== false && savedPlayer.connected !== false) {
            game.lastNightLog.push({
                id: crypto.randomUUID(),
                type: "healer-save",
                text: `A gyógyító megóvta ${savedPlayer.username} játékost.`,
                at: Date.now()
            });
        }
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
    // Hajnalban frissül a Fertőző saját listája; a megfertőzött csak a saját állapotjelzését kapja meg.
    sendInfectiousState(room);
    for (const infectedId of game.infectedPlayerIds || []) {
        const infectedPlayer = room.players.get(infectedId);
        const infectedSocket = io.sockets.sockets.get(infectedId);
        if (infectedPlayer && infectedSocket && infectedPlayer.connected !== false) {
            infectedSocket.emit("infection-self-status", { infected: true });
        }
    }
    const winner = getWinner(room);
    game.pendingWinner = winner;
    const message = deaths.length
        ? "Hajnalodik. Az éjszakai kiesések a játékoslistán láthatók."
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
        .map(([targetId, votes]) => ({ targetId, votes }))
        .sort((a, b) => b.votes - a.votes);

    // A nap végén csak az összesített eredmény kerül ki; nem tárolunk és nem küldünk nyilvános voter-target párokat.
    if (expelled) {
        game.lastVoteResult = { expelledId: expelled.id, counts: results };
        game.message = "A falu kiszavazta a legtöbb szavazatot kapó játékost.";
    } else {
        game.lastVoteResult = { expelledId: null, counts: results };
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
            startPhase(room, "intro", room.settings.introSeconds, "Ismerkedjetek, beszélgessetek! Hamarosan leszáll az éjszaka.");
            break;
        case "intro":
            startNightRound(room);
            break;
        case "night-swapper":
            resolveSwapperActions(room);
            startNightSpiritsPhase(room);
            break;
        case "night-spirits": {
            room.game.nightAttackTargetId = resolveSpiritActions(room);
            const healers = livingRolePlayers(room, "healer");
            if (healers.length > 1 || (healers.length === 1 && room.game.healerUsesRemaining > 0)) {
                startPhase(room, "night-healer", room.settings.healerSeconds, healers.length > 1
                    ? "A gyógyítók külön-külön szavaznak. Csak akkor sikerül a védelem, ha ugyanazt a játékost választják."
                    : "A gyógyító kiválaszthat egy játékost, akit megvéd. Még két egyéni védési alkalma van összesen.");
            } else if (livingRolePlayers(room, "hunters").length > 0) {
                startHuntersPhase(room);
            } else if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", room.settings.foolSeconds, "A bolond kivárja az éjszakát.");
            } else if (livingRolePlayers(room, "infectious").length > 0) {
                startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
            } else {
                resolveNight(room);
            }
            break;
        }
        case "night-healer":
            resolveHealerActions(room);
            if (livingRolePlayers(room, "hunters").length > 0) {
                startHuntersPhase(room);
            } else if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", room.settings.foolSeconds, "A bolond kivárja az éjszakát.");
            } else if (livingRolePlayers(room, "infectious").length > 0) {
                startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
            } else {
                resolveNight(room);
            }
            break;
        case "night-hunters":
            if (livingRolePlayers(room, "fool").length > 0) {
                startPhase(room, "night-fool", room.settings.foolSeconds, "A bolond kivárja az éjszakát.");
            } else if (livingRolePlayers(room, "infectious").length > 0) {
                startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
            } else {
                resolveNight(room);
            }
            break;
        case "night-fool":
            if (livingRolePlayers(room, "infectious").length > 0) {
                startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
            } else {
                resolveNight(room);
            }
            break;
        case "night-infectious":
            resolveInfectiousActions(room);
            resolveNight(room);
            break;
        case "dawn-result":
            if (room.game.pendingWinner) {
                endGame(room, room.game.pendingWinner);
            } else {
                room.game.votes = new Map();
                room.game.lastVoteResult = null;
                startPhase(room, "day", room.settings.daySeconds, "Nappal van. Beszéljétek meg a történteket, majd szavazzatok vagy válasszátok a SKIP lehetőséget.");
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
    // A gyógyítók nem kapják meg egymás azonosítóját vagy nevét.
    const teamMembers = ["spirits", "hunters"].includes(player.role)
        ? livingRolePlayers(room, player.role).map((member) => ({ id: member.id, username: member.username }))
        : [];
    const roleDescriptions = {
        spirits: "Éjszaka válasszatok közös célpontot. Több lidérc esetén mindenki ugyanazt jelölje. Ha egyedül maradsz, támadhatsz vagy megvizsgálhatod egyszer egy másik élő játékos szerepét. A Bohóc lidérc helyeket a beállítás külön, fixen kiosztja; nem véletlen esély.",
        healer: "Ha több gyógyító él, mindegyik külön választ egy célpontot; csak azonos választás esetén sikerül a védelem. Nincs köztetek chat vagy ping. Ha egyedüli gyógyító maradsz, összesen két éjszakán védhetsz, éjszakánként egyszer.",
        villagers: "Nincs éjszakai képességed. Figyelj a többiekre, beszélgess nappal, és próbáld felismerni a lidérceket.",
        hunters: "Éjszaka egyszer lőhetsz egy élő játékosra, vagy passzolhatsz. A vadász nem vizsgálhat szerepet. Több vadász a saját éjszakai körében privát hangon és szöveges chaten egyeztethet. Ha a lidércek ugyanazon az éjszakán megölnek, nem támadhatsz vissza. Ha ártatlant lősz le, te is meghalsz.",
        fool: "Próbáld elérni, hogy a falu nappali szavazással kiszavazzon. Ha így esel ki, a bolond nyer.",
        swapper: "Éjszaka egyszer válassz ki vakon egy másik élő játékost. Te átveszed az ő szerepét, ő pedig Falusi lesz. Nem látod előre a szerepét, és a célpont nem tud visszacserélni.",
        infectious: "Minden éjszaka megfertőzhetsz egy még nem fertőzött, élő játékost. Csak te látod, kik fertőződtek meg; a nyilvános napló csak annyit ír, hogy valaki megfertőződött. Akkor nyersz, ha minden más életben lévő játékos fertőzött."
    };
    if (player.specialSpirit) {
        roleDescriptions.spirits = "Bohóc lidérc vagy, a lidércek csapatának különleges tagja. A közös támadásban ugyanúgy részt veszel, de szerepet nem vizsgálhatsz. A teljes játék során egyszer választhatsz egy szabotázst: vagy megváltoztatod a neved megjelenítését egy kiválasztott játékos neve alapján, vagy lenémítod őt nappalra. A névcserét a célpont nem látja magánál; mások a neved helyén az ő nevét látják.";
    }
    socket.emit("private-role", {
        role: player.role,
        label: player.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[player.role],
        specialSpirit: Boolean(player.specialSpirit),
        teamMembers,
        configuredHealers: Number(room.roles.healer) || 0,
        livingHealerCount: livingRolePlayers(room, "healer").length,
        healerUsesRemaining: room.game?.healerUsesRemaining ?? 2,
        spiritInspectUsed: Boolean(room.game?.spiritInspectUsedIds?.has(player.id)),
        swapperUsed: Boolean(room.game?.swapperUsedIds?.has(player.id)),
        infectedPlayerIds: player.role === "infectious" ? [...(room.game?.infectedPlayerIds || new Set())] : [],
        roleDescription: roleDescriptions[player.role] || "A szereped titkos."
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
    if (room) clearPlayerSpeaking(room, socket.id);
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
        const settings = normalizeRoomSettings(payload.settings);
        if (username.length < 2) return sendRoomError(socket, "A játékosneved legalább 2 karakter legyen.");
        if (nameIsInActiveRoom(username)) return sendRoomError(socket, "Ezt a nevet már használja egy aktív játékos. Válassz másik nevet a kezdőoldalon.");
        if (roomName.length < 3) return sendRoomError(socket, "A szoba neve legalább 3 karakter legyen.");
        if (!roleData) return sendRoomError(socket, `A szerepkörök összege ${MIN_PLAYERS} és ${MAX_PLAYERS} játékos között legyen.`);
        if (!settings) return sendRoomError(socket, "Minden időtartam 5 és 3600 másodperc közötti egész szám legyen.");
        const code = makeRoomCode();
        const room = {
            code, name: roomName, hostId: socket.id, roles: roleData.roles, settings, capacity: roleData.total,
            players: new Map(), started: false, createdAt: Date.now(), game: null,
            speakingChannels: new Map()
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
        if (room.roles.spirits + room.roles.swapper < 1) return sendRoomError(socket, "Legalább 1 lidércet vagy Bohóc lidércet állíts be, különben nem indulhat el a játék.");

        const roleList = [];
        for (const role of ROLE_KEYS) for (let i = 0; i < room.roles[role]; i++) roleList.push(role);
        if (roleList.length !== room.players.size) return sendRoomError(socket, "A szerepkörök összege nem egyezik a játékosok számával.");
        // A Bohóc lidérc külön beállítható, garantált speciális lidérc-helyet kap.
        // Faction szempontjából továbbra is normál lidérc, ezért részt vesz a közös támadásban.
        const shuffledRoleSlots = shuffle(roleList);
        const shuffledPlayers = shuffle([...room.players.values()]);
        shuffledPlayers.forEach((player, index) => {
            const selectedSlot = shuffledRoleSlots[index];
            player.role = selectedSlot === "swapper" ? "spirits" : selectedSlot;
            player.specialSpirit = selectedSlot === "swapper";
            player.publicAlias = null;
            player.publicAliasTargetId = null;
            player.voiceSabotage = null;
            player.alive = true;
            player.connected = true;
        });

        room.started = true;
        room.game = {
            phase: "countdown", endsAt: null, round: 0, timer: null, message: "A sötétség elnyeli a falut...",
            spiritActions: new Map(), swapperActions: new Map(), swapperUsedIds: new Set(), pendingClownEffects: [],
            spiritInspectUsedIds: new Set(), infectiousActions: new Map(), infectedPlayerIds: new Set(), pendingPublicEvents: [],
            healerTargetId: null, healerActions: new Map(), healerDisagreement: false,
            healerUsesRemaining: 2, hunterActions: new Map(), nightAttackTargetId: null,
            votes: new Map(), lastNightDeaths: [], lastNightLog: [], lastVoteResult: null, pendingWinner: null, winner: null,
            rematchReady: new Set()
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

    // A Bohóc lidérc minden éjszaka egy titkos szabotázst választhat.
    socket.on("swapper-action", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-swapper" || !player || player.role !== "spirits" || !player.specialSpirit || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a Bohóc lidérc képességét."); return;
        }
        if (room.game.swapperUsedIds.has(socket.id)) {
            socket.emit("game-action-error", "A Bohóc lidérc egyetlen szabotázsát már felhasználtad ebben a játékban."); return;
        }
        if (room.game.swapperActions.has(socket.id)) {
            socket.emit("game-action-error", "Ebben az éjszakában már választottál szabotázst."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        const effect = String(payload.effect || "");
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost."); return;
        }
        if (!["rename", "mute"].includes(effect)) {
            socket.emit("game-action-error", "Válassz névváltoztatást vagy némítást."); return;
        }
        room.game.swapperActions.set(socket.id, { clownId: player.id, targetId: target.id, effect });
        room.game.swapperUsedIds.add(socket.id);
        socket.emit("swapper-used", { used: true });
        const actionText = effect === "rename" ? "névváltoztatás" : "hang némítása";
        socket.emit("game-action-ack", { message: `A teljes játékra szóló szabotázsod rögzítve (${actionText}). Újra már nem használhatod.` });
    });

    // Lidérc-akció: egyedül szerepet vizsgálhat vagy támadhat; több lidércnek egyező célpont kell.
    socket.on("spirit-action", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-spirits" || !player || player.role !== "spirits" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a lidérc képességét."); return;
        }
        if (room.game.spiritActions.has(socket.id)) { socket.emit("game-action-error", "Ebben a körben már választottál."); return; }
        const spirits = livingRolePlayers(room, "spirits");
        const type = String(payload.type || "");
        if (spirits.length === 1 && !player.specialSpirit && type === "inspect") {
            if (!(room.game.spiritInspectUsedIds instanceof Set)) room.game.spiritInspectUsedIds = new Set();
            if (room.game.spiritInspectUsedIds.has(player.id)) {
                socket.emit("game-action-error", "A szerepvizsgálatodat már felhasználtad a játék során."); return;
            }
            const target = room.players.get(String(payload.targetId || ""));
            if (!target || target.id === player.id || target.alive === false || target.connected === false) {
                socket.emit("game-action-error", "Válassz egy másik, élő játékost, akinek megvizsgálod a szerepét."); return;
            }
            room.game.spiritActions.set(socket.id, { type: "inspect", targetId: target.id });
            room.game.spiritInspectUsedIds.add(player.id);
            socket.emit("spirit-inspect-used", { used: true });
            socket.emit("player-role-revealed", { targetId: target.id, targetName: target.username, role: target.role, label: target.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[target.role], source: "spirits" });
            socket.emit("game-action-ack", { message: `Megvizsgáltad ${target.username} szerepét: ${ROLE_LABELS[target.role]}. Ebben a körben már nem választhatsz másik akciót.` });
            return;
        }
        if (type !== "attack") {
            socket.emit("game-action-error", spirits.length > 1
                ? "Több lidérc esetén közösen kell célpontot választanotok."
                : (player.specialSpirit ? "A Bohóc lidérc nem vizsgálhat szerepet; a különleges képességét az előző körében használhatta fel." : "Válassz támadást vagy egyszeri szerepvizsgálatot."));
            return;
        }
        const targetId = String(payload.targetId || "");
        const target = room.players.get(targetId);
        if (!target || target.alive === false || target.connected === false || target.role === "spirits") {
            socket.emit("game-action-error", "Válassz egy élő, nem lidérc játékost."); return;
        }
        room.game.spiritActions.set(socket.id, { type: "attack", targetId });
        socket.emit("game-action-ack", { message: spirits.length > 1
            ? "Rögzítettük a választásodat. A támadás csak akkor sikerül, ha minden lidérc ugyanazt választja."
            : "A támadásod rögzítve." });
    });

    socket.on("healer-protect", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-healer" || !player || player.role !== "healer" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a gyógyító képességét."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.alive === false || target.connected === false) { socket.emit("game-action-error", "Válassz egy élő játékost."); return; }
        const healers = livingRolePlayers(room, "healer");
        if (healers.length > 1) {
            if (room.game.healerActions.has(socket.id)) {
                socket.emit("game-action-error", "Erre az éjszakára már leadtad a gyógyítói szavazatodat.");
                return;
            }
            room.game.healerActions.set(socket.id, target.id);
            socket.emit("game-action-ack", { message: `Leadva a gyógyítói szavazatod: ${target.username}. Csak akkor lesz védelem, ha minden élő gyógyító ugyanarra szavaz.` });
            return;
        }
        if (room.game.healerUsesRemaining <= 0) { socket.emit("game-action-error", "Elfogyott a két egyéni védési lehetőséged."); return; }
        if (room.game.healerTargetId !== null) { socket.emit("game-action-error", "Már kiválasztottad, kit védesz ezen az éjszakán."); return; }
        room.game.healerTargetId = target.id;
        room.game.healerUsesRemaining -= 1;
        socket.emit("game-action-ack", { message: `Védelem kiválasztva: ${target.username}. Még ${room.game.healerUsesRemaining} egyéni védési lehetőséged maradt.` });
        socket.emit("healer-uses-left", { remaining: room.game.healerUsesRemaining });
    });

    socket.on("hunter-shoot", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-hunters" || !player || player.role !== "hunters" || player.alive === false) {
            socket.emit("game-action-error", "Most nem használhatod a vadász képességét."); return;
        }
        if (room.game.nightAttackTargetId === player.id && room.game.healerTargetId !== player.id) {
            socket.emit("game-action-error", "Ebben az éjszakában nem használhatod a vadász képességedet."); return;
        }
        if (room.game.hunterActions.has(socket.id)) { socket.emit("game-action-error", "Ebben a körben már lőttél, passzoltál vagy vizsgálódtál."); return; }
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
        socket.emit("game-action-ack", { message: `A lövés rögzítve: ${target.username}. Ebben a körben már nem módosítható.` });
    });


    // A Fertőző minden körben egy még nem fertőzött élő játékost jelölhet meg.
    socket.on("infectious-action", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-infectious" || !player || player.role !== "infectious" || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a Fertőző képességét."); return;
        }
        if (room.game.infectiousActions.has(socket.id)) {
            socket.emit("game-action-error", "Ebben az éjszakában már választottál fertőzési célpontot."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost."); return;
        }
        if (room.game.infectedPlayerIds.has(target.id)) {
            socket.emit("game-action-error", "Ez a játékos már fertőzött. Válassz mást."); return;
        }
        room.game.infectiousActions.set(socket.id, target.id);
        socket.emit("game-action-ack", { message: "A fertőzési célpont rögzítve. A nyilvános napló nem fogja felfedni, kit választottál." });
    });

    // Privát gépes chat kizárólag a lidérceknek, a saját éjszakai körükben.
    socket.on("team-chat-send", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || !player || player.alive === false || player.connected === false) return;
        const role = player.role;
        const permittedPhases = { spirits: "night-spirits", hunters: "night-hunters" };
        const correctPhase = Boolean(permittedPhases[role] && room.game.phase === permittedPhases[role]);
        if (!correctPhase) { socket.emit("game-action-error", "Titkos hang- és szöveges csatornát csak a lidércek vagy a vadászok használhatnak a saját éjszakai körükben."); return; }
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

    // Privát WebRTC jelzések: csak az életben lévő lidércek között, a lidércek körében továbbíthatók.
    socket.on("team-voice-signal", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        const targetId = String(payload.to || "");
        const target = room?.players.get(targetId);
        if (!room?.game || !player || !target || !payload.data || player.alive === false || target.alive === false || player.connected === false || target.connected === false) return;
        const permittedPhases = { spirits: "night-spirits", hunters: "night-hunters" };
        const permitted = Boolean(permittedPhases[player.role] && room.game.phase === permittedPhases[player.role]);
        if (!permitted || target.role !== player.role || target.id === player.id) return;
        const targetSocket = io.sockets.sockets.get(targetId);
        if (!targetSocket || targetSocket.data.roomId !== room.code) return;
        targetSocket.emit("team-voice-signal", { from: socket.id, data: payload.data });
    });

    socket.on("voice-speaking", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        const gameOver = room?.game?.phase === "game-over";
        if (!room || !player || player.connected === false || (player.alive === false && !gameOver)) {
            if (room) clearPlayerSpeaking(room, socket.id);
            return;
        }
        const speaking = Boolean(payload.speaking);
        if (!speaking) {
            clearPlayerSpeaking(room, socket.id);
            return;
        }
        const publicPhase = !room.game || ["intro", "dawn-result", "day", "vote-result", "game-over"].includes(room.game.phase);
        if (!publicPhase) return;
        room.speakingChannels.set(socket.id, "public");
        emitSpeakingToChannel(room, socket.id, "public", true);
    });

    socket.on("team-voice-speaking", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || !player || player.alive === false || player.connected === false) return;
        const role = player.role;
        const permittedPhases = { spirits: "night-spirits", hunters: "night-hunters" };
        const permitted = Boolean(permittedPhases[role] && room.game.phase === permittedPhases[role]);
        if (!permitted) return;
        if (!payload.speaking) {
            if (room.speakingChannels.get(socket.id) === role) clearPlayerSpeaking(room, socket.id);
            return;
        }
        room.speakingChannels.set(socket.id, role);
        emitSpeakingToChannel(room, socket.id, role, true);
    });

    socket.on("ready-next-game", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "game-over" || !player || player.connected === false) {
            socket.emit("game-action-error", "A következő játékra csak a játék végén állhatsz készen.");
            return;
        }
        if (!(room.game.rematchReady instanceof Set)) room.game.rematchReady = new Set();
        if (payload.ready === false) room.game.rematchReady.delete(socket.id);
        else room.game.rematchReady.add(socket.id);

        const connectedPlayers = [...room.players.values()].filter((entry) =>
            entry.connected !== false && io.sockets.sockets.has(entry.id)
        );
        const readyIds = connectedPlayers
            .filter((entry) => room.game.rematchReady.has(entry.id))
            .map((entry) => entry.id);
        io.to(room.code).emit("rematch-ready-update", {
            readyCount: readyIds.length,
            total: connectedPlayers.length,
            readyIds
        });

        if (readyIds.length !== connectedPlayers.length) return;
        if (connectedPlayers.length < MIN_PLAYERS) {
            io.to(room.code).emit("rematch-ready-update", {
                readyCount: readyIds.length,
                total: connectedPlayers.length,
                readyIds,
                message: `Legalább ${MIN_PLAYERS} játékos kell az új játékhoz. Hívjatok vissza további játékosokat.`
            });
            return;
        }

        // Ha valaki kilépett a korábbi menetben, a bent maradók ugyanebben a szobában játszhatnak tovább.
        const activePlayers = new Map(connectedPlayers.map((entry) => [entry.id, entry]));
        room.players = activePlayers;
        room.capacity = connectedPlayers.length;
        room.roles = fitRolesToPlayerCount(room.roles, room.capacity);
        if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value;
        for (const entry of room.players.values()) {
            entry.ready = true;
            entry.role = null;
            entry.alive = true;
            entry.connected = true;
            delete entry.lastTeamMessageAt;
        }
        room.started = false;
        room.game = null;
        sendRoomState(room);
        sendRoomList();
        io.to(room.code).emit("return-to-waiting-room", {
            room: publicRoom(room),
            message: "Mindenki készen áll a következő menetre. A házigazda elindíthatja az új játékot."
        });
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
