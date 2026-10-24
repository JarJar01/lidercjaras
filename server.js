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
const APP_VERSION = "lidercjaras-dynamic-action-timers-kalandor-timeout-reset-2026-10-24-7";

app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "Lidércjárás", version: APP_VERSION });
});
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "index.html")));
app.get("/lobby", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "html", "lobby.html")));
app.use(express.static(PUBLIC_DIR));

const rooms = new Map();
const ROLE_KEYS = ["spirits", "healer", "villagers", "hunters", "fool", "swapper", "infectious", "seer", "landlord", "spouses", "adventurer"];
const ROLE_LABELS = {
    spirits: "Lidérc",
    healer: "Gyógyító",
    villagers: "Falusi",
    hunters: "Vadász",
    fool: "Bolond",
    swapper: "Árnycserélő",
    infectious: "Fertőző",
    seer: "Látnok",
    landlord: "Földesúr",
    spouses: "Házastárs",
    adventurer: "Kalandor"
};
const ROLE_PLURALS = {
    spirits: "Lidércek",
    healer: "Gyógyító",
    villagers: "Falusiak",
    hunters: "Vadászok",
    fool: "Bolondok",
    swapper: "Árnycserélők",
    infectious: "Fertőző",
    seer: "Látnokok",
    landlord: "Földesurak",
    spouses: "Házastársak",
    adventurer: "Kalandorok"
};
const WINNER_LABELS = {
    spirits: "A lidércek győztek",
    villagers: "A falu győzött",
    fool: "A bolond győzött",
    infectious: "A Fertőző győzött: mindenki megfertőződött",
    adventurer: "A Kalandor megtalálta mindhárom szerepet",
    draw: "A játék döntetlennel ért véget"
};
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const NIGHT_PHASES = new Set(["night-swapper", "night-special-spirit", "night-spirits", "night-healer", "night-hunters", "night-fool", "night-infectious", "night-adventurer", "night-seer"]);

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
        const value = Number(input[key] ?? 0);
        if (!Number.isInteger(value) || value < 0 || value > MAX_PLAYERS) return null;
        roles[key] = value;
    }
    const total = ROLE_KEYS.reduce((sum, key) => sum + roles[key], 0);
    if (total < MIN_PLAYERS || total > MAX_PLAYERS) return null;
    // Házastársakból páros szám kell, mert minden pár két játékosból áll.
    if (roles.spouses % 2 !== 0) return null;
    // A Kalandor csak olyan szerepeket kaphat feladatként, amelyekből tényleg van a szobában.
    if (roles.adventurer > 0) {
        const objectiveRoleCount = ROLE_KEYS.filter((key) => key !== "adventurer" && roles[key] > 0).length;
        if (objectiveRoleCount < 3) return null;
    }
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
        infectiousSeconds: 10,
        adventurerSeconds: 20,
        seerSeconds: 10
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
        const reductionOrder = ["villagers", "fool", "swapper", "infectious", "hunters", "healer", "seer", "landlord", "adventurer", "spouses", "spirits"];
        const key = reductionOrder.find((candidate) => roles[candidate] > (candidate === "spirits" || candidate === "spouses" ? 1 : 0));
        if (!key) break;
        roles[key] -= key === "spouses" ? 2 : 1;
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

function cascadeSpouseDeaths(room, deadIds) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of [...deadIds]) {
            const player = room.players.get(id);
            if (!player || player.role !== "spouses" || !player.spousePartnerId) continue;
            const partner = room.players.get(player.spousePartnerId);
            if (partner && partner.role === "spouses" && !deadIds.has(partner.id)) {
                deadIds.add(partner.id);
                changed = true;
            }
        }
    }
    return deadIds;
}

