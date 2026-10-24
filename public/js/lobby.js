"use strict";

(() => {
    const socket = window.lidercSocket;
    let playerName = (localStorage.getItem("ljPlayerName") || "").trim();

    if (!playerName || playerName.length < 2) {
        window.location.replace("/");
        return;
    }

    const views = {
        home: document.getElementById("lobbyHomeView"),
        create: document.getElementById("createView"),
        search: document.getElementById("searchView"),
        waiting: document.getElementById("waitingRoomView"),
        game: document.getElementById("gameStartedView")
    };

    const roomList = document.getElementById("roomList");
    const roomSearchInput = document.getElementById("roomSearchInput");
    const lobbyMessage = document.getElementById("lobbyMessage");
    const modalRoot = document.getElementById("modalRoot");

    const roleKeys = ["spirits", "healer", "villagers", "hunters", "fool", "swapper", "infectious", "seer", "landlord", "spouses", "adventurer"];
    const roleLabels = {
        spirits: "Lidércek",
        healer: "Gyógyító",
        villagers: "Falusiak",
        hunters: "Vadászok",
        fool: "Bolondok",
        swapper: "Árnycserélő",
        infectious: "Fertőző",
        seer: "Látnok",
        landlord: "Földesúr",
        spouses: "Házastársak",
        adventurer: "Kalandor"
    };
    const roleIds = {
        spirits: "roleSpirits",
        healer: "roleHealer",
        villagers: "roleVillagers",
        hunters: "roleHunters",
        fool: "roleFool",
        swapper: "roleSwapper",
        infectious: "roleInfectious",
        seer: "roleSeer",
        landlord: "roleLandlord",
        spouses: "roleSpouses",
        adventurer: "roleAdventurer"
    };
    const roleClasses = {
        spirits: "role-color-spirits",
        healer: "role-color-healer",
        villagers: "role-color-villagers",
        hunters: "role-color-hunters",
        fool: "role-color-fool",
        swapper: "role-color-swapper",
        infectious: "role-color-infectious",
        seer: "role-color-seer",
        landlord: "role-color-landlord",
        spouses: "role-color-spouses",
        adventurer: "role-color-adventurer"
    };

    let currentRoom = null;
    let availableRooms = [];
    let messageTimeout = null;

    // WebRTC hangkapcsolatok. A hanghoz a böngésző mikrofonengedélye szükséges.
    const voicePeers = new Map();
    const teamVoicePeers = new Map();
    const speakingPlayerIds = new Set();
    // A bejövő WebRTC-hangot alapértelmezetten közvetlenül játsszuk le.
    // Így az AudioContext/ScriptProcessor nem tudja elnémítani a teljes lobbyhangot.
    // A Bohóc lidérc hanghatása külön a HTMLAudioElement lejátszásán alkalmazódik.
    const remoteVoicePipelines = new Map();
    const remoteVoiceSettings = new Map();

    function remoteVoicePipelineKey(peerId, channel) {
        return `${channel}:${peerId}`;
    }

    function destroyRemoteVoicePipeline(peerId, channel = "public") {
        const key = remoteVoicePipelineKey(peerId, channel);
        const pipeline = remoteVoicePipelines.get(key);
        if (!pipeline) return;
        try { pipeline.source?.disconnect(); } catch {}
        try { pipeline.processor?.disconnect(); } catch {}
        try { pipeline.outputStream?.getTracks().forEach((track) => track.stop()); } catch {}
        remoteVoicePipelines.delete(key);
    }

    function connectRemoteAudioOutput(peerId, channel, inputStream, audio) {
        // A feldolgozott streamet kikapcsoljuk, és a WebRTC bejövő sávját
        // közvetlenül adjuk az audio elemnek. Ezzel visszaáll a stabil lobbyhang.
        destroyRemoteVoicePipeline(peerId, channel);
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = inputStream;
    }

    function getRemoteVoiceSetting(peerId) {
        if (!remoteVoiceSettings.has(peerId)) remoteVoiceSettings.set(peerId, { volume: 1, muted: false });
        return remoteVoiceSettings.get(peerId);
    }

    function applyRemoteAudioSetting(peerId, channel = "public") {
        const setting = getRemoteVoiceSetting(peerId);
        const audioId = channel === "team" ? `team-voice-audio-${peerId}` : `voice-audio-${peerId}`;
        const audio = document.getElementById(audioId);
        if (!audio) return;
        audio.volume = Math.max(0, Math.min(1, setting.volume));
        if (channel === "team") {
            audio.muted = Boolean(setting.muted);
            return;
        }
        const playerState = (currentGameVoiceState?.players || []).find((player) => player.id === peerId);
        const sabotagedMute = playerState?.voiceEffect === "mute";
        audio.muted = Boolean(setting.muted || gameVoiceLocked || sabotagedMute);
        const effect = playerState?.voiceEffect;
        if (effect === "thin" && !gameVoiceLocked) {
            audio.playbackRate = 1.35;
            if ("preservesPitch" in audio) audio.preservesPitch = false;
            if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = false;
        } else {
            audio.playbackRate = 1;
            if ("preservesPitch" in audio) audio.preservesPitch = true;
            if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
        }
    }

    function renderPlayerVoiceControls(player, scope = "lobby") {
        if (!player || player.id === socket.id) return null;
        const setting = getRemoteVoiceSetting(player.id);
        const wrapper = makeElement("div", "player-voice-controls");
        wrapper.dataset.peerId = player.id;
        wrapper.dataset.scope = scope;

        const header = makeElement("div", "player-voice-mixer-header");
        const speakerIcon = makeElement("span", "player-voice-mixer-icon", setting.muted ? "🔇" : "🔊");
        speakerIcon.setAttribute("aria-hidden", "true");
        const titleGroup = makeElement("div", "player-voice-mixer-copy");
        titleGroup.append(
            makeElement("span", "player-voice-volume-title", "HANGERŐSZABÁLYZÁS"),
            makeElement("span", "player-voice-volume-subtitle", "Csak nálad érvényes")
        );
        header.append(speakerIcon, titleGroup);

        const sliderRow = makeElement("div", "player-voice-slider-row");
        const lowMark = makeElement("span", "player-voice-volume-mark", "−");
        const input = document.createElement("input");
        input.type = "range";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.value = String(Math.round(setting.volume * 100));
        input.className = "player-voice-volume-slider";
        input.style.setProperty("--volume-fill", `${input.value}%`);
        input.setAttribute("aria-label", `${player.username} hangereje`);
        input.setAttribute("title", `${player.username} hangereje`);
        const highMark = makeElement("span", "player-voice-volume-mark", "+");
        sliderRow.append(lowMark, input, highMark);

        const muteButton = makeElement("button", `player-voice-mute-button${setting.muted ? " is-muted" : ""}`);
        muteButton.type = "button";
        muteButton.innerHTML = setting.muted
            ? '<span aria-hidden="true">🔇</span><span>Hang vissza</span>'
            : '<span aria-hidden="true">🔈</span><span>Némítás</span>';
        muteButton.setAttribute("aria-pressed", String(Boolean(setting.muted)));
        muteButton.setAttribute("aria-label", setting.muted ? `${player.username} hangjának visszakapcsolása` : `${player.username} némítása csak nálad`);
        muteButton.title = setting.muted ? "Hang visszakapcsolása" : "Játékos némítása csak nálad";

        input.addEventListener("input", () => {
            setting.volume = Number(input.value) / 100;
            input.style.setProperty("--volume-fill", `${input.value}%`);
            applyRemoteAudioSetting(player.id, "public");
            applyRemoteAudioSetting(player.id, "team");
        });
        muteButton.addEventListener("click", () => {
            setting.muted = !setting.muted;
            wrapper.classList.toggle("is-muted", setting.muted);
            speakerIcon.textContent = setting.muted ? "🔇" : "🔊";
            muteButton.innerHTML = setting.muted
                ? '<span aria-hidden="true">🔇</span><span>Hang vissza</span>'
                : '<span aria-hidden="true">🔈</span><span>Némítás</span>';
            muteButton.classList.toggle("is-muted", setting.muted);
            muteButton.setAttribute("aria-pressed", String(setting.muted));
            muteButton.setAttribute("aria-label", setting.muted ? `${player.username} hangjának visszakapcsolása` : `${player.username} némítása csak nálad`);
            muteButton.title = setting.muted ? "Hang visszakapcsolása" : "Játékos némítása csak nálad";
            applyRemoteAudioSetting(player.id, "public");
            applyRemoteAudioSetting(player.id, "team");
        });

        wrapper.classList.toggle("is-muted", setting.muted);
        wrapper.append(header, sliderRow, muteButton);
        return wrapper;
    }

    // A játékképernyő ugyanazt a helyi hangkeverő-szabályt használja.
    window.lidercRenderPlayerVoiceControls = renderPlayerVoiceControls;
    let localAudioStream = null;
    let micEnabled = false;
    let gameVoiceLocked = false;
    let gamePlayerAlive = true;
    let currentGameVoiceState = null;
    let voiceRole = null;
    let voiceTeamMembers = [];
    let teamVoicePhaseActive = false;
    let teamVoiceRole = null;
    let teamMicEnabled = false;
    let teamAudioTrack = null;
    let teamAudioStream = null;
    let speechDetection = null;

    document.getElementById("playerNameLabel").textContent = playerName;

    function setView(viewName) {
        Object.entries(views).forEach(([name, element]) => {
            element.hidden = name !== viewName;
            element.classList.toggle("is-active", name === viewName);
        });
        clearMessage();
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function showMessage(message, type = "info", timeout = 6500) {
        window.clearTimeout(messageTimeout);
        lobbyMessage.textContent = message;
        lobbyMessage.className = `lobby-message ${type}`;
        lobbyMessage.hidden = false;
        if (timeout > 0) {
            messageTimeout = window.setTimeout(() => {
                lobbyMessage.hidden = true;
            }, timeout);
        }
    }

    function clearMessage() {
        window.clearTimeout(messageTimeout);
        lobbyMessage.hidden = true;
        lobbyMessage.textContent = "";
        lobbyMessage.className = "lobby-message";
    }

    function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function totalSelectedPlayers() {
        return roleKeys.reduce((total, key) => {
            const input = document.getElementById(roleIds[key]);
            return total + (Number.parseInt(input.value, 10) || 0);
        }, 0);
    }

    function readSelectedRoles() {
        const roles = {};
        for (const key of roleKeys) {
            const value = Number.parseInt(document.getElementById(roleIds[key]).value, 10);
            roles[key] = Number.isInteger(value) ? value : 0;
        }
        return roles;
    }

    function readRoomSettings() {
        const keys = [
            "introSeconds", "daySeconds", "spiritsSeconds",
            "healerSeconds", "huntersSeconds", "foolSeconds", "swapperSeconds", "infectiousSeconds", "adventurerSeconds", "seerSeconds"
        ];
        const ids = {
            introSeconds: "settingIntroSeconds",
            daySeconds: "settingDaySeconds",
            spiritsSeconds: "settingSpiritsSeconds",
            healerSeconds: "settingHealerSeconds",
            huntersSeconds: "settingHuntersSeconds",
            foolSeconds: "settingFoolSeconds",
            swapperSeconds: "settingSwapperSeconds",
            infectiousSeconds: "settingInfectiousSeconds",
            adventurerSeconds: "settingAdventurerSeconds",
            seerSeconds: "settingSeerSeconds"
        };
        const settings = {};
        for (const key of keys) {
            const input = document.getElementById(ids[key]);
            const value = Number.parseInt(input.value, 10);
            if (!Number.isInteger(value) || value < 5 || value > 3600) {
                input.focus();
                showMessage("Minden időtartam 5 és 3600 másodperc közötti egész szám legyen.", "error");
                return null;
            }
            settings[key] = value;
        }
        return settings;
    }

    function updateRoleTotal() {
        const total = totalSelectedPlayers();
        document.getElementById("playerTotal").textContent = String(total);
        const totalDisplay = document.querySelector(".player-total");
        const hint = document.getElementById("roleHint");
        totalDisplay.classList.toggle("is-invalid", total < 4 || total > 16);
        if (total < 4) {
            hint.textContent = "Legalább 4 játékost kell beállítanod.";
            hint.classList.add("is-invalid");
        } else if (total > 16) {
            hint.textContent = "Legfeljebb 16 játékos lehet. Csökkentsd valamelyik szerepkör számát.";
            hint.classList.add("is-invalid");
        } else {
            const roles = readSelectedRoles();
            const objectiveRoles = roleKeys.filter((key) => key !== "adventurer" && roles[key] > 0);
            if (roles.spouses % 2 !== 0) {
                hint.textContent = "A Házastársak száma páros legyen: 2, 4, 6…";
                hint.classList.add("is-invalid");
            } else if (roles.adventurer > 0 && objectiveRoles.length < 3) {
                hint.textContent = "A Kalandorhoz legalább 3 különböző, beállított szerep szükséges.";
                hint.classList.add("is-invalid");
            } else {
                hint.textContent = "Legalább 4, legfeljebb 16 játékost állíts be. A Házastársak száma páros legyen; a Kalandorhoz 3 különböző szerep kell.";
                hint.classList.remove("is-invalid");
            }
        }
    }

    function renderRoomList() {
        roomList.replaceChildren();
        const searchTerm = (roomSearchInput.value || "").trim().toLocaleLowerCase("hu-HU");
        const filteredRooms = availableRooms.filter((room) =>
            room.name.toLocaleLowerCase("hu-HU").includes(searchTerm)
        );

        if (filteredRooms.length === 0) {
            const empty = makeElement("div", "empty-rooms");
            empty.append(
                makeElement("strong", "", searchTerm ? "Nincs találat" : "Jelenleg nincs elérhető szoba"),
                makeElement("p", "", searchTerm
                    ? "Próbálj másik szobanevet."
                    : "Hozz létre egy szobát, vagy kérd meg a barátodat, hogy nyisson egyet.")
            );
            roomList.appendChild(empty);
            return;
        }

        filteredRooms.forEach((room) => {
            const card = makeElement("article", "room-card");
            const top = makeElement("div", "room-card-top");
            const titleGroup = makeElement("div", "room-card-title-group");
            titleGroup.appendChild(makeElement("h3", "", room.name));
            top.append(
                titleGroup,
                makeElement("span", `room-card-count${room.playerCount >= room.capacity ? " is-full" : ""}`, `${room.playerCount} / ${room.capacity} fő`)
            );

            const host = room.players.find((player) => player.isHost);
            const hostLine = makeElement("p", "room-card-host", `Házigazda: ${host ? host.username : "Ismeretlen"}`);
            const rolesLine = makeElement("p", "room-card-roles", roleKeys
                .filter((key) => room.roles[key] > 0)
                .map((key) => `${roleLabels[key]}: ${room.roles[key]}`)
                .join(" · "));
            const bottom = makeElement("div", "room-card-bottom");
            bottom.appendChild(makeElement("span", "public-room-label", "Nyitott szoba · Jelszó nélkül"));

            const joinButton = makeElement("button", "primary-button room-join-button", room.playerCount >= room.capacity ? "MEGTELT" : "CSATLAKOZÁS →");
            joinButton.type = "button";
            joinButton.disabled = room.playerCount >= room.capacity;
            joinButton.addEventListener("click", () => {
                joinButton.disabled = true;
                joinButton.textContent = "CSATLAKOZÁS...";
                autoEnableVoiceFromUserAction();
                socket.emit("join-room", { roomId: room.code, username: playerName });
            });
            bottom.appendChild(joinButton);
            card.append(top, hostLine, rolesLine, bottom);
            roomList.appendChild(card);
        });
    }

    function renderWaitingRoom(room) {
        currentRoom = room;
        if (views.game.hidden && views.waiting.hidden) setView("waiting");

        document.getElementById("waitingRoomName").textContent = room.name;
        document.getElementById("waitingPlayersCount").textContent = `${room.playerCount} / ${room.capacity} fő`;
        document.getElementById("waitingCapacity").textContent = `${room.capacity} fő`;

        const isHost = room.hostId === socket.id;
        const self = room.players.find((player) => player.id === socket.id);
        const everyoneReady = room.players.length === room.capacity && room.players.every((player) => player.ready);
        const full = room.players.length === room.capacity;

        const playersList = document.getElementById("playersList");
        playersList.replaceChildren();
        room.players.forEach((player) => {
            const row = makeElement("div", "player-row");
            const avatar = makeElement("span", "player-avatar", player.username.slice(0, 1).toLocaleUpperCase("hu-HU"));
            const info = makeElement("div", "player-info");
            info.appendChild(makeElement("strong", "player-name", player.username));
            const detail = player.isHost ? "Házigazda" : (player.ready ? "Készen áll" : "Még nem kész");
            info.appendChild(makeElement("span", "player-position", detail));
            if (speakingPlayerIds.has(player.id)) {
                info.appendChild(makeElement("span", "player-speaking-badge", "🎙 Éppen beszél"));
            }
            const marker = makeElement("span", player.isHost ? "host-marker" : (player.ready ? "player-marker is-ready" : "player-marker"), player.isHost ? "✦" : (player.ready ? "✓" : "●"));
            row.append(avatar, info, marker);
            const voiceControls = renderPlayerVoiceControls(player, "lobby");
            if (voiceControls) row.appendChild(voiceControls);

            if (isHost && player.id !== socket.id && !room.started) {
                const controls = makeElement("div", "player-row-actions");
                const transferButton = makeElement("button", "small-control-button transfer-button", "Leader átadása");
                transferButton.type = "button";
                transferButton.title = `A házigazdai jog átadása neki: ${player.username}`;
                transferButton.addEventListener("click", () => {
                    if (window.confirm(`Átadod a házigazdai szerepet ennek a játékosnak: ${player.username}?`)) {
                        socket.emit("transfer-host", { targetId: player.id });
                    }
                });
                const kickButton = makeElement("button", "small-control-button kick-button", "Kirúgás");
                kickButton.type = "button";
                kickButton.title = `Játékos eltávolítása: ${player.username}`;
                kickButton.addEventListener("click", () => {
                    if (window.confirm(`Biztosan kirúgod a szobából ${player.username} játékost?`)) {
                        socket.emit("kick-player", { targetId: player.id });
                    }
                });
                controls.append(transferButton, kickButton);
                row.appendChild(controls);
            }
            playersList.appendChild(row);
        });

        const rolesList = document.getElementById("selectedRolesList");
        rolesList.replaceChildren();
        roleKeys.forEach((key) => {
            const row = makeElement("div", `selected-role-row ${roleClasses[key]}`);
            row.append(
                makeElement("span", "selected-role-name", roleLabels[key]),
                makeElement("strong", "selected-role-count", `${room.roles[key]} fő`)
            );
            rolesList.appendChild(row);
        });

        const readyButton = document.getElementById("readyButton");
        readyButton.disabled = room.started || !self;
        readyButton.classList.toggle("is-ready", Boolean(self && self.ready));
        readyButton.textContent = self && self.ready ? "VISSZAVONOM A KÉSZENLÉTET" : "KÉSZEN ÁLLOK";

        const startButton = document.getElementById("startGameButtonLobby");
        startButton.hidden = !isHost;
        startButton.disabled = !isHost || room.started || !full || !everyoneReady;
        startButton.textContent = room.started ? "A JÁTÉK ELINDULT" : "JÁTÉK INDÍTÁSA ✦";

        const startHint = document.getElementById("startHint");
        if (room.started) {
            startHint.textContent = "A játék már elindult.";
        } else if (!full) {
            startHint.textContent = `Még ${room.capacity - room.playerCount} játékos szükséges. A beállított szerepekhez minden helynek be kell telnie.`;
        } else if (!everyoneReady) {
            const notReadyCount = room.players.filter((player) => !player.ready).length;
            startHint.textContent = `Már minden hely betelt. Még ${notReadyCount} játékosnak készen kell állnia.`;
        } else if (isHost) {
            startHint.textContent = "Mindenki készen áll! Elindíthatod a játékot.";
        } else {
            startHint.textContent = "Mindenki készen áll. A házigazda elindíthatja a játékot.";
        }

        document.getElementById("waitingNoteText").textContent = isHost
            ? "Te vagy a házigazda. A játékoslistában átadhatod a vezetést vagy kirúghatsz valakit."
            : "A KÉSZEN ÁLLOK gombbal jelezd a házigazdának, hogy indulhattok.";

        syncVoicePeers(room);
        updateVoiceUI();
    }

    // -----------------------------------------------
    // WEBRTC VOICE CHAT
    // -----------------------------------------------

    function getPrivateTeamRole(state = currentGameVoiceState) {
        if (!state || !voiceRole) return null;
        if (state.phase === "night-seer" && ((voiceRole === "seer" && gamePlayerAlive) || !gamePlayerAlive)) {
            return Array.isArray(state.seancePeerIds) && state.seancePeerIds.length > 0 ? "seance" : null;
        }
        if (!gamePlayerAlive) return null;
        if (voiceRole === "spirits" && ["night-special-spirit", "night-spirits"].includes(state.phase)) return "spirits";
        if (voiceRole === "hunters" && state.phase === "night-hunters") return "hunters";
        if (voiceRole === "spouses" && ["night-swapper", "night-special-spirit", "night-spirits", "night-healer", "night-hunters", "night-fool", "night-infectious", "night-adventurer"].includes(state.phase)) return "spouses";
        return null;
    }

    function getLivingTeamPeerIds(state = currentGameVoiceState, role = getPrivateTeamRole(state)) {
        if (!state || !role) return [];
        if (role === "seance") {
            return (Array.isArray(state.seancePeerIds) ? state.seancePeerIds : []).filter((id) => id !== socket.id);
        }
        const livingIds = new Set((state.players || [])
            .filter((player) => player.alive && player.connected !== false)
            .map((player) => player.id));
        return voiceTeamMembers
            .filter((member) => member.id !== socket.id && livingIds.has(member.id))
            .map((member) => member.id);
    }

    function canUsePrivateTeamVoice(state = currentGameVoiceState) {
        const role = getPrivateTeamRole(state);
        return Boolean(role && getLivingTeamPeerIds(state, role).length > 0);
    }

    function updateVoiceUI() {
        const buttons = [
            document.getElementById("voiceToggleButton"),
            document.getElementById("gameVoiceToggleButton")
        ].filter(Boolean);
        const statuses = [
            document.getElementById("voiceStatus"),
            document.getElementById("gameVoiceStatus")
        ].filter(Boolean);
        const privateTeamVoice = canUsePrivateTeamVoice();
        let buttonText;
        let statusText;

        const seanceVoiceAllowed = Boolean(currentGameVoiceState?.phase === "night-seer" && privateTeamVoice);
        if (!gamePlayerAlive && !seanceVoiceAllowed) {
            buttonText = "Mikrofon letiltva";
            statusText = "Kiestél · hallgathatsz, de nem beszélhetsz";
        } else if (privateTeamVoice) {
            const activeRole = teamVoiceRole || voiceRole;
            const teamName = activeRole === "hunters" ? "Vadászok" : activeRole === "spouses" ? "Házastársak" : activeRole === "seance" ? "Látnok–halottak" : "Lidércek";
            buttonText = teamMicEnabled ? `${teamName} mikrofon némítása` : `${teamName} privát mikrofon bekapcsolása`;
            statusText = teamMicEnabled
                ? `${teamName} privát hangja aktív · csak a csapat hallja`
                : `${teamName} privát hangja némítva`;
        } else if (gameVoiceLocked) {
            buttonText = "Éjszakai csend";
            statusText = "Éjszaka · a normál voice chat automatikusan némítva";
        } else if (!localAudioStream) {
            buttonText = "Mikrofon bekapcsolása";
            statusText = "Hangkapcsolat · mikrofon nincs engedélyezve";
        } else if (micEnabled) {
            buttonText = "Mikrofon némítása";
            statusText = "Mikrofon aktív";
        } else {
            buttonText = "Mikrofon visszakapcsolása";
            statusText = "Mikrofon némítva · a többieket hallhatod";
        }

        buttons.forEach((button) => {
            button.textContent = buttonText;
            const seanceVoiceAllowed = Boolean(currentGameVoiceState?.phase === "night-seer" && privateTeamVoice);
            button.disabled = (!gamePlayerAlive && !seanceVoiceAllowed) || (gameVoiceLocked && !privateTeamVoice);
            button.classList.toggle("is-active", Boolean(
                privateTeamVoice ? teamMicEnabled : (localAudioStream && micEnabled && !gameVoiceLocked)
            ));
        });
        statuses.forEach((status) => { status.textContent = statusText; });
    }

    function applyRemoteVoiceEffects(state = currentGameVoiceState) {
        document.querySelectorAll("#remoteAudioContainer audio[id^='voice-audio-'], #remoteAudioContainer audio[id^='team-voice-audio-']").forEach((audio) => {
            const isTeam = audio.id.startsWith("team-voice-audio-");
            const peerId = audio.id.slice(isTeam ? "team-voice-audio-".length : "voice-audio-".length);
            const peerState = (state?.players || []).find((player) => player.id === peerId);
            const effect = peerState?.voiceEffect || null;
            const preference = getRemoteVoiceSetting(peerId);
            // Éjszaka a publikus csatorna néma, de a privát csapatcsatorna használható.
            // A Bohóc némítása mindkét csatornán érvényes; a hangmagasság-emelés mindkettőn feldolgozható.
            audio.muted = Boolean(preference.muted || effect === "mute" || (!isTeam && gameVoiceLocked));
            audio.volume = Math.max(0, Math.min(1, preference.volume));
            const pipeline = remoteVoicePipelines.get(remoteVoicePipelineKey(peerId, isTeam ? "team" : "public"));
            if (pipeline) {
                pipeline.pitchEnabled = effect === "thin";
                audio.playbackRate = 1;
                if ("preservesPitch" in audio) audio.preservesPitch = true;
                if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
            } else if (effect === "thin") {
                // Fallback olyan böngészőkhöz, amelyek nem tudnak Web Audio feldolgozást létrehozni.
                audio.playbackRate = 1.55;
                audio.preservesPitch = false;
                audio.webkitPreservesPitch = false;
                audio.mozPreservesPitch = false;
            } else {
                audio.playbackRate = 1;
                audio.preservesPitch = true;
                audio.webkitPreservesPitch = true;
                audio.mozPreservesPitch = true;
            }
        });
    }

    function applyGameVoiceState(state) {
        if (!state || !state.phase) return;
        const previousTeamVoicePhase = teamVoicePhaseActive;
        currentGameVoiceState = state;
        gameVoiceLocked = ["countdown", "night-swapper", "night-special-spirit", "night-spirits", "night-healer", "night-hunters", "night-fool", "night-infectious", "night-adventurer", "night-seer"].includes(state.phase);
        const me = Array.isArray(state.players) ? state.players.find((player) => player.id === socket.id) : null;
        // A kiesettek a játék végén újra beszélhetnek; a játék közben csak hallgatók.
        if (me) gamePlayerAlive = Boolean((me.alive && me.connected !== false) || state.phase === "game-over");

        const nextTeamRole = getPrivateTeamRole(state);
        const nextTeamVoicePhase = Boolean(nextTeamRole && getLivingTeamPeerIds(state, nextTeamRole).length > 0);

        if (nextTeamVoicePhase && !previousTeamVoicePhase) {
            // Ha a mikrofonengedély megvan, a lidércek privát mikrofonja automatikusan bekapcsol.
            teamMicEnabled = Boolean(localAudioStream);
            teamVoiceRole = nextTeamRole;
            teamVoicePhaseActive = true;
        } else if (!nextTeamVoicePhase && previousTeamVoicePhase) {
            teamMicEnabled = false;
            teamVoicePhaseActive = false;
            teamVoiceRole = null;
            if (speechDetection?.channel === "team") stopSpeechDetection();
            closeTeamVoiceConnections(true);
        } else {
            teamVoicePhaseActive = nextTeamVoicePhase;
            teamVoiceRole = nextTeamVoicePhase ? nextTeamRole : null;
        }

        // Ha már kaptunk mikrofonengedélyt, a külön csapatsávot azelőtt klónozzuk,
        // hogy a mindenki felé menő normál sávot éjszakára elnémítanánk.
        if (teamVoicePhaseActive && localAudioStream && !teamAudioTrack) createTeamAudioTrack();
        if (teamVoicePhaseActive && localAudioStream) {
            teamMicEnabled = true;
            if (teamAudioTrack) teamAudioTrack.enabled = Boolean(canTransmitTeamVoice(state));
        }
        const seanceVoiceAllowed = Boolean(state.phase === "night-seer" && teamVoicePhaseActive && getPrivateTeamRole(state) === "seance");
        const muted = gameVoiceLocked || (!gamePlayerAlive && !seanceVoiceAllowed) || teamVoicePhaseActive;
        if (localAudioStream) {
            localAudioStream.getAudioTracks().forEach((track) => { track.enabled = Boolean(micEnabled && !muted); });
        }
        // A normál hangcsatorna éjszaka némítva marad. A csapatnak külön WebRTC-kapcsolata van.
        applyRemoteVoiceEffects(state);
        if (teamVoicePhaseActive) {
            syncTeamVoicePeers();
            if (!localAudioStream) {
                ensureLocalAudio().then(() => {
                    micEnabled = true;
                    teamMicEnabled = true;
                    if (teamVoicePhaseActive) {
                        createTeamAudioTrack();
                        if (teamAudioTrack) teamAudioTrack.enabled = Boolean(canTransmitTeamVoice(currentGameVoiceState));
                        syncTeamVoicePeers();
                    }
                    if (currentRoom) syncVoicePeers(currentRoom);
                    refreshSpeechDetection();
                    updateVoiceUI();
                }).catch((error) => {
                    showMessage("A privát lidérchanghoz engedélyezd a mikrofont a böngészőben.", "error", 9000);
                    console.warn(error);
                });
            }
        }
        refreshSpeechDetection();
        updateVoiceUI();
    }

    async function ensureLocalAudio() {
        if (localAudioStream) return localAudioStream;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("A böngésző itt nem engedélyezi a mikrofont. Használj localhostot vagy HTTPS-kapcsolatot.");
        }
        localAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        micEnabled = true;
        return localAudioStream;
    }

    async function autoEnableVoiceFromUserAction() {
        try {
            await ensureLocalAudio();
            micEnabled = true;
            localAudioStream?.getAudioTracks().forEach((track) => {
                track.enabled = Boolean(!gameVoiceLocked && gamePlayerAlive && !teamVoicePhaseActive);
            });
            if (currentRoom) syncVoicePeers(currentRoom);
            if (currentGameVoiceState) applyGameVoiceState(currentGameVoiceState);
            refreshSpeechDetection();
            updateVoiceUI();
        } catch (error) {
            // A szobába belépés mikrofonengedély nélkül is működjön.
            showMessage("A szobába beléptél, de a mikrofon nem kapott engedélyt. A böngésző címsoránál engedélyezd a mikrofont.", "info", 9000);
            console.warn("Automatikus mikrofonengedély nem sikerült:", error);
        }
    }

    function signalPeer(peerId, data) {
        if (socket.connected && currentRoom) {
            socket.emit("voice-signal", { to: peerId, data });
        }
    }

    function ensureVoicePeer(peerId) {
        if (!peerId || peerId === socket.id) return null;
        if (voicePeers.has(peerId)) return voicePeers.get(peerId);

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        const record = {
            pc,
            polite: String(socket.id).localeCompare(String(peerId)) > 0,
            makingOffer: false,
            ignoreOffer: false,
            settingRemoteAnswerPending: false,
            pendingCandidates: []
        };
        voicePeers.set(peerId, record);

        pc.onicecandidate = (event) => {
            if (event.candidate) signalPeer(peerId, { candidate: event.candidate });
        };

        pc.ontrack = (event) => {
            let audio = document.getElementById(`voice-audio-${peerId}`);
            if (!audio) {
                audio = document.createElement("audio");
                audio.id = `voice-audio-${peerId}`;
                audio.autoplay = true;
                audio.playsInline = true;
                audio.setAttribute("aria-label", "Másik játékos hangja");
                document.getElementById("remoteAudioContainer").appendChild(audio);
            }
            const incomingStream = event.streams?.[0] || new MediaStream([event.track]);
            connectRemoteAudioOutput(peerId, "public", incomingStream, audio);
            applyRemoteVoiceEffects(currentGameVoiceState);
            audio.play().catch(() => {
                showMessage("A hang lejátszását a böngésző letiltotta. Kattints az oldalra, majd engedélyezd a hangot.", "info");
            });
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed") {
                showMessage("Egy hangkapcsolat nem jött létre. Más hálózaton TURN-szerverre is szükség lehet.", "error");
            }
        };

        pc.onnegotiationneeded = async () => {
            try {
                record.makingOffer = true;
                await pc.setLocalDescription();
                signalPeer(peerId, { description: pc.localDescription });
            } catch (error) {
                console.warn("A hangkapcsolat egyeztetése nem sikerült:", error);
            } finally {
                record.makingOffer = false;
            }
        };

        // Fogadó audio sáv már mikrofonengedély előtt is létrejön.
        pc.addTransceiver("audio", { direction: localAudioStream ? "sendrecv" : "recvonly" });
        if (localAudioStream) attachLocalAudio(pc).catch((error) => console.warn(error));
        return record;
    }

    async function attachLocalAudio(pc) {
        if (!localAudioStream) return;
        const audioTrack = localAudioStream.getAudioTracks()[0];
        if (!audioTrack) return;

        let transceiver = pc.getTransceivers().find((item) => item.receiver && item.receiver.track && item.receiver.track.kind === "audio");
        if (!transceiver) transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
        await transceiver.sender.replaceTrack(audioTrack);
        transceiver.direction = "sendrecv";
    }

    function signalTeamPeer(peerId, data) {
        if (socket.connected && currentRoom) socket.emit("team-voice-signal", { to: peerId, data });
    }

    function canTransmitTeamVoice(state = currentGameVoiceState) {
        return Boolean(gamePlayerAlive || (state?.phase === "night-seer" && getPrivateTeamRole(state) === "seance"));
    }

    function createTeamAudioTrack() {
        if (!localAudioStream || teamAudioTrack) return teamAudioTrack;
        const original = localAudioStream.getAudioTracks()[0];
        if (!original || typeof original.clone !== "function") return null;
        const wasEnabled = original.enabled;
        // A klónozáskor röviden legyen aktív a forrássáv; utána azonnal visszaállítjuk.
        // A klónozott sáv ezután külön némítható, nem szivárog át a normál hangcsatornába.
        if (!wasEnabled) original.enabled = true;
        teamAudioTrack = original.clone();
        original.enabled = wasEnabled;
        teamAudioTrack.enabled = Boolean(teamMicEnabled && teamVoicePhaseActive && canTransmitTeamVoice());
        teamAudioStream = new MediaStream([teamAudioTrack]);
        return teamAudioTrack;
    }

    async function attachTeamAudio(pc) {
        if (!teamAudioTrack) return;
        let transceiver = pc.getTransceivers().find((item) => item.receiver && item.receiver.track && item.receiver.track.kind === "audio");
        if (!transceiver) transceiver = pc.addTransceiver(teamAudioTrack, { direction: "sendrecv", streams: [teamAudioStream] });
        else {
            await transceiver.sender.replaceTrack(teamAudioTrack);
            if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
        }
    }

    function ensureTeamVoicePeer(peerId) {
        if (!peerId || peerId === socket.id) return null;
        if (teamVoicePeers.has(peerId)) return teamVoicePeers.get(peerId);
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        const record = {
            pc,
            polite: String(socket.id).localeCompare(String(peerId)) > 0,
            makingOffer: false,
            ignoreOffer: false,
            settingRemoteAnswerPending: false,
            pendingCandidates: []
        };
        teamVoicePeers.set(peerId, record);
        pc.onicecandidate = (event) => {
            if (event.candidate) signalTeamPeer(peerId, { candidate: event.candidate });
        };
        pc.ontrack = (event) => {
            const container = document.getElementById("remoteAudioContainer");
            if (!container) return;
            let audio = document.getElementById(`team-voice-audio-${peerId}`);
            if (!audio) {
                audio = document.createElement("audio");
                audio.id = `team-voice-audio-${peerId}`;
                audio.autoplay = true;
                audio.playsInline = true;
                audio.setAttribute("aria-label", "Titkos csapattárs hangja");
                container.appendChild(audio);
            }
            const incomingStream = event.streams?.[0] || new MediaStream([event.track]);
            connectRemoteAudioOutput(peerId, "team", incomingStream, audio);
            applyRemoteAudioSetting(peerId, "team");
            applyRemoteVoiceEffects(currentGameVoiceState);
            audio.play().catch(() => showMessage("A privát csapathang lejátszásához kattints az oldalra, majd engedélyezd a hangot.", "info"));
        };
        pc.onnegotiationneeded = async () => {
            try {
                record.makingOffer = true;
                await pc.setLocalDescription();
                signalTeamPeer(peerId, { description: pc.localDescription });
            } catch (error) {
                console.warn("A privát csapathang egyeztetése nem sikerült:", error);
            } finally {
                record.makingOffer = false;
            }
        };
        pc.addTransceiver("audio", { direction: teamAudioTrack ? "sendrecv" : "recvonly" });
        if (teamAudioTrack) attachTeamAudio(pc).catch((error) => console.warn(error));
        return record;
    }

    function syncTeamVoicePeers() {
        if (!window.RTCPeerConnection || !teamVoicePhaseActive || !currentRoom || !currentGameVoiceState) return;
        const expectedIds = new Set(getLivingTeamPeerIds(currentGameVoiceState, teamVoiceRole));
        for (const [peerId, record] of teamVoicePeers.entries()) {
            if (!expectedIds.has(peerId)) {
                record.pc.close();
                teamVoicePeers.delete(peerId);
                destroyRemoteVoicePipeline(peerId, "team");
                document.getElementById(`team-voice-audio-${peerId}`)?.remove();
            }
        }
        expectedIds.forEach((peerId) => {
            const record = ensureTeamVoicePeer(peerId);
            if (record && teamAudioTrack) attachTeamAudio(record.pc).catch((error) => console.warn(error));
        });
    }

    async function handleTeamVoiceSignal({ from, data } = {}) {
        const allowedTeamIds = teamVoiceRole === "seance"
            ? (Array.isArray(currentGameVoiceState?.seancePeerIds) ? currentGameVoiceState.seancePeerIds : [])
            : voiceTeamMembers.map((member) => member.id);
        if (!from || !data || !teamVoicePhaseActive || !allowedTeamIds.includes(from)) return;
        const record = ensureTeamVoicePeer(from);
        if (!record) return;
        const pc = record.pc;
        try {
            if (data.description) {
                const description = data.description;
                const readyForOffer = !record.makingOffer && (pc.signalingState === "stable" || record.settingRemoteAnswerPending);
                const offerCollision = description.type === "offer" && !readyForOffer;
                record.ignoreOffer = !record.polite && offerCollision;
                if (record.ignoreOffer) return;
                record.settingRemoteAnswerPending = description.type === "answer";
                if (offerCollision) {
                    await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(description)]);
                } else {
                    await pc.setRemoteDescription(description);
                }
                record.settingRemoteAnswerPending = false;
                while (record.pendingCandidates.length > 0) {
                    const candidate = record.pendingCandidates.shift();
                    try { await pc.addIceCandidate(candidate); } catch (candidateError) { console.warn("Privát ICE jelölt hiba:", candidateError); }
                }
                if (description.type === "offer") {
                    await pc.setLocalDescription();
                    signalTeamPeer(from, { description: pc.localDescription });
                }
            } else if (data.candidate) {
                if (!pc.remoteDescription) record.pendingCandidates.push(data.candidate);
                else {
                    try { await pc.addIceCandidate(data.candidate); }
                    catch (error) { if (!record.ignoreOffer) throw error; }
                }
            }
        } catch (error) {
            console.warn("A privát csapathang jelzésének feldolgozása sikertelen:", error);
        }
    }

    function closeTeamVoiceConnections(stopTrack = false) {
        for (const [peerId, record] of teamVoicePeers.entries()) {
            record.pc.close();
            destroyRemoteVoicePipeline(peerId, "team");
            document.getElementById(`team-voice-audio-${peerId}`)?.remove();
        }
        teamVoicePeers.clear();
        if (stopTrack && teamAudioTrack) {
            teamAudioTrack.stop();
            teamAudioTrack = null;
            teamAudioStream = null;
        }
    }

    function emitSpeaking(channel, isSpeaking) {
        if (!socket.connected) return;
        socket.emit(channel === "team" ? "team-voice-speaking" : "voice-speaking", { speaking: Boolean(isSpeaking) });
    }

    function stopSpeechDetection() {
        if (!speechDetection) return;
        const detector = speechDetection;
        speechDetection = null;
        if (detector.raf) cancelAnimationFrame(detector.raf);
        if (detector.speaking) emitSpeaking(detector.channel, false);
        try { detector.source.disconnect(); } catch {}
        try { detector.analyser.disconnect(); } catch {}
        if (detector.context && detector.context.state !== "closed") detector.context.close().catch(() => {});
    }

    function startSpeechDetection(stream, channel) {
        if (!stream) return;
        if (speechDetection && speechDetection.stream === stream && speechDetection.channel === channel) return;
        stopSpeechDetection();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            const context = new AudioContextClass();
            const source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.35;
            source.connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            const detector = { stream, channel, context, source, analyser, samples, raf: 0, speaking: false, above: 0, below: 0 };
            speechDetection = detector;
            const tick = () => {
                if (speechDetection !== detector) return;
                analyser.getByteTimeDomainData(samples);
                let total = 0;
                for (let i = 0; i < samples.length; i++) {
                    const value = (samples[i] - 128) / 128;
                    total += value * value;
                }
                const rms = Math.sqrt(total / samples.length);
                const tracksEnabled = stream.getAudioTracks().some((track) => track.enabled && track.readyState === "live");
                const voice = tracksEnabled && rms > 0.035;
                if (voice) { detector.above += 1; detector.below = 0; }
                else { detector.below += 1; detector.above = 0; }
                if (!detector.speaking && detector.above >= 3) {
                    detector.speaking = true;
                    emitSpeaking(channel, true);
                } else if (detector.speaking && detector.below >= 10) {
                    detector.speaking = false;
                    emitSpeaking(channel, false);
                }
                detector.raf = requestAnimationFrame(tick);
            };
            detector.raf = requestAnimationFrame(tick);
            context.resume().catch(() => {});
        } catch (error) {
            console.warn("A beszédjelzés nem indítható el:", error);
        }
    }

    function refreshSpeechDetection() {
        if (teamVoicePhaseActive && teamMicEnabled && teamAudioStream && teamAudioTrack?.enabled) {
            startSpeechDetection(teamAudioStream, "team");
            return;
        }
        const publicTrackEnabled = localAudioStream && localAudioStream.getAudioTracks().some((track) => track.enabled && track.readyState === "live");
        const gameOver = currentGameVoiceState?.phase === "game-over";
        if (!gameVoiceLocked && (gamePlayerAlive || gameOver) && micEnabled && publicTrackEnabled) {
            startSpeechDetection(localAudioStream, "public");
            return;
        }
        stopSpeechDetection();
    }

    function syncVoicePeers(room) {
        if (!window.RTCPeerConnection || !room) return;
        const expectedIds = new Set(room.players.map((player) => player.id).filter((id) => id !== socket.id));

        for (const [peerId, record] of voicePeers.entries()) {
            if (!expectedIds.has(peerId)) {
                record.pc.close();
                voicePeers.delete(peerId);
                destroyRemoteVoicePipeline(peerId, "public");
                const audio = document.getElementById(`voice-audio-${peerId}`);
                if (audio) audio.remove();
            }
        }

        expectedIds.forEach((peerId) => {
            const record = ensureVoicePeer(peerId);
            if (record && localAudioStream) attachLocalAudio(record.pc).catch((error) => console.warn(error));
        });
    }

    async function toggleVoice() {
        const button = document.getElementById("voiceToggleButton");
        const privateTeamVoice = canUsePrivateTeamVoice();
        if (gameVoiceLocked && !privateTeamVoice) {
            showMessage("Éjszaka a normál voice chat automatikusan kikapcsol.", "info");
            return;
        }
        const seanceVoiceAllowed = Boolean(currentGameVoiceState?.phase === "night-seer" && privateTeamVoice && teamVoiceRole === "seance");
        if (!gamePlayerAlive && currentGameVoiceState?.phase !== "game-over" && !seanceVoiceAllowed) {
            showMessage("Kiesett játékosként csak a Látnok szeánsza alatt válaszolhatsz hanggal; máskor hallgató maradsz.", "info");
            return;
        }
        if (button) button.disabled = true;
        try {
            if (privateTeamVoice) {
                const publicMicPreference = micEnabled;
                if (!localAudioStream) {
                    await ensureLocalAudio();
                    // A mikrofonengedély megszerzése nem kapcsolja be automatikusan a nappali mikrofont.
                    micEnabled = publicMicPreference;
                }
                if (!teamAudioTrack) createTeamAudioTrack();
                teamMicEnabled = !teamMicEnabled;
                if (teamAudioTrack) teamAudioTrack.enabled = Boolean(teamMicEnabled && teamVoicePhaseActive && canTransmitTeamVoice(currentGameVoiceState));
                // A normál, mindenki számára elérhető mikrofoncsatorna éjszaka némítva marad.
                localAudioStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
                syncTeamVoicePeers();
                if (teamMicEnabled) showMessage(teamVoiceRole === "seance" ? "A Látnok–halottak privát hangja bekapcsolt. Csak a szeánsz résztvevői hallanak." : "A privát csapathang bekapcsolt. Csak a csapattársaid hallanak.", "success");
            } else if (!localAudioStream) {
                await ensureLocalAudio();
                if (currentRoom) syncVoicePeers(currentRoom);
                showMessage("A mikrofon bekapcsolt. Ha a böngésző kérte, engedélyezd a mikrofon használatát.", "success");
            } else {
                micEnabled = !micEnabled;
                localAudioStream.getAudioTracks().forEach((track) => { track.enabled = Boolean(micEnabled && !gameVoiceLocked && gamePlayerAlive); });
            }
        } catch (error) {
            showMessage(error && error.message ? error.message : "Nem sikerült bekapcsolni a mikrofont.", "error");
        } finally {
            if (button) button.disabled = false;
            refreshSpeechDetection();
            updateVoiceUI();
        }
    }

    window.lidercVoiceToggle = toggleVoice;

    async function handleVoiceSignal({ from, data } = {}) {
        if (!from || !data || !currentRoom || !currentRoom.players.some((player) => player.id === from)) return;
        const record = ensureVoicePeer(from);
        if (!record) return;
        const pc = record.pc;

        try {
            if (data.description) {
                const description = data.description;
                const readyForOffer = !record.makingOffer &&
                    (pc.signalingState === "stable" || record.settingRemoteAnswerPending);
                const offerCollision = description.type === "offer" && !readyForOffer;
                record.ignoreOffer = !record.polite && offerCollision;
                if (record.ignoreOffer) return;

                record.settingRemoteAnswerPending = description.type === "answer";
                if (offerCollision) {
                    await Promise.all([
                        pc.setLocalDescription({ type: "rollback" }),
                        pc.setRemoteDescription(description)
                    ]);
                } else {
                    await pc.setRemoteDescription(description);
                }
                record.settingRemoteAnswerPending = false;
                while (record.pendingCandidates.length > 0) {
                    const candidate = record.pendingCandidates.shift();
                    try { await pc.addIceCandidate(candidate); } catch (candidateError) { console.warn("ICE jelölt hiba:", candidateError); }
                }

                if (description.type === "offer") {
                    await pc.setLocalDescription();
                    signalPeer(from, { description: pc.localDescription });
                }
            } else if (data.candidate) {
                if (!pc.remoteDescription) {
                    record.pendingCandidates.push(data.candidate);
                } else {
                    try {
                        await pc.addIceCandidate(data.candidate);
                    } catch (error) {
                        if (!record.ignoreOffer) throw error;
                    }
                }
            }
        } catch (error) {
            console.warn("A bejövő hangjelzés feldolgozása nem sikerült:", error);
        }
    }

    function closeVoiceConnections(stopStream = false) {
        for (const [peerId, record] of voicePeers.entries()) {
            record.pc.close();
            destroyRemoteVoicePipeline(peerId, "public");
            const audio = document.getElementById(`voice-audio-${peerId}`);
            if (audio) audio.remove();
        }
        voicePeers.clear();
        if (stopStream && localAudioStream) {
            localAudioStream.getTracks().forEach((track) => track.stop());
            localAudioStream = null;
            micEnabled = false;
        }
        updateVoiceUI();
    }

    function resetPrivateVoiceContext() {
        stopSpeechDetection();
        closeTeamVoiceConnections(true);
        currentGameVoiceState = null;
        voiceRole = null;
        voiceTeamMembers = [];
        teamVoicePhaseActive = false;
        teamVoiceRole = null;
        teamMicEnabled = false;
        speakingPlayerIds.clear();
    }

    // -----------------------------------------------
    // FELÜLETI ESEMÉNYEK
    // -----------------------------------------------

    document.getElementById("showCreateViewButton").addEventListener("click", () => {
        setView("create");
        updateRoleTotal();
        document.getElementById("roomNameInput").focus();
    });
    document.getElementById("showSearchViewButton").addEventListener("click", () => {
        setView("search");
        socket.emit("request-rooms");
        roomSearchInput.focus();
    });
    document.getElementById("backFromCreateButton").addEventListener("click", () => setView("home"));
    document.getElementById("backFromSearchButton").addEventListener("click", () => setView("home"));

    document.querySelectorAll(".number-control button[data-target]").forEach((button) => {
        button.addEventListener("click", () => {
            const input = document.getElementById(button.dataset.target);
            let step = Number(button.dataset.step);
            const current = Number.parseInt(input.value, 10) || 0;
            if (input.id === "roleSpouses") step *= 2;
            input.value = String(Math.max(0, Math.min(16, current + step)));
            updateRoleTotal();
        });
    });
    roleKeys.forEach((key) => {
        const input = document.getElementById(roleIds[key]);
        input.addEventListener("input", updateRoleTotal);
        input.addEventListener("change", () => {
            const value = Number.parseInt(input.value, 10);
            input.value = String(Number.isInteger(value) ? Math.max(0, Math.min(16, value)) : 0);
            updateRoleTotal();
        });
    });

    document.getElementById("createRoomForm").addEventListener("submit", (event) => {
        event.preventDefault();
        clearMessage();

        const roomName = document.getElementById("roomNameInput").value.trim();
        const roles = readSelectedRoles();
        const settings = readRoomSettings();
        if (!settings) return;
        const total = roleKeys.reduce((sum, key) => sum + roles[key], 0);

        if (roomName.length < 3 || roomName.length > 24) {
            showMessage("A szoba neve 3–24 karakter hosszú legyen.", "error");
            document.getElementById("roomNameInput").focus();
            return;
        }
        if (total < 4 || total > 16) {
            showMessage("A szerepkörök összege legalább 4, legfeljebb 16 játékos legyen.", "error");
            return;
        }
        if (roles.spouses % 2 !== 0) {
            showMessage("A Házastársak számát párosan állítsd be: 2, 4, 6…", "error");
            return;
        }
        if (roles.adventurer > 0 && roleKeys.filter((key) => key !== "adventurer" && roles[key] > 0).length < 3) {
            showMessage("A Kalandorhoz legalább három különböző, beállított szerepkörre van szükség.", "error");
            return;
        }

        const submit = document.getElementById("createRoomSubmit");
        submit.disabled = true;
        submit.textContent = "SZOBA KÉSZÍTÉSE...";
        autoEnableVoiceFromUserAction();
        socket.emit("create-room", { roomName, roles, settings, username: playerName });
        window.setTimeout(() => {
            if (submit.isConnected) {
                submit.disabled = false;
                submit.innerHTML = 'SZOBÁM LÉTREHOZÁSA <span aria-hidden="true">✦</span>';
            }
        }, 3000);
    });

    roomSearchInput.addEventListener("input", renderRoomList);
    document.getElementById("refreshRoomsButton").addEventListener("click", () => {
        socket.emit("request-rooms");
        showMessage("Szobalista frissítése...", "info");
    });

    document.getElementById("leaveRoomButton").addEventListener("click", () => {
        stopSpeechDetection();
        closeTeamVoiceConnections(true);
        closeVoiceConnections(true);
        socket.emit("leave-room");
    });

    document.getElementById("readyButton").addEventListener("click", () => {
        if (!currentRoom) return;
        const self = currentRoom.players.find((player) => player.id === socket.id);
        socket.emit("toggle-ready", { ready: !(self && self.ready) });
    });

    document.getElementById("startGameButtonLobby").addEventListener("click", () => {
        if (!currentRoom) return;
        socket.emit("start-game");
    });

    document.getElementById("voiceToggleButton").addEventListener("click", toggleVoice);


    // -----------------------------------------------
    // SOCKET.IO VÁLASZOK
    // -----------------------------------------------

    socket.on("connect", () => {
        document.getElementById("connectionIndicator").classList.add("is-connected");
        document.getElementById("connectionLabel").textContent = "Szerverhez kapcsolódva";
        socket.emit("request-rooms");
        socket.emit("check-name", playerName, (result) => {
            if (!result || !result.ok) {
                showMessage(result?.message || "Ellenőrizd a játékosnevedet.", "error", 0);
            }
        });
    });

    socket.on("disconnect", () => {
        document.getElementById("connectionIndicator").classList.remove("is-connected");
        document.getElementById("connectionLabel").textContent = "Kapcsolat megszakadt";
        showMessage("Megszakadt a kapcsolat a szerverrel. A böngésző megpróbál újracsatlakozni.", "error", 0);
        gameVoiceLocked = false;
        gamePlayerAlive = true;
        resetPrivateVoiceContext();
        closeVoiceConnections(true);
        if (currentRoom) {
            currentRoom = null;
            setView("home");
            showMessage("A kapcsolat megszakadt, ezért kiléptél a szobából. Csatlakozz újra.", "error", 0);
        }
    });

    socket.on("connect_error", () => {
        document.getElementById("connectionIndicator").classList.remove("is-connected");
        document.getElementById("connectionLabel").textContent = "Nem érhető el a szerver";
    });

    socket.on("rooms-list", (rooms) => {
        availableRooms = Array.isArray(rooms) ? rooms : [];
        if (!views.search.hidden) renderRoomList();
    });

    socket.on("room-joined", (room) => {
        renderWaitingRoom(room);
        showMessage(`Sikeresen beléptél a(z) „${room.name}” szobába.`, "success");
    });

    socket.on("room-updated", (room) => {
        if (currentRoom && currentRoom.code === room.code) renderWaitingRoom(room);
    });

    socket.on("return-to-waiting-room", (payload = {}) => {
        if (!payload.room) return;
        stopSpeechDetection();
        closeTeamVoiceConnections(true);
        currentGameVoiceState = null;
        voiceRole = null;
        voiceTeamMembers = [];
        speakingPlayerIds.clear();
        teamVoicePhaseActive = false;
        teamVoiceRole = null;
        teamMicEnabled = false;
        currentRoom = payload.room;
        gameVoiceLocked = false;
        gamePlayerAlive = true;
        setView("waiting");
        renderWaitingRoom(payload.room);
        showMessage(payload.message || "A szoba készen áll az új menetre.", "success", 9000);
        updateVoiceUI();
    });

    socket.on("left-room", () => {
        currentRoom = null;
        gameVoiceLocked = false;
        gamePlayerAlive = true;
        resetPrivateVoiceContext();
        closeVoiceConnections(true);
        setView("home");
        showMessage("Kiléptél a szobából.", "success");
    });

    socket.on("kicked-from-room", (details = {}) => {
        currentRoom = null;
        gameVoiceLocked = false;
        gamePlayerAlive = true;
        resetPrivateVoiceContext();
        closeVoiceConnections(true);
        setView("home");
        showMessage(`A házigazda eltávolított a(z) „${details.roomName || ""}” szobából.`, "error");
    });

    socket.on("room-error", (message) => {
        showMessage(message, "error");
        const submit = document.getElementById("createRoomSubmit");
        submit.disabled = false;
        submit.innerHTML = 'SZOBÁM LÉTREHOZÁSA <span aria-hidden="true">✦</span>';
        if (!views.search.hidden) renderRoomList();
    });

    socket.on("game-state", applyGameVoiceState);

    socket.on("game-started", (payload = {}) => {
        if (payload.room) currentRoom = payload.room;
        currentGameVoiceState = null;
        voiceRole = null;
        voiceTeamMembers = [];
        teamVoicePhaseActive = false;
        teamVoiceRole = null;
        teamMicEnabled = false;
        closeTeamVoiceConnections(true);
        speakingPlayerIds.clear();
        document.getElementById("gameStartedRoomName").textContent = payload.room?.name || currentRoom?.name || "A játék elkezdődött";
        setView("game");
        showMessage("A házigazda elindította a játékot!", "success");
    });

    socket.on("private-role", (payload = {}) => {
        voiceRole = payload.role || null;
        voiceTeamMembers = Array.isArray(payload.teamMembers) ? payload.teamMembers : [];
        if (currentGameVoiceState) applyGameVoiceState(currentGameVoiceState);
    });

    socket.on("team-voice-signal", handleTeamVoiceSignal);

    socket.on("player-speaking", (payload = {}) => {
        if (!payload.playerId) return;
        if (payload.speaking) speakingPlayerIds.add(payload.playerId);
        else speakingPlayerIds.delete(payload.playerId);
        if (currentRoom && !views.waiting.hidden) renderWaitingRoom(currentRoom);
        if (currentGameVoiceState && !views.game.hidden && window.lidercGameRefreshPlayers) window.lidercGameRefreshPlayers();
    });

    socket.on("voice-signal", handleVoiceSignal);

    updateRoleTotal();
    updateVoiceUI();
})();
