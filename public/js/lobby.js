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

    const roleKeys = ["spirits", "healer", "villagers", "hunters", "fool"];
    const roleLabels = {
        spirits: "Lidércek",
        healer: "Gyógyító",
        villagers: "Falusiak",
        hunters: "Vadászok",
        fool: "Bolondok"
    };
    const roleIds = {
        spirits: "roleSpirits",
        healer: "roleHealer",
        villagers: "roleVillagers",
        hunters: "roleHunters",
        fool: "roleFool"
    };
    const roleClasses = {
        spirits: "role-color-spirits",
        healer: "role-color-healer",
        villagers: "role-color-villagers",
        hunters: "role-color-hunters",
        fool: "role-color-fool"
    };

    let currentRoom = null;
    let availableRooms = [];
    let messageTimeout = null;

    // WebRTC hangkapcsolatok. A hanghoz a böngésző mikrofonengedélye szükséges.
    const voicePeers = new Map();
    let localAudioStream = null;
    let micEnabled = false;
    let gameVoiceLocked = false;
    let gamePlayerAlive = true;

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
            "healerSeconds", "huntersSeconds", "foolSeconds"
        ];
        const ids = {
            introSeconds: "settingIntroSeconds",
            daySeconds: "settingDaySeconds",
            spiritsSeconds: "settingSpiritsSeconds",
            healerSeconds: "settingHealerSeconds",
            huntersSeconds: "settingHuntersSeconds",
            foolSeconds: "settingFoolSeconds"
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
            hint.textContent = "Legalább 4, legfeljebb 16 játékost állíts be. A játék akkor indulhat, ha minden férőhely betelt és mindenki készen áll.";
            hint.classList.remove("is-invalid");
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
            const marker = makeElement("span", player.isHost ? "host-marker" : (player.ready ? "player-marker is-ready" : "player-marker"), player.isHost ? "✦" : (player.ready ? "✓" : "●"));
            row.append(avatar, info, marker);

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

    function updateVoiceUI() {
        const buttons = [
            document.getElementById("voiceToggleButton"),
            document.getElementById("gameVoiceToggleButton")
        ].filter(Boolean);
        const statuses = [
            document.getElementById("voiceStatus"),
            document.getElementById("gameVoiceStatus")
        ].filter(Boolean);
        const locked = gameVoiceLocked || !gamePlayerAlive;
        let buttonText;
        let statusText;

        if (!gamePlayerAlive) {
            buttonText = "Mikrofon letiltva";
            statusText = "Kiestél · a mikrofonod le van tiltva";
        } else if (gameVoiceLocked) {
            buttonText = "Éjszakai csend";
            statusText = "Éjszaka · a voice chat automatikusan némítva";
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
            button.disabled = locked;
            button.classList.toggle("is-active", Boolean(localAudioStream && micEnabled && !locked));
        });
        statuses.forEach((status) => { status.textContent = statusText; });
    }

    function applyGameVoiceState(state) {
        if (!state || !state.phase) return;
        gameVoiceLocked = ["countdown", "night-spirits", "night-healer", "night-hunters", "night-fool"].includes(state.phase);
        const me = Array.isArray(state.players) ? state.players.find((player) => player.id === socket.id) : null;
        if (me) gamePlayerAlive = Boolean(me.alive && me.connected !== false);
        const muted = gameVoiceLocked || !gamePlayerAlive;
        if (localAudioStream) {
            localAudioStream.getAudioTracks().forEach((track) => { track.enabled = Boolean(micEnabled && !muted); });
        }
        // A kiesett játékos nem beszélhet, de nappal továbbra is hallhatja az élőket.
        document.querySelectorAll("#remoteAudioContainer audio").forEach((audio) => {
            audio.muted = gameVoiceLocked;
            audio.volume = gameVoiceLocked ? 0 : 1;
        });
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
            if (event.streams && event.streams[0]) {
                audio.srcObject = event.streams[0];
            } else {
                audio.srcObject = new MediaStream([event.track]);
            }
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

    function syncVoicePeers(room) {
        if (!window.RTCPeerConnection || !room) return;
        const expectedIds = new Set(room.players.map((player) => player.id).filter((id) => id !== socket.id));

        for (const [peerId, record] of voicePeers.entries()) {
            if (!expectedIds.has(peerId)) {
                record.pc.close();
                voicePeers.delete(peerId);
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
        if (gameVoiceLocked) {
            showMessage("Éjszaka a voice chat automatikusan kikapcsol. Használd a szereped privát szöveges csatornáját, ha elérhető.", "info");
            return;
        }
        if (!gamePlayerAlive) {
            showMessage("Kiesett játékosként a mikrofonod nem kapcsolható vissza.", "info");
            return;
        }
        if (button) button.disabled = true;
        try {
            if (!localAudioStream) {
                await ensureLocalAudio();
                if (currentRoom) syncVoicePeers(currentRoom);
                showMessage("A mikrofon bekapcsolt. Ha kérte a böngésző, engedélyezd a mikrofon használatát.", "success");
            } else {
                micEnabled = !micEnabled;
                localAudioStream.getAudioTracks().forEach((track) => { track.enabled = Boolean(micEnabled && !gameVoiceLocked && gamePlayerAlive); });
            }
        } catch (error) {
            showMessage(error && error.message ? error.message : "Nem sikerült bekapcsolni a mikrofont.", "error");
        } finally {
            if (button) button.disabled = false;
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
            const step = Number(button.dataset.step);
            const current = Number.parseInt(input.value, 10) || 0;
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

        const submit = document.getElementById("createRoomSubmit");
        submit.disabled = true;
        submit.textContent = "SZOBA KÉSZÍTÉSE...";
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
        closeVoiceConnections(true);
        setView("home");
        showMessage("Kiléptél a szobából.", "success");
    });

    socket.on("kicked-from-room", (details = {}) => {
        currentRoom = null;
        gameVoiceLocked = false;
        gamePlayerAlive = true;
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
        document.getElementById("gameStartedRoomName").textContent = payload.room?.name || currentRoom?.name || "A játék elkezdődött";
        setView("game");
        showMessage("A házigazda elindította a játékot!", "success");
    });

    socket.on("voice-signal", handleVoiceSignal);

    updateRoleTotal();
    updateVoiceUI();
})();