function currentVoteDetails(room) {
    const game = room.game;
    // A többiek csak azt látják, hogy a játékos leadta-e a szavazatát; a célpont titkos.
    return livingPlayers(room).map((voter) => ({
        voterId: voter.id,
        voterName: voter.username,
        submitted: game.votes.has(voter.id)
    }));
}
function currentVoteCounts(room) {
    const game = room.game;
    const counts = {};
    for (const player of room.players.values()) {
        if (player.connected !== false) counts[player.id] = 0;
    }
    counts.skip = 0;
    // Csak összesített célpontonkénti számot küldünk; a szavazó-célpont párok titkosak maradnak.
    for (const voter of room.players.values()) {
        if (voter.connected === false || !game.votes.has(voter.id)) continue;
        const targetId = game.votes.get(voter.id);
        const weight = voter.role === "landlord" ? 2 : 1;
        if (targetId === "skip") counts.skip += weight;
        else if (Object.prototype.hasOwnProperty.call(counts, targetId)) counts[targetId] += weight;
    }
    return counts;
}
function clownSabotageRoundsRemaining(room, playerId) {
    const usedAt = room.game?.clownSabotageLastUsedRound?.get(playerId);
    if (!Number.isInteger(usedAt)) return 0;
    return Math.max(0, 3 - (room.game.round - usedAt));
}
function canClownSabotage(room, playerId) {
    return clownSabotageRoundsRemaining(room, playerId) === 0;
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
    const viewerPlayer = viewerId ? room.players.get(viewerId) : null;
    const rawVoteResult = game.lastVoteResult;
    const voteResult = rawVoteResult ? {
        expelledName: rawVoteResult.expelledId ? displayNameForPlayer(room.players.get(rawVoteResult.expelledId), viewerId) : null,
        additionalExpelledNames: (rawVoteResult.additionalExpelledIds || []).map((id) => displayNameForPlayer(room.players.get(id), viewerId)),
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
        seerChannelAvailable: Boolean(
            game.phase === "night-seer" && livingRolePlayers(room, "seer").length > 0 &&
            viewerPlayer && ((viewerPlayer.role === "seer" && viewerPlayer.alive !== false) || viewerPlayer.alive === false)
        ),
        seancePeerIds: game.phase === "night-seer" && viewerPlayer &&
            ((viewerPlayer.role === "seer" && viewerPlayer.alive !== false) || viewerPlayer.alive === false)
            ? [...room.players.values()].filter((candidate) => candidate.id !== viewerId && candidate.connected !== false && (
                viewerPlayer.role === "seer" && viewerPlayer.alive !== false
                    ? candidate.alive === false
                    : candidate.role === "seer" && candidate.alive !== false
            )).map((candidate) => candidate.id)
            : [],
        specialSpiritSabotageReady: Boolean(viewerPlayer?.role === "spirits" && viewerPlayer.specialSpirit && canClownSabotage(room, viewerId)),
        specialSpiritSabotageRoundsRemaining: viewerPlayer?.role === "spirits" && viewerPlayer.specialSpirit
            ? clownSabotageRoundsRemaining(room, viewerId) : 0,
        specialSpiritActionSubmitted: Boolean(viewerId && game.swapperActions?.has(viewerId)),
        specialSpiritInspectUsed: Boolean(viewerId && game.spiritInspectUsedIds?.has(viewerId)),
        adventurerTurnFailed: Boolean(viewerId && game.adventurerFailedThisRound?.has(viewerId)),
        voteCounts: ["day", "vote-result"].includes(game.phase) ? currentVoteCounts(room) : {},
        adventurerTasks: viewerPlayer?.role === "adventurer"
            ? (game.adventurerObjectiveRoles?.get(viewerId) || []).map((roleKey) => ({
                role: roleKey,
                label: ROLE_LABELS[roleKey],
                solved: Boolean(game.adventurerProgress?.get(viewerId)?.has(roleKey)),
                targetId: game.adventurerProgress?.get(viewerId)?.get(roleKey) || null,
                targetName: game.adventurerProgress?.get(viewerId)?.has(roleKey)
                    ? displayNameForPlayer(room.players.get(game.adventurerProgress.get(viewerId).get(roleKey)), viewerId)
                    : null
            }))
            : [],
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
    // A Látnok–halottak hangjelzése csak a szeánsz résztvevőihez jut el.
    if (channel === "seance") {
        const participants = [...livingRolePlayers(room, "seer"), ...[...room.players.values()].filter((player) => player.alive === false && player.connected !== false)];
        for (const participant of participants) io.to(participant.id).emit("player-speaking", payload);
        return;
    }
    // A házastársi beszélőjelzés kizárólag a saját párhoz jut el.
    if (channel === "spouses") {
        const speaker = room.players.get(playerId);
        const partner = speaker?.spousePartnerId ? room.players.get(speaker.spousePartnerId) : null;
        io.to(playerId).emit("player-speaking", payload);
        if (partner && partner.alive !== false && partner.connected !== false) io.to(partner.id).emit("player-speaking", payload);
        return;
    }
    // A többi privát csatorna beszélőjelzése a csapat tagjaihoz jut el.
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
        room.game.timer = setTimeout(() => advanceGamePhase(room, { timedOut: true, expectedPhase: phase }), seconds * 1000);
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
        // A célpont vadász akciója már érvénytelen, ne kelljen a teljes időt kivárni miatta.
        if (!(room.game.hunterActions instanceof Map)) room.game.hunterActions = new Map();
        room.game.hunterActions.set(target.id, null);
    }
    maybeAdvanceActionPhase(room);
}

function getWinner(room) {
    const living = livingPlayers(room);
    if (living.length === 0) return "draw";
    const game = room.game;
    if (game?.adventurerObjectiveRoles instanceof Map && game?.adventurerProgress instanceof Map) {
        for (const adventurer of livingRolePlayers(room, "adventurer")) {
            const objectives = game.adventurerObjectiveRoles.get(adventurer.id) || [];
            const progress = game.adventurerProgress.get(adventurer.id) || new Map();
            if (objectives.length === 3 && objectives.every((roleKey) => progress.has(roleKey))) return "adventurer";
        }
    }
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

function startSpecialSpiritPhaseOrSpirits(room) {
    const spirits = livingRolePlayers(room, "spirits");
    const hasEligibleSpecialSpirit = spirits.some((player) => player.specialSpirit && (
        canClownSabotage(room, player.id) ||
        (spirits.length === 1 && !room.game.spiritInspectUsedIds.has(player.id))
    ));
    if (hasEligibleSpecialSpirit) {
        // A Bohóc lidérc kap egy külön 20 másodperces kört. A szabotázs 3 körönként, a vizsgálat egyszer használható.
        startPhase(room, "night-special-spirit", 20, "A Bohóc lidérc különleges köre következik.");
    } else {
        startNightSpiritsPhase(room);
    }
}

function startRoleSwapperPhaseOrSpecialSpirit(room) {
    const hasUnusedCigan = livingRolePlayers(room, "swapper").some((player) =>
        !room.game.roleSwapUsedIds.has(player.id)
    );
    if (hasUnusedCigan) {
        startPhase(room, "night-swapper", room.settings.swapperSeconds, "A Szerepcserélő titokban kiválasztja, kivel cserél szerepet.");
    } else {
        startSpecialSpiritPhaseOrSpirits(room);
    }
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
    room.game.roleSwapActions = new Map();
    room.game.infectiousActions = new Map();
    room.game.healerTargetId = null;
    room.game.healerActions = new Map();
    room.game.healerDisagreement = false;
    room.game.hunterActions = new Map();
    room.game.adventurerAttempts = new Map();
    room.game.adventurerFailedThisRound = new Set();
    room.game.nightAttackTargetId = null;
    room.game.lastNightDeaths = [];
    room.game.pendingPublicEvents = [];
    room.game.pendingClownEffects = [];
    room.game.lastNightLog = [];
    room.game.pendingWinner = null;

    startRoleSwapperPhaseOrSpecialSpirit(room);
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

function resolveRoleSwapActions(room) {
    const game = room.game;
    if (!game || !(game.roleSwapActions instanceof Map)) return;
    for (const [actorId, targetId] of game.roleSwapActions.entries()) {
        const actor = room.players.get(actorId);
        const target = room.players.get(targetId);
        if (!actor || !target || actor.role !== "swapper" || actor.alive === false || actor.connected === false || target.alive === false || target.connected === false || actor.id === target.id) continue;
        // A felhasználtságot a beküldéskor jelöljük; itt ezért nem szabad újra elutasítani.

        // Az Árnycserélő vakon átveszi a kiválasztott játékos szerepét; a célpont Falusi lesz.
        const takenRole = target.role;
        const takenSpecialSpirit = takenRole === "spirits" && Boolean(target.specialSpirit);
        const targetSpousePartnerId = target.spousePartnerId || null;
        const actorOldPartnerId = actor.spousePartnerId || null;
        if (actorOldPartnerId) {
            const oldPartner = room.players.get(actorOldPartnerId);
            if (oldPartner?.spousePartnerId === actor.id) {
                oldPartner.spousePartnerId = null;
                if (oldPartner.role === "spouses" && actor.role === "swapper") oldPartner.role = "villagers";
            }
        }
        if (targetSpousePartnerId) {
            const partner = room.players.get(targetSpousePartnerId);
            if (partner?.spousePartnerId === target.id) partner.spousePartnerId = actor.id;
        }
        actor.role = takenRole;
        actor.specialSpirit = takenSpecialSpirit;
        actor.spousePartnerId = takenRole === "spouses" ? targetSpousePartnerId : null;
        target.role = "villagers";
        target.spousePartnerId = null;
        target.specialSpirit = false;
        target.publicAlias = null;
        target.publicAliasTargetId = null;
        target.voiceSabotage = null;
        actor.publicAlias = null;
        actor.publicAliasTargetId = null;
        actor.voiceSabotage = null;

        game.pendingPublicEvents.push({
            id: crypto.randomUUID(),
            type: "role-swap",
            text: "Éjszaka egy titkos szerepcsere történt.",
            at: Date.now()
        });

        const actorSocket = io.sockets.sockets.get(actor.id);
        const targetSocket = io.sockets.sockets.get(target.id);
        if (actorSocket) {
            sendPrivateRole(actorSocket, room, actor);
            actorSocket.emit("role-swap-used", { used: true });
            actorSocket.emit("game-action-ack", { message: `Megkaptad a kiválasztott játékos szerepét: ${actor.role === "spirits" && actor.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[actor.role]}.` });
        }
        if (targetSocket) {
            sendPrivateRole(targetSocket, room, target);
            targetSocket.emit("game-action-ack", { message: "A szereped megváltozott. Mostantól Falusi vagy." });
        }
    }
    game.roleSwapActions.clear();
    emitGameState(room);
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
            // A Bohóc lidérc felveszi a célpont nevét a többiek nézetében. A célpont a saját nevét látja, és nem kap jelzést a cseréről.
            clown.publicAlias = target.username;
            clown.publicAliasTargetId = target.id;
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

    cascadeSpouseDeaths(room, deadIds);
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
        const voteWeight = player.role === "landlord" ? 2 : 1;
        if (vote === "skip") {
            counts.set("skip", (counts.get("skip") || 0) + voteWeight);
            continue;
        }
        const target = room.players.get(vote);
        if (!target || target.alive === false || target.connected === false) {
            counts.set("skip", (counts.get("skip") || 0) + voteWeight);
            continue;
        }
        counts.set(vote, (counts.get(vote) || 0) + voteWeight);
    }
    for (const player of living) if (!counts.has(player.id)) counts.set(player.id, 0);
    const highest = Math.max(0, ...counts.values());
    const top = [...counts.entries()].filter(([, count]) => count === highest && count > 0);

    let expelled = null;
    const expelledIds = new Set();
    if (top.length === 1 && top[0][0] !== "skip") {
        expelled = room.players.get(top[0][0]) || null;
        if (expelled && expelled.alive !== false) {
            expelledIds.add(expelled.id);
            cascadeSpouseDeaths(room, expelledIds);
            for (const id of expelledIds) {
                const player = room.players.get(id);
                if (player) player.alive = false;
            }
        } else expelled = null;
    }

    const results = [...counts.entries()]
        .filter(([, count]) => count > 0)
        .map(([targetId, votes]) => ({ targetId, votes }))
        .sort((a, b) => b.votes - a.votes);

    // A nap végén csak az összesített eredmény kerül ki; nem tárolunk és nem küldünk nyilvános voter-target párokat.
    if (expelled) {
        const linkedDeaths = [...expelledIds].filter((id) => id !== expelled.id);
        game.lastVoteResult = { expelledId: expelled.id, additionalExpelledIds: linkedDeaths, counts: results };
        game.message = linkedDeaths.length
            ? "A falu kiszavazott valakit, és a házastársi kötelék miatt a párja is kiesett."
            : "A falu kiszavazta a legtöbb szavazatot kapó játékost.";
        for (const id of linkedDeaths) {
            const partner = room.players.get(id);
            if (partner) game.lastNightLog.push({ id: crypto.randomUUID(), type: "spouse-bond", text: "A házastársi kötelék miatt egy másik játékos is kiesett.", at: Date.now() });
        }
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

function startSeerPhaseOrResolve(room) {
    const hasLivingSeer = livingRolePlayers(room, "seer").length > 0;
    const hasConnectedDead = [...room.players.values()].some((player) => player.alive === false && player.connected !== false);
    if (room.game.round % 2 === 0 && hasLivingSeer && hasConnectedDead) {
        startPhase(room, "night-seer", room.settings.seerSeconds || 10, "A Látnok minden második éjszakán rövid ideig beszélhet a holtakkal.");
    } else {
        resolveNight(room);
    }
}

function startAdventurerPhaseOrResolve(room) {
    const game = room.game;
    const pending = livingRolePlayers(room, "adventurer").some((player) => {
        const tasks = game.adventurerObjectiveRoles?.get(player.id) || [];
        const progress = game.adventurerProgress?.get(player.id) || new Map();
        return tasks.some((roleKey) => !progress.has(roleKey));
    });
    if (pending) startPhase(room, "night-adventurer", room.settings.adventurerSeconds, "A Kalandor legfeljebb három cél-szerepet próbál megtalálni. Hibás tipp után az adott éjszakára véget ér a köre.");
    else startSeerPhaseOrResolve(room);
}

function startRemainingNightActions(room) {
    if (livingRolePlayers(room, "fool").length > 0) {
        startPhase(room, "night-fool", room.settings.foolSeconds, "A bolond kivárja az éjszakát.");
    } else if (livingRolePlayers(room, "infectious").length > 0) {
        startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
    } else {
        startAdventurerPhaseOrResolve(room);
    }
}

function actionPhaseIsComplete(room) {
    const game = room?.game;
    if (!game || game.phase === "game-over") return false;
    switch (game.phase) {
        case "night-swapper": {
            const eligible = livingRolePlayers(room, "swapper").filter((p) => !game.roleSwapUsedIds?.has(p.id));
            return eligible.every((p) => game.roleSwapActions?.has(p.id));
        }
        case "night-special-spirit": {
            const spirits = livingRolePlayers(room, "spirits");
            const eligible = spirits.filter((p) => p.specialSpirit && (
                canClownSabotage(room, p.id) || (spirits.length === 1 && !game.spiritInspectUsedIds?.has(p.id))
            ));
            return eligible.every((p) => game.swapperActions?.has(p.id));
        }
        case "night-spirits": {
            const actors = livingRolePlayers(room, "spirits");
            return actors.every((p) => game.spiritActions?.has(p.id));
        }
        case "night-healer": {
            const actors = livingRolePlayers(room, "healer");
            if (actors.length === 0) return true;
            if (actors.length > 1) return actors.every((p) => game.healerActions?.has(p.id));
            return Number(game.healerUsesRemaining) > 0 && game.healerTargetId !== null;
        }
        case "night-hunters": {
            const actors = livingRolePlayers(room, "hunters");
            return actors.every((p) => game.hunterActions?.has(p.id));
        }
        case "night-infectious": {
            const actors = livingRolePlayers(room, "infectious");
            return actors.every((p) => game.infectiousActions?.has(p.id));
        }
        case "night-adventurer": {
            const actors = livingRolePlayers(room, "adventurer");
            return actors.every((p) => {
                if (game.adventurerFailedThisRound?.has(p.id)) return true;
                const tasks = game.adventurerObjectiveRoles?.get(p.id) || [];
                const progress = game.adventurerProgress?.get(p.id) || new Map();
                return tasks.length === 3 && tasks.every((roleKey) => progress.has(roleKey));
            });
        }
        default:
            return false;
    }
}

function maybeAdvanceActionPhase(room) {
    if (!actionPhaseIsComplete(room)) return false;
    const phase = room.game.phase;
    clearGameTimer(room);
    // A rövidített fázis ugyanazon a szerveroldali átmeneten megy keresztül, mint az időzítő.
    advanceGamePhase(room, { timedOut: false, expectedPhase: phase });
    return true;
}

function advanceGamePhase(room, options = {}) {
    if (!room || rooms.get(room.code) !== room || !room.game || room.game.phase === "game-over") return;
    if (options.expectedPhase && room.game.phase !== options.expectedPhase) return;
    const phaseAtAdvance = room.game.phase;
    const timedOut = options.timedOut === true;
    room.game.timer = null;

    // A Kalandor több részből álló feladata csak akkor sikeres, ha mindhárom célt eltalálja.
    // Hibás tippnél vagy időtúllépésnél a teljes addigi haladás törlődik.
    if (phaseAtAdvance === "night-adventurer" && timedOut) {
        for (const adventurer of livingRolePlayers(room, "adventurer")) {
            const objectives = room.game.adventurerObjectiveRoles?.get(adventurer.id) || [];
            const progress = room.game.adventurerProgress?.get(adventurer.id) || new Map();
            const completed = objectives.length === 3 && objectives.every((roleKey) => progress.has(roleKey));
            if (completed || room.game.adventurerFailedThisRound?.has(adventurer.id)) continue;
            progress.clear();
            room.game.adventurerProgress.set(adventurer.id, progress);
            room.game.adventurerFailedThisRound.add(adventurer.id);
            const adventurerSocket = io.sockets.sockets.get(adventurer.id);
            if (adventurerSocket) {
                adventurerSocket.emit("adventurer-guess-result", {
                    correct: false,
                    timeout: true,
                    message: "Lejárt az idő. A Kalandor feladata nem sikerült, ezért mindhárom szerepet újra kell megtalálnod a következő alkalommal."
                });
            }
        }
        emitGameState(room);
    }

    switch (phaseAtAdvance) {
        case "countdown":
            startPhase(room, "intro", room.settings.introSeconds, "Ismerkedjetek, beszélgessetek! Hamarosan leszáll az éjszaka.");
            break;
        case "intro":
            startNightRound(room);
            break;
        case "night-swapper":
            resolveRoleSwapActions(room);
            startSpecialSpiritPhaseOrSpirits(room);
            break;
        case "night-special-spirit":
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
            } else {
                startRemainingNightActions(room);
            }
            break;
        }
        case "night-healer":
            resolveHealerActions(room);
            if (livingRolePlayers(room, "hunters").length > 0) startHuntersPhase(room);
            else startRemainingNightActions(room);
            break;
        case "night-hunters":
            startRemainingNightActions(room);
            break;
        case "night-fool":
            if (livingRolePlayers(room, "infectious").length > 0) {
                startPhase(room, "night-infectious", room.settings.infectiousSeconds, "A Fertőző kiválasztja a következő célpontját.");
            } else {
                startAdventurerPhaseOrResolve(room);
            }
            break;
        case "night-infectious":
            resolveInfectiousActions(room);
            startAdventurerPhaseOrResolve(room);
            break;
        case "night-adventurer":
            startSeerPhaseOrResolve(room);
            break;
        case "night-seer":
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
    let teamMembers = ["spirits", "hunters"].includes(player.role)
        ? livingRolePlayers(room, player.role).map((member) => ({ id: member.id, username: member.username }))
        : [];
    if (player.role === "spouses" && player.spousePartnerId) {
        const partner = room.players.get(player.spousePartnerId);
        teamMembers = partner && partner.role === "spouses" && partner.alive !== false
            ? [{ id: partner.id, username: partner.username }]
            : [];
    }
    const roleDescriptions = {
        spirits: "Éjszaka válasszatok közös célpontot. Több lidérc esetén mindenkinek ugyanazt a célpontot kell választania. Ha egyedül maradsz, támadhatsz vagy a teljes játék során egyszer megvizsgálhatod egy másik élő játékos szerepét. Minden lidérc külön, 50% eséllyel lehet Bohóc lidérc.",
        healer: "Ha több gyógyító él, mindegyik külön választ egy célpontot; csak azonos választás esetén sikerül a védelem. Nincs köztetek chat vagy ping. Ha egyedüli gyógyító maradsz, összesen két éjszakán védhetsz, éjszakánként egyszer.",
        villagers: "Nincs éjszakai képességed. Figyelj a többiekre, beszélgess nappal, és próbáld felismerni a lidérceket.",
        hunters: "Éjszaka egyszer lőhetsz egy élő játékosra, vagy passzolhatsz. A vadász nem vizsgálhat szerepet. Több vadász a saját éjszakai körében privát hangon és szöveges chaten egyeztethet. Ha a lidércek ugyanazon az éjszakán megölnek, nem támadhatsz vissza. Ha ártatlant lősz le, te is meghalsz.",
        fool: "Próbáld elérni, hogy a falu nappali szavazással kiszavazzon. Ha így esel ki, a bolond nyer.",
        swapper: "Éjszaka egyszer, vakon válassz ki egy másik élő játékost. Megkapod az ő szerepét, ő pedig Falusi lesz. Nem látod előre a szerepét, és a célpont nem tud visszacserélni.",
        infectious: "Minden éjszaka megfertőzhetsz egy még nem fertőzött, élő játékost. Csak te látod, kik fertőződtek meg; a nyilvános napló csak annyit ír, hogy valaki megfertőződött. Akkor nyersz, ha minden más életben lévő játékos fertőzött.",
        seer: "Minden második éjszakán, ha már van halott játékos, kapsz egy külön szeánszt. Ebben csak hangon beszélhetsz a holtakkal; szöveges chat nincs, az élők más tagjai nem hallják.",
        landlord: "A nappali szavazásod két szavazatot ér. Egy célpontot választasz, és a voksod kétszer számít bele az eredménybe.",
        spouses: "Van egy házastársad, akit a titkos szerepkártyádon látsz. Éjszaka privát chaten és hangon kommunikálhattok. Ha egyikőtök meghal, a másik is kiesik.",
        adventurer: "Három, a szobában ténylegesen beállított szerepet kell megtalálnod. Minden éjszaka egy játékos szerepére tippelhetsz. A célpont halála nem törli a feladatot. Ha mindhárom helyes találatod megvan, azonnal nyersz."
    };
    if (player.specialSpirit) {
        roleDescriptions.spirits = "Bohóc lidérc vagy: továbbra is a lidércek csapatában játszol és részt veszel a támadásban. A különleges körödben névfelvételt vagy nappali némítást használhatsz; ezt a szabotázst 3 kör elteltével újra használhatod. Ha egyedüli lidérc vagy, a szerepvizsgálatodat a teljes játékban csak egyszer használhatod. A célpont a saját eredeti nevét látja; mindenki más a felvett nevet látja.";
    }
    socket.emit("private-role", {
        role: player.role,
        label: player.role === "spirits" && player.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[player.role],
        specialSpirit: Boolean(player.specialSpirit),
        teamMembers,
        configuredHealers: Number(room.roles.healer) || 0,
        livingHealerCount: livingRolePlayers(room, "healer").length,
        healerUsesRemaining: room.game?.healerUsesRemaining ?? 2,
        spiritInspectUsed: Boolean(room.game?.spiritInspectUsedIds?.has(player.id)),
        swapperUsed: Boolean(room.game?.swapperUsedIds?.has(player.id)),
        specialSpiritSabotageReady: Boolean(player.role === "spirits" && player.specialSpirit && canClownSabotage(room, player.id)),
        specialSpiritSabotageRoundsRemaining: player.role === "spirits" && player.specialSpirit ? clownSabotageRoundsRemaining(room, player.id) : 0,
        roleSwapUsed: Boolean(room.game?.roleSwapUsedIds?.has(player.id)),
        infectedPlayerIds: player.role === "infectious" ? [...(room.game?.infectedPlayerIds || new Set())] : [],
        adventurerTasks: player.role === "adventurer" ? (room.game?.adventurerObjectiveRoles?.get(player.id) || []).map((roleKey) => ({ role: roleKey, label: ROLE_LABELS[roleKey], solved: Boolean(room.game?.adventurerProgress?.get(player.id)?.has(roleKey)), targetId: room.game?.adventurerProgress?.get(player.id)?.get(roleKey) || null })) : [],
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
            if (player.role === "spouses" && player.spousePartnerId) {
                const partner = room.players.get(player.spousePartnerId);
                if (partner && partner.role === "spouses" && partner.alive !== false) {
                    partner.alive = false;
                    room.game.lastNightLog = Array.isArray(room.game.lastNightLog) ? room.game.lastNightLog : [];
                    room.game.lastNightLog.push({ id: crypto.randomUUID(), type: "spouse-bond", text: "A házastársi kötelék miatt egy másik játékos is kiesett.", at: Date.now() });
                }
            }
            const winner = getWinner(room);
            if (winner) endGame(room, winner);
            else {
                emitGameState(room);
                maybeAdvanceActionPhase(room);
            }
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
        if (!roleData) return sendRoomError(socket, `Ellenőrizd a beállításokat: ${MIN_PLAYERS}–${MAX_PLAYERS} játékos lehet, a Házastársak száma páros legyen, és a Kalandorhoz legalább 3 különböző szerepkör legyen beállítva.`);
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
        if (room.roles.spirits < 1) return sendRoomError(socket, "Legalább 1 Lidércet állíts be. A Bohóc lidérc csak véletlenszerű különleges változata egy Lidércnek.");

        if (room.roles.spouses % 2 !== 0) return sendRoomError(socket, "A Házastársak száma páros legyen (2, 4, 6…).");
        if (room.roles.adventurer > 0 && ROLE_KEYS.filter((key) => key !== "adventurer" && room.roles[key] > 0).length < 3) {
            return sendRoomError(socket, "A Kalandorhoz legalább három különböző, beállított szerepkör kell.");
        }
        const roleList = [];
        for (const role of ROLE_KEYS) for (let i = 0; i < room.roles[role]; i++) roleList.push(role);
        if (roleList.length !== room.players.size) return sendRoomError(socket, "A szerepkörök összege nem egyezik a játékosok számával.");
        // A Bohóc lidérc nem önálló lobby-szerep: minden kiosztott Lidérc külön 50%-os eséllyel kapja a különleges változatot.
        const shuffledRoleSlots = shuffle(roleList);
        const shuffledPlayers = shuffle([...room.players.values()]);
        shuffledPlayers.forEach((player, index) => {
            const selectedSlot = shuffledRoleSlots[index];
            player.role = selectedSlot;
            player.originalRole = selectedSlot;
            player.specialSpirit = selectedSlot === "spirits" && crypto.randomInt(2) === 0;
            player.spousePartnerId = null;
            player.publicAlias = null;
            player.publicAliasTargetId = null;
            player.voiceSabotage = null;
            player.alive = true;
            player.connected = true;
        });

        // A Házastársak párokba kerülnek. Egy beállított szerep-pár két játékosból áll.
        const spouses = shuffle(shuffledPlayers.filter((player) => player.role === "spouses"));
        for (let i = 0; i + 1 < spouses.length; i += 2) {
            spouses[i].spousePartnerId = spouses[i + 1].id;
            spouses[i + 1].spousePartnerId = spouses[i].id;
        }

        room.started = true;
        room.game = {
            phase: "countdown", endsAt: null, round: 0, timer: null, message: "A sötétség elnyeli a falut...",
            spiritActions: new Map(), swapperActions: new Map(), swapperUsedIds: new Set(), clownSabotageLastUsedRound: new Map(), roleSwapActions: new Map(), roleSwapUsedIds: new Set(), pendingClownEffects: [],
            spiritInspectUsedIds: new Set(), infectiousActions: new Map(), infectedPlayerIds: new Set(), pendingPublicEvents: [],
            healerTargetId: null, healerActions: new Map(), healerDisagreement: false,
            healerUsesRemaining: 2, hunterActions: new Map(), nightAttackTargetId: null,
            votes: new Map(), lastNightDeaths: [], lastNightLog: [], lastVoteResult: null, pendingWinner: null, winner: null,
            rematchReady: new Set(),
            adventurerObjectiveRoles: new Map(), adventurerProgress: new Map(), adventurerAttempts: new Map(), adventurerFailedThisRound: new Set()
        };
        const availableAdventurerRoles = ROLE_KEYS.filter((roleKey) => roleKey !== "adventurer" && room.roles[roleKey] > 0);
        for (const adventurer of livingRolePlayers(room, "adventurer")) {
            room.game.adventurerObjectiveRoles.set(adventurer.id, shuffle(availableAdventurerRoles).slice(0, 3));
            room.game.adventurerProgress.set(adventurer.id, new Map());
            room.game.adventurerAttempts.set(adventurer.id, new Set());
        }

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

    // A Szerepcserélő egyszer, vakon szerepet cserélhet egy másik élő játékossal.
    socket.on("cigan-role-swap", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-swapper" || !player || player.role !== "swapper" || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a Szerepcserélő szerepcseréjét."); return;
        }
        if (room.game.roleSwapUsedIds.has(socket.id)) {
            socket.emit("game-action-error", "A szerepcserédet már felhasználtad ebben a játékban."); return;
        }
        if (room.game.roleSwapActions.has(socket.id)) {
            socket.emit("game-action-error", "Erre az éjszakára már választottál."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost."); return;
        }
        room.game.roleSwapActions.set(socket.id, target.id);
        room.game.roleSwapUsedIds.add(socket.id);
        socket.emit("role-swap-used", { used: true });
        socket.emit("game-action-ack", { message: "A vak szerepcsere rögzítve. A szereped a kör végén változik meg; a célpont csak Falusi lesz." });
        maybeAdvanceActionPhase(room);
    });

    // A Bohóc lidérc szabotázsa három körönként használható újra.
    socket.on("swapper-action", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-special-spirit" || !player || player.role !== "spirits" || !player.specialSpirit || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a Bohóc lidérc képességét."); return;
        }
        if (!canClownSabotage(room, socket.id)) {
            socket.emit("game-action-error", `A szabotázsod még ${clownSabotageRoundsRemaining(room, socket.id)} körig pihen.`); return;
        }
        if (room.game.swapperActions.has(socket.id)) {
            socket.emit("game-action-error", "Ebben a körben már választottál képességet."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        const effect = String(payload.effect || "");
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost."); return;
        }
        if (!["rename", "mute"].includes(effect)) {
            socket.emit("game-action-error", "Válassz névfelvételt vagy némítást."); return;
        }
        room.game.swapperActions.set(socket.id, { clownId: player.id, targetId: target.id, effect });
        room.game.clownSabotageLastUsedRound.set(socket.id, room.game.round);
        socket.emit("swapper-used", { used: true, cooldownRounds: 3 });
        emitGameState(room);
        const actionText = effect === "rename" ? "névfelvétel" : "hang némítása";
        socket.emit("game-action-ack", { message: `A szabotázsod rögzítve (${actionText}). A következő használatig 3 kör telik el.` });
        maybeAdvanceActionPhase(room);
    });

    // Az egyedüli Bohóc lidérc a szerepvizsgálatot egyszer használhatja, külön a szabotázs hűtési idejétől.
    socket.on("special-spirit-inspect", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || room.game.phase !== "night-special-spirit" || !player || player.role !== "spirits" || !player.specialSpirit || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a különleges lidérc képességét."); return;
        }
        if (livingRolePlayers(room, "spirits").length !== 1) {
            socket.emit("game-action-error", "Szerepet csak egyedüli lidércként vizsgálhatsz."); return;
        }
        if (room.game.spiritInspectUsedIds.has(socket.id)) {
            socket.emit("game-action-error", "A szerepvizsgálatodat már felhasználtad a teljes játékban."); return;
        }
        if (room.game.swapperActions.has(socket.id)) {
            socket.emit("game-action-error", "Ebben a Bohóc lidérc-körben már választottál képességet."); return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost."); return;
        }
        room.game.spiritInspectUsedIds.add(socket.id);
        room.game.swapperActions.set(socket.id, { type: "inspect" });
        socket.emit("spirit-inspect-used", { used: true });
        emitGameState(room);
        socket.emit("player-role-revealed", {
            targetId: target.id,
            targetName: target.username,
            role: target.role,
            label: target.role === "spirits" && target.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[target.role],
            source: "spirits"
        });
        socket.emit("game-action-ack", { message: `Megvizsgáltad ${target.username} szerepét. A különleges képességedet felhasználtad.` });
        maybeAdvanceActionPhase(room);
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
            socket.emit("player-role-revealed", { targetId: target.id, targetName: target.username, role: target.role, label: target.role === "spirits" && target.specialSpirit ? "Bohóc lidérc" : ROLE_LABELS[target.role], source: "spirits" });
            socket.emit("game-action-ack", { message: `Megvizsgáltad ${target.username} szerepét: ${ROLE_LABELS[target.role]}. Ebben a körben már nem választhatsz másik akciót.` });
            maybeAdvanceActionPhase(room);
            return;
        }
        if (type !== "attack") {
            socket.emit("game-action-error", spirits.length > 1
                ? "Több lidérc esetén közösen kell célpontot választanotok."
                : (player.specialSpirit ? "A különleges lidérc csak a külön 20 másodperces körében választhat egyszer szabotázst vagy szerepvizsgálatot." : "Válassz támadást vagy egyszeri szerepvizsgálatot."));
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
        maybeAdvanceActionPhase(room);
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
            maybeAdvanceActionPhase(room);
            return;
        }
        if (room.game.healerUsesRemaining <= 0) { socket.emit("game-action-error", "Elfogyott a két egyéni védési lehetőséged."); return; }
        if (room.game.healerTargetId !== null) { socket.emit("game-action-error", "Már kiválasztottad, kit védesz ezen az éjszakán."); return; }
        room.game.healerTargetId = target.id;
        room.game.healerUsesRemaining -= 1;
        socket.emit("game-action-ack", { message: `Védelem kiválasztva: ${target.username}. Még ${room.game.healerUsesRemaining} egyéni védési lehetőséged maradt.` });
        socket.emit("healer-uses-left", { remaining: room.game.healerUsesRemaining });
        maybeAdvanceActionPhase(room);
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
            maybeAdvanceActionPhase(room);
            return;
        }
        const target = room.players.get(String(payload.targetId || ""));
        if (!target || target.id === player.id || target.alive === false || target.connected === false) {
            socket.emit("game-action-error", "Válassz egy másik, élő játékost, vagy passzolj."); return;
        }
        room.game.hunterActions.set(socket.id, target.id);
        socket.emit("game-action-ack", { message: `A lövés rögzítve: ${target.username}. Ebben a körben már nem módosítható.` });
        maybeAdvanceActionPhase(room);
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
        maybeAdvanceActionPhase(room);
    });

    socket.on("adventurer-guess", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        const game = room?.game;
        if (!game || game.phase !== "night-adventurer" || !player || player.role !== "adventurer" || player.alive === false || player.connected === false) {
            socket.emit("game-action-error", "Most nem használhatod a Kalandor képességét."); return;
        }
        const roleKey = String(payload.roleKey || "");
        const targetId = String(payload.targetId || "");
        const objectives = game.adventurerObjectiveRoles?.get(player.id) || [];
        const progress = game.adventurerProgress?.get(player.id) || new Map();
        const attempts = game.adventurerAttempts?.get(player.id) || new Set();
        const failedThisRound = game.adventurerFailedThisRound || new Set();
        const target = room.players.get(targetId);
        if (failedThisRound.has(player.id)) { socket.emit("game-action-error", "A Kalandor-köröd erre az éjszakára véget ért. A következő éjjel folytathatod."); return; }
        if (!objectives.includes(roleKey)) { socket.emit("game-action-error", "Ez nem a Kalandor egyik feladata."); return; }
        if (progress.has(roleKey)) { socket.emit("game-action-error", "Ezt a szerepet már sikeresen megtaláltad."); return; }
        if (attempts.has(roleKey)) { socket.emit("game-action-error", "Erre a szerepre ezen az éjszakán már tippeltél. Várd meg a következő éjszakát."); return; }
        if (!target || target.id === player.id || target.connected === false) { socket.emit("game-action-error", "Válassz egy másik csatlakozott játékost. Kiesett játékosra is tippelhetsz."); return; }
        attempts.add(roleKey);
        game.adventurerAttempts.set(player.id, attempts);
        if (target.originalRole === roleKey) {
            progress.set(roleKey, target.id);
            game.adventurerProgress.set(player.id, progress);
            socket.emit("adventurer-guess-result", { correct: true, roleKey, targetId: target.id, message: `Helyes! ${displayNameForPlayer(target, player.id)} valóban ${ROLE_LABELS[roleKey]}. A következő feladatodra is tippelhetsz ebben a körben.` });
            const allSolved = objectives.length === 3 && objectives.every((key) => progress.has(key));
            if (allSolved) {
                emitGameState(room);
                endGame(room, "adventurer");
                return;
            }
        } else {
            // Egyetlen hibás tipp is lenullázza a teljes háromrészes feladatsort.
            progress.clear();
            game.adventurerProgress.set(player.id, progress);
            failedThisRound.add(player.id);
            game.adventurerFailedThisRound = failedThisRound;
            socket.emit("adventurer-guess-result", { correct: false, roleKey, targetId: target.id, message: "Rossz tipp! A teljes feladatsorod újraindul a következő éjszakán. Erre a körre befejezted." });
        }
        emitGameState(room);
        maybeAdvanceActionPhase(room);
    });

    // Privát gépes chat: lidércek/vadászok a saját éjszakai körükben, házastársak éjszaka, a Látnok és a halottak külön csatornán.
    socket.on("team-chat-send", (payload = {}) => {
        const room = rooms.get(socket.data.roomId);
        const player = room?.players.get(socket.id);
        if (!room?.game || !player || player.connected === false || room.game.phase === "game-over") return;
        const role = player.role;
        const isDead = player.alive === false;
        // A Látnok a külön körében csak privát voice csatornát kap, szöveges csatornát nem.
        const correctPhase = role === "spirits" && !isDead
            ? ["night-special-spirit", "night-spirits"].includes(room.game.phase)
            : role === "hunters" && !isDead && room.game.phase === "night-hunters"
                ? true
                : role === "spouses" && !isDead && NIGHT_PHASES.has(room.game.phase) && room.game.phase !== "night-seer";
        if (!correctPhase) { socket.emit("game-action-error", "Ebben a körben nincs hozzáférésed ehhez a titkos csatornához."); return; }
        const text = cleanText(payload.text, 240);
        if (!text) return;
        const now = Date.now();
        if (player.lastTeamMessageAt && now - player.lastTeamMessageAt < 350) return;
        player.lastTeamMessageAt = now;
        let channel = role;
        let teammates = [];
        if (role === "spouses") {
            const partner = player.spousePartnerId ? room.players.get(player.spousePartnerId) : null;
            teammates = partner && partner.role === "spouses" && partner.alive !== false && partner.connected !== false ? [player, partner] : [player];
        } else {
            teammates = livingRolePlayers(room, role);
        }
        for (const teammate of teammates) {
            io.to(teammate.id).emit("team-chat-message", {
                team: channel,
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
        if (!room?.game || !player || !target || !payload.data || player.connected === false || target.connected === false || target.id === player.id) return;
        const seancePair = room.game.phase === "night-seer" && (
            (player.role === "seer" && player.alive !== false && target.alive === false) ||
            (player.alive === false && target.role === "seer" && target.alive !== false)
        );
        const ordinaryPrivatePair = player.alive !== false && target.alive !== false && (
            (player.role === "spirits" && target.role === "spirits" && ["night-special-spirit", "night-spirits"].includes(room.game.phase)) ||
            (player.role === "hunters" && target.role === "hunters" && room.game.phase === "night-hunters") ||
            (player.role === "spouses" && target.role === "spouses" && NIGHT_PHASES.has(room.game.phase) && room.game.phase !== "night-seer" && player.spousePartnerId === target.id)
        );
        if (!seancePair && !ordinaryPrivatePair) return;
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
        if (!room?.game || !player || player.connected === false) return;
        const isSeanceParticipant = room.game.phase === "night-seer" && (
            (player.role === "seer" && player.alive !== false) || player.alive === false
        );
        if (player.alive === false && !isSeanceParticipant) return;
        const role = isSeanceParticipant ? "seance" : player.role;
        const permitted = isSeanceParticipant || (role === "spirits"
            ? ["night-special-spirit", "night-spirits"].includes(room.game.phase)
            : role === "hunters" && room.game.phase === "night-hunters"
                ? true
                : role === "spouses" && NIGHT_PHASES.has(room.game.phase) && room.game.phase !== "night-seer");
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
            entry.originalRole = null;
            entry.spousePartnerId = null;
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
            if (!target || target.alive === false || target.connected === false) {
                socket.emit("game-action-error", "Válassz egy élő játékost, akár saját magadat is, vagy a SKIP lehetőséget."); return;
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
