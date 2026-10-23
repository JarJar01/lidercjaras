(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const screen = $("k-lobby-screen");
    const scene = document.querySelector(".k-scene");
    const socket = window.kiiszikSocket || null;
    const titleScreen = document.querySelector(".k-center");
    const settingsButton = $("k-settings-button");

    if (!screen || !scene || !titleScreen) {
        console.error("[Kiiszik lobby] Hiányzó fő lobby-elem.");
        return;
    }

    const ui = {
        backMain: $("lobby-back-main"),
        connection: $("lobby-connection-status"),
        title: $("lobby-title"),
        greeting: $("lobby-greeting"),
        tabOnline: $("lobby-tab-online"),
        tabLocal: $("lobby-tab-local"),
        onlinePage: $("lobby-online-page"),
        localPage: $("lobby-local-page"),
        feedback: $("lobby-feedback"),
        createForm: $("lobby-create-form"),
        roomName: $("lobby-room-name"),
        maxPlayers: $("lobby-max-players"),
        waitMinutes: $("lobby-wait-minutes"),
        roomPassword: $("lobby-room-password"),
        search: $("lobby-room-search"),
        refresh: $("lobby-refresh-rooms"),
        roomList: $("lobby-room-list"),
        passwordPanel: $("lobby-password-panel"),
        passwordRoomLabel: $("lobby-password-room-label"),
        passwordForm: $("lobby-password-form"),
        joinPassword: $("lobby-join-password"),
        passwordCancel: $("lobby-password-cancel"),
        setup: $("lobby-online-setup"),
        onlineRoom: $("lobby-online-room"),
        onlineRoomTitle: $("lobby-online-room-title"),
        leaveRoom: $("lobby-leave-room"),
        roomCount: $("lobby-room-count"),
        countdown: $("lobby-countdown"),
        readySummary: $("lobby-ready-summary"),
        playerList: $("lobby-player-list"),
        readyButton: $("lobby-ready-button"),
        startButton: $("lobby-start-button"),
        startHint: $("lobby-start-hint"),
        voiceToggle: $("lobby-voice-enabled"),
        voiceStatus: $("lobby-voice-status"),
        cameraToggle: $("lobby-camera-enabled"),
        localCameraPreview: $("lobby-local-camera-preview"),
        remoteMedia: $("lobby-remote-media"),
        localForm: $("lobby-local-form"),
        localCount: $("lobby-local-player-count"),
        localNameFields: $("lobby-local-name-fields"),
        localSetup: $("lobby-local-setup"),
        localResult: $("lobby-local-result"),
        localResultTitle: $("lobby-local-result-title"),
        localPlayers: $("lobby-local-player-list"),
        localEdit: $("lobby-local-edit"),
        localStartButton: $("lobby-local-start-button"),
        localGameStarted: $("lobby-local-game-started")
    };

    let profile = { playerName: "Játékos", avatarUrl: null };
    let rooms = [];
    let currentRoom = null;
    let currentMode = "online";
    let pendingJoinCode = null;
    let roomCountdownTimer = null;
    let createRoomTimeout = null;
    let refreshTimer = null;
    let localSession = null;
    let onlineGameLaunchedRoomCode = null;


    if (window.KiiszikGame && typeof window.KiiszikGame.setMediaControls === "function") {
        window.KiiszikGame.setMediaControls({
            microphone: ui.voiceToggle, camera: ui.cameraToggle,
            localPreview: ui.localCameraPreview, remoteMedia: ui.remoteMedia
        });
    }

    // Voice chat peer connections (peer-to-peer WebRTC).
    let voiceEnabled = false;
    let cameraEnabled = false;
    let localMediaStream = null;
    const voicePeers = new Map();

    // A profilnál felvett büntetőhang bekerül a szoba szerverének memóriájába.
    let uploadedPenaltyRecordingRoomCode = null;
    let lastPenaltyAudio = null;

    function setFeedback(message, type = "info") {
        ui.feedback.textContent = message || "";
        ui.feedback.className = `lobby-feedback${message ? ` is-${type}` : ""}`;
    }

    function connectedStatus(connected) {
        ui.connection.classList.toggle("is-online", Boolean(connected));
        ui.connection.classList.toggle("is-offline", !connected);
        ui.connection.lastChild.textContent = connected ? " Online" : " Offline";
    }

    function showLobby() {
        screen.hidden = false;
        screen.classList.add("is-active");
        titleScreen.hidden = true;
        if (settingsButton) settingsButton.hidden = true;
        scene.classList.add("k-lobby-active");
        ui.greeting.textContent = `Szia, ${profile.playerName}! Válassz, hogyan szeretnétek játszani.`;
        selectMode(currentMode);
        if (socket && socket.connected) requestRooms();
    }

    function returnToTitle() {
        if (currentRoom && socket) {
            disableMedia(true);
            socket.emit("room:leave");
        } else {
            disableMedia(false);
        }
        currentRoom = null;
        uploadedPenaltyRecordingRoomCode = null;
        onlineGameLaunchedRoomCode = null;
        screen.hidden = true;
        screen.classList.remove("is-active", "has-active-room");
        titleScreen.hidden = false;
        if (settingsButton) settingsButton.hidden = false;
        scene.classList.remove("k-lobby-active");
    }

    function selectMode(mode) {
        currentMode = mode === "local" ? "local" : "online";
        const online = currentMode === "online";
        ui.tabOnline.classList.toggle("is-active", online);
        ui.tabLocal.classList.toggle("is-active", !online);
        ui.tabOnline.setAttribute("aria-selected", String(online));
        ui.tabLocal.setAttribute("aria-selected", String(!online));
        ui.onlinePage.hidden = !online;
        ui.localPage.hidden = online;
        ui.title.textContent = online ? "Többjátékos online" : "Egy készüléken játszotok";
        ui.greeting.textContent = online
            ? "Hozz létre egy online szobát, vagy csatlakozz egyhez."
            : "Adjátok meg a játékosok neveit. Ez a helyi játék nem jelenik meg az online szobakeresőben.";
        setFeedback("");
        if (online && socket && socket.connected && !currentRoom) requestRooms();
        if (!online) makeLocalNameInputs();
    }

    ui.tabOnline.addEventListener("click", () => selectMode("online"));
    ui.tabLocal.addEventListener("click", () => selectMode("local"));
    ui.backMain.addEventListener("click", returnToTitle);

    window.addEventListener("kiiszik:profile-ready", (event) => {
        profile = event.detail || profile;
        showLobby();
    });
    window.addEventListener("kiiszik:open-lobby", (event) => {
        if (event.detail) profile = event.detail;
        showLobby();
    });

    // ---- Local, pass-and-play session. This is deliberately not sent to the server. ----
    function makeLocalNameInputs() {
        if (!ui.localNameFields || !ui.localCount) return;
        const count = Math.max(1, Math.min(8, Number(ui.localCount.value) || 1));
        const oldValues = [...ui.localNameFields.querySelectorAll("input")].map((input) => input.value);
        ui.localNameFields.replaceChildren();
        for (let index = 0; index < count; index += 1) {
            const wrap = document.createElement("div");
            wrap.className = "lobby-local-name-field";
            const label = document.createElement("label");
            const input = document.createElement("input");
            const id = `lobby-local-name-${index + 1}`;
            label.htmlFor = id;
            label.textContent = index === 0 ? "1. játékos (te)" : `${index + 1}. játékos`;
            input.id = id;
            input.name = `localPlayer${index + 1}`;
            input.type = "text";
            input.maxLength = 20;
            input.required = true;
            input.autocomplete = "off";
            input.placeholder = index === 0 ? profile.playerName : `Játékos ${index + 1}`;
            input.value = oldValues[index] || (index === 0 ? profile.playerName : `Játékos ${index + 1}`);
            wrap.append(label, input);
            ui.localNameFields.append(wrap);
        }
    }

    ui.localCount.addEventListener("change", makeLocalNameInputs);
    ui.localForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const names = [...ui.localNameFields.querySelectorAll("input")].map((input) => input.value.trim().replace(/\s+/g, " "));
        if (names.some((name) => [...name].length < 2 || [...name].length > 20)) {
            setFeedback("Minden játékosnév legyen 2–20 karakter hosszú.", "error");
            return;
        }
        localSession = { names, createdAt: Date.now() };
        ui.localPlayers.replaceChildren();
        names.forEach((name, index) => {
            const card = document.createElement("div");
            card.className = "lobby-local-player-chip";
            const token = document.createElement("span");
            token.textContent = ["🎲", "🍀", "⭐", "🍋", "🃏", "🍒", "🌼", "🎯"][index];
            const text = document.createElement("strong");
            text.textContent = name;
            card.append(token, text);
            ui.localPlayers.append(card);
        });
        ui.localResultTitle.textContent = names.length === 1 ? `Egyjátékos parti: ${names[0]}` : `Helyi társaság: ${names.length} játékos`;
        ui.localGameStarted.hidden = true;
        ui.localStartButton.disabled = false;
        ui.localStartButton.textContent = "Játék indítása";
        ui.localSetup.hidden = true;
        ui.localResult.hidden = false;
        setFeedback("A helyi szoba elkészült. Nem lett közzétéve az online szobakeresőben.", "success");
    });
    ui.localEdit.addEventListener("click", () => {
        ui.localResult.hidden = true;
        ui.localSetup.hidden = false;
        setFeedback("");
    });
    ui.localStartButton.addEventListener("click", () => {
        if (!localSession) {
            setFeedback("Előbb add meg a játékosok neveit.", "error");
            return;
        }
        if (!window.KiiszikGame || typeof window.KiiszikGame.start !== "function") {
            setFeedback("A játéktábla nem töltődött be. Frissíts Ctrl + F5-tel.", "error");
            return;
        }
        window.KiiszikGame.start({ mode: "local", players: localSession.names, avatarUrl: profile.avatarUrl || null, penaltyAudioDataUrl: profile.penaltyAudioDataUrl || null });
    });

    window.addEventListener("kiiszik:game-exit", (event) => {
        const mode = event.detail?.mode;
        if (mode === "online") {
            disableMedia(true);
            if (socket && currentRoom) socket.emit("room:leave");
            currentRoom = null;
            uploadedPenaltyRecordingRoomCode = null;
            onlineGameLaunchedRoomCode = null;
            pendingJoinCode = null;
            showOnlineSetup();
            setFeedback("Kiléptél az online játékból.");
            requestRooms();
        } else {
            if (localSession) {
                ui.localResult.hidden = false;
                ui.localGameStarted.hidden = true;
                ui.localStartButton.disabled = false;
                ui.localStartButton.textContent = "Játék indítása";
            }
            setFeedback("Visszatértél a helyi lobbyba.");
        }
    });

    // ---- Online room list & create/join ----
    function requestRooms() {
        if (!socket || !socket.connected || currentRoom || currentMode !== "online") return;
        socket.emit("room:list");
    }

    function renderRooms() {
        const query = (ui.search.value || "").trim().toLowerCase();
        const visible = rooms.filter((room) =>
            `${room.name} ${room.hostName}`.toLowerCase().includes(query)
        );
        ui.roomList.replaceChildren();
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "lobby-empty-state";
            const icon = document.createElement("span");
            icon.textContent = "🎲";
            const heading = document.createElement("strong");
            heading.textContent = query ? "Nincs ilyen szoba" : "Még nincs nyitott szoba";
            const small = document.createElement("small");
            small.textContent = query ? "Próbálj másik szobanevet." : "Hozz létre egyet, vagy frissítsd a listát.";
            empty.append(icon, heading, small);
            ui.roomList.append(empty);
            return;
        }
        visible.forEach((room) => {
            const card = document.createElement("article");
            card.className = "lobby-room-list-card";
            const description = document.createElement("div");
            description.className = "lobby-room-list-info";
            const title = document.createElement("strong");
            title.textContent = room.name;
            const meta = document.createElement("small");
            meta.textContent = `${room.playerCount}/${room.maxPlayers} játékos · vezető: ${room.hostName}`;
            description.append(title, meta);
            const join = document.createElement("button");
            join.className = "lobby-join-button";
            join.type = "button";
            join.textContent = "Belépés";
            join.disabled = !socket || !socket.connected;
            join.addEventListener("click", () => attemptJoin(room.code, ""));
            card.append(description, join);
            ui.roomList.append(card);
        });
    }

    function attemptJoin(code, password) {
        if (!socket || !socket.connected) {
            setFeedback("Nem csatlakozik a szerver. Ellenőrizd, hogy fut-e a Kiiszik szerver.", "error");
            return;
        }
        pendingJoinCode = code;
        socket.emit("room:join", { code, password, playerName: profile.playerName, avatarUrl: profile.avatarUrl || null });
    }

    ui.search.addEventListener("input", renderRooms);
    ui.refresh.addEventListener("click", requestRooms);

    ui.createForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!socket || !socket.connected) {
            setFeedback("Az online szobához szerverkapcsolat kell. Indítsd el a Kiiszik szervert.", "error");
            return;
        }
        if (createRoomTimeout) {
            clearTimeout(createRoomTimeout);
            createRoomTimeout = null;
        }
        setFeedback("Szoba létrehozása…");
        socket.emit("room:create", {
            name: ui.roomName.value.trim(),
            playerName: profile.playerName,
            avatarUrl: profile.avatarUrl || null,
            maxPlayers: Number(ui.maxPlayers.value),
            waitMinutes: Number(ui.waitMinutes.value),
            password: ui.roomPassword.value
        });
        // Ne maradjon örökké a „Szoba létrehozása…” üzenet, ha a szerver
        // nem válaszol (például rossz vagy régi szerverpéldány fut).
        createRoomTimeout = window.setTimeout(() => {
            createRoomTimeout = null;
            if (!currentRoom) {
                setFeedback("A szerver nem válaszolt a szobalétrehozásra. Állítsd le a futó Kiiszik-szervert (Ctrl+C), majd indítsd újra ebből a ZIP mappából: npm start.", "error");
            }
        }, 8000);
    });

    ui.passwordCancel.addEventListener("click", () => {
        ui.passwordPanel.hidden = true;
        ui.joinPassword.value = "";
        pendingJoinCode = null;
    });
    ui.passwordForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!pendingJoinCode) return;
        attemptJoin(pendingJoinCode, ui.joinPassword.value);
    });

    ui.leaveRoom.addEventListener("click", () => {
        disableMedia(true);
        if (socket) socket.emit("room:leave");
        currentRoom = null;
        uploadedPenaltyRecordingRoomCode = null;
        onlineGameLaunchedRoomCode = null;
        showOnlineSetup();
        setFeedback("Kiléptél a szobából.");
        requestRooms();
    });

    function showOnlineSetup() {
        screen.classList.remove("has-active-room");
        ui.setup.hidden = false;
        ui.passwordPanel.hidden = false;
        // Only show password panel if a password entry is pending; otherwise hide it.
        ui.passwordPanel.hidden = !pendingJoinCode;
        ui.onlineRoom.hidden = true;
    }

    ui.readyButton.addEventListener("click", () => {
        if (!socket || !currentRoom) return;
        const own = currentRoom.players.find((player) => player.id === socket.id);
        socket.emit("room:ready", { ready: !(own && own.ready) });
    });

    ui.startButton.addEventListener("click", () => {
        if (!socket || !currentRoom) return;
        socket.emit("room:start");
    });

    function escapeText(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[char]);
    }

    function syncProfilePenaltyRecording() {
        if (!socket || !socket.connected || !currentRoom) return;
        const dataUrl = profile && typeof profile.penaltyAudioDataUrl === "string" ? profile.penaltyAudioDataUrl : "";
        if (!dataUrl || !dataUrl.startsWith("data:audio/") || uploadedPenaltyRecordingRoomCode === currentRoom.code) return;
        // Egy profilfelvételt szobánként egyszer töltünk fel. A szerver a szoba memóriájában tartja.
        uploadedPenaltyRecordingRoomCode = currentRoom.code;
        const comma = dataUrl.indexOf(",");
        const header = comma > 0 ? dataUrl.slice(0, comma) : "";
        const mimeType = (header.match(/^data:([^;]+)/i) || [])[1] || "audio/webm";
        socket.emit("penalty:recording-save", { dataUrl, mimeType });
    }

    function launchOnlineGame(room) {
        if (!room || !room.started || !socket) return;
        if (onlineGameLaunchedRoomCode === room.code) return;
        if (!window.KiiszikGame || typeof window.KiiszikGame.start !== "function") {
            setFeedback("A játéktábla JavaScriptje nem töltődött be. Ellenőrizd a szerver mappáját, majd frissíts Ctrl + F5-tel.", "error");
            return;
        }
        onlineGameLaunchedRoomCode = room.code;
        // A játék indulásakor az online váró teljesen eltűnik a játék fölül.
        ui.setup.hidden = true;
        ui.passwordPanel.hidden = true;
        ui.onlineRoom.hidden = true;
        screen.classList.remove("has-active-room");
        setFeedback("");
        try {
            const result = window.KiiszikGame.start({ mode: "online", socket, roomCode: room.code, avatarUrl: profile.avatarUrl || null });
            Promise.resolve(result).catch((error) => {
                console.error("Kiiszik online game start error:", error);
                onlineGameLaunchedRoomCode = null;
                ui.onlineRoom.hidden = false;
                screen.classList.add("has-active-room");
                setFeedback("Nem sikerült elindítani a játékot. Nézd meg, hogy a játéktábla fájljai is megvannak-e, majd frissíts Ctrl + F5-tel.", "error");
            });
        } catch (error) {
            console.error("Kiiszik online game start error:", error);
            onlineGameLaunchedRoomCode = null;
            ui.onlineRoom.hidden = false;
            screen.classList.add("has-active-room");
            setFeedback("Nem sikerült elindítani a játékot. Frissíts Ctrl + F5-tel, és ellenőrizd a szerver mappáját.", "error");
        }
    }

    function renderRoomState(room) {
        currentRoom = room;
        pendingJoinCode = null;
        if (room.started) {
            launchOnlineGame(room);
            return;
        }
        screen.classList.add("has-active-room");
        ui.passwordPanel.hidden = true;
        ui.setup.hidden = true;
        ui.onlineRoom.hidden = false;
        ui.onlineRoomTitle.textContent = room.name;
        ui.roomCount.textContent = `${room.players.length} / ${room.maxPlayers}`;
        ui.readySummary.textContent = room.players.every((p) => p.ready) ? "Mindenki kész!" : "Várakozás a játékosokra…";
        ui.readySummary.classList.toggle("is-ready", room.players.every((p) => p.ready));

        const isHost = socket && room.hostId === socket.id;
        const own = socket ? room.players.find((p) => p.id === socket.id) : null;
        ui.readyButton.textContent = own && own.ready ? "Mégsem vagyok kész" : "Kész vagyok";
        ui.readyButton.disabled = Boolean(room.started || !own);
        ui.startButton.hidden = !isHost;
        ui.startButton.disabled = Boolean(room.started || room.players.length < 2 || !room.players.every((p) => p.ready));
        ui.startHint.textContent = room.started
            ? "A szoba elindult."
            : room.players.length < 2
                ? "Legalább 2 játékos szükséges."
                : !room.players.every((p) => p.ready)
                    ? "Minden játékosnak készen kell állnia."
                    : isHost ? "Mindenki kész. Indíthatod a partit!" : "Mindenki kész. Várakozás a vezetőre.";

        ui.playerList.replaceChildren();
        room.players.forEach((player) => {
            const card = document.createElement("article");
            card.className = "lobby-player-card" + (player.ready ? " is-ready" : "");
            const avatar = document.createElement("div");
            avatar.className = "lobby-player-avatar";
            avatar.textContent = player.name === profile.playerName && profile.avatarUrl ? "📸" : "🙂";
            const details = document.createElement("div");
            details.className = "lobby-player-details";
            const name = document.createElement("strong");
            name.textContent = player.name + (socket && player.id === socket.id ? " (te)" : "");
            const labels = document.createElement("small");
            const mediaLabels = [player.voice ? "🎙 Mikrofon" : "", player.camera ? "📷 Webkamera" : "", player.hasPenaltyRecording ? "🔊 Büntetőhang kész" : ""].filter(Boolean);
            const roleLabel = player.isHost ? "👑 Alkoholista király" : "Játékos";
            labels.textContent = mediaLabels.length ? `${roleLabel} · ${mediaLabels.join(" · ")}` : roleLabel;
            const ready = document.createElement("span");
            ready.className = "lobby-ready-badge" + (player.ready ? " is-ready" : "");
            ready.textContent = player.ready ? "✓ KÉSZ" : "VÁRAKOZIK";
            details.append(name, labels);
            card.append(avatar, details, ready);

            if (isHost && player.id !== socket.id && !room.started) {
                const actions = document.createElement("div");
                actions.className = "lobby-player-actions";
                const transfer = document.createElement("button");
                transfer.type = "button";
                transfer.textContent = "Vezető átadása";
                transfer.addEventListener("click", () => {
                    if (window.confirm(`Átadod az Alkoholista király címét ${player.name} játékosnak?`)) {
                        socket.emit("room:transfer-leader", { targetId: player.id });
                    }
                });
                const kick = document.createElement("button");
                kick.type = "button";
                kick.textContent = "Kirúgás";
                kick.className = "is-danger";
                kick.addEventListener("click", () => {
                    if (window.confirm(`Biztosan kirúgod ${player.name} játékost?`)) {
                        socket.emit("room:kick", { targetId: player.id });
                    }
                });
                actions.append(transfer, kick);
                card.append(actions);
            }
            ui.playerList.append(card);
        });
        updateCountdown();
        syncProfilePenaltyRecording();
    }

    function updateCountdown() {
        if (!currentRoom || !currentRoom.expiresAt || currentRoom.started) {
            ui.countdown.textContent = currentRoom && currentRoom.started ? "elindult" : "--:--";
            return;
        }
        const seconds = Math.max(0, Math.floor((currentRoom.expiresAt - Date.now()) / 1000));
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        ui.countdown.textContent = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }
    roomCountdownTimer = window.setInterval(updateCountdown, 1000);

    // ---- Hang + webkamera WebRTC ----
    function voiceSetStatus(message, error = false) {
        ui.voiceStatus.textContent = message;
        ui.voiceStatus.classList.toggle("is-error", error);
    }

    function hasLocalMedia() {
        return Boolean(localMediaStream && localMediaStream.getTracks().some((track) => track.readyState === "live"));
    }

    function updateLocalPreview() {
        const show = cameraEnabled && localMediaStream && localMediaStream.getVideoTracks().some((track) => track.readyState === "live");
        ui.localCameraPreview.hidden = !show;
        if (show) ui.localCameraPreview.srcObject = localMediaStream;
        else ui.localCameraPreview.srcObject = null;
    }

    function updateRemoteMediaVisibility() {
        ui.remoteMedia.hidden = ui.remoteMedia.children.length === 0;
    }

    async function syncPeerTracks(entry, stream) {
        const pc = entry.pc;
        const tracks = stream ? stream.getTracks().filter((track) => track.readyState === "live") : [];
        for (const kind of ["audio", "video"]) {
            const track = tracks.find((item) => item.kind === kind) || null;
            let sender = pc.getSenders().find((item) => item.__kiiszikKind === kind || item.track?.kind === kind);
            if (sender) {
                sender.__kiiszikKind = kind;
                try { await sender.replaceTrack(track); }
                catch (error) { console.warn(`[Kiiszik media] ${kind} sáv frissítési hiba:`, error); }
            } else if (track) {
                sender = pc.addTrack(track, stream);
                sender.__kiiszikKind = kind;
            }
        }
    }

    async function refreshLocalMedia() {
        const wantAudio = Boolean(ui.voiceToggle.checked);
        const wantVideo = Boolean(ui.cameraToggle.checked);

        if (!socket || !socket.connected || !currentRoom) {
            ui.voiceToggle.checked = false;
            ui.cameraToggle.checked = false;
            voiceSetStatus("A mikrofon és a webkamera online lobbyban használható.", true);
            return;
        }
        if (!wantAudio && !wantVideo) {
            disableMedia(true);
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            ui.voiceToggle.checked = voiceEnabled;
            ui.cameraToggle.checked = cameraEnabled;
            voiceSetStatus("A mikrofonhoz és a kamerához localhost vagy HTTPS szükséges.", true);
            return;
        }

        let nextStream = null;
        try {
            nextStream = await navigator.mediaDevices.getUserMedia({
                audio: wantAudio,
                video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" } : false
            });
            const previousStream = localMediaStream;
            localMediaStream = nextStream;
            voiceEnabled = wantAudio;
            cameraEnabled = wantVideo;
            updateLocalPreview();

            // A már létrejött kapcsolatban is frissítjük a sávokat, amikor a kamera/mikrofon változik.
            for (const entry of voicePeers.values()) await syncPeerTracks(entry, localMediaStream);
            if (previousStream) previousStream.getTracks().forEach((track) => track.stop());

            socket.emit("voice:toggle", { enabled: voiceEnabled, cameraEnabled });
            const active = [voiceEnabled ? "mikrofon" : "", cameraEnabled ? "webkamera" : ""].filter(Boolean).join(" és ");
            voiceSetStatus(`Bekapcsolva: ${active}. A böngésző engedélye szükséges.`);
        } catch (error) {
            if (nextStream) nextStream.getTracks().forEach((track) => track.stop());
            ui.voiceToggle.checked = voiceEnabled;
            ui.cameraToggle.checked = cameraEnabled;
            const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
            voiceSetStatus(denied ? "Nem kaptunk mikrofon-/kameraengedélyt. Engedélyezd a böngészőben." : "Nem sikerült elindítani a mikrofont vagy a webkamerát.", true);
        }
    }

    function disableMedia(sendEvent = true) {
        if (sendEvent && socket && currentRoom) socket.emit("voice:toggle", { enabled: false, cameraEnabled: false });
        voiceEnabled = false;
        cameraEnabled = false;
        if (localMediaStream) {
            localMediaStream.getTracks().forEach((track) => track.stop());
            localMediaStream = null;
        }
        ui.localCameraPreview.srcObject = null;
        ui.localCameraPreview.hidden = true;
        for (const id of [...voicePeers.keys()]) closeVoicePeer(id);
        if (ui.voiceToggle) ui.voiceToggle.checked = false;
        if (ui.cameraToggle) ui.cameraToggle.checked = false;
        if (ui.voiceStatus) voiceSetStatus("A mikrofon és a webkamera ki van kapcsolva.");
    }

    async function ensureVoicePeer(peerId, peerName) {
        if ((!voiceEnabled && !cameraEnabled) || !hasLocalMedia() || !peerId || peerId === socket.id) return null;
        if (voicePeers.has(peerId)) return voicePeers.get(peerId);

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        const entry = {
            pc,
            peerName: peerName || "Játékos",
            polite: socket.id.localeCompare(peerId) > 0,
            makingOffer: false,
            ignoreOffer: false,
            isSettingRemoteAnswerPending: false,
            pendingCandidates: [],
            remoteStream: null,
            mediaCard: null,
            audioElement: null,
            videoElement: null
        };
        voicePeers.set(peerId, entry);

        localMediaStream.getTracks().forEach((track) => {
            const sender = pc.addTrack(track, localMediaStream);
            sender.__kiiszikKind = track.kind;
        });
        pc.onicecandidate = (event) => {
            if (event.candidate) socket.emit("voice:signal", { targetId: peerId, signal: { type: "candidate", candidate: event.candidate.toJSON() } });
        };
        pc.onnegotiationneeded = async () => {
            try {
                entry.makingOffer = true;
                await pc.setLocalDescription();
                socket.emit("voice:signal", { targetId: peerId, signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            } catch (error) {
                console.warn("[Kiiszik media] Kapcsolategyeztetési hiba:", error);
                voiceSetStatus("Nem sikerült a hang-/videókapcsolatot egyeztetni.", true);
            } finally {
                entry.makingOffer = false;
            }
        };
        pc.ontrack = (event) => {
            const incoming = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
            entry.remoteStream = incoming;
            if (!entry.mediaCard) {
                entry.mediaCard = document.createElement("article");
                entry.mediaCard.className = "lobby-remote-media-card";
                entry.mediaCard.dataset.playerName = entry.peerName;
                entry.mediaCard.dataset.playerId = peerId;
                const name = document.createElement("strong");
                name.className = "lobby-remote-media-name";
                name.textContent = entry.peerName;
                entry.videoElement = document.createElement("video");
                entry.videoElement.autoplay = true;
                entry.videoElement.playsInline = true;
                entry.videoElement.muted = true;
                entry.videoElement.hidden = true;
                entry.audioElement = document.createElement("audio");
                entry.audioElement.autoplay = true;
                entry.audioElement.playsInline = true;
                entry.mediaCard.append(name, entry.videoElement, entry.audioElement);
                ui.remoteMedia.append(entry.mediaCard);
            }
            if (event.track.kind === "video") {
                entry.videoElement.hidden = false;
                entry.videoElement.srcObject = incoming;
                entry.videoElement.play().catch(() => {});
            } else if (event.track.kind === "audio") {
                entry.audioElement.srcObject = incoming;
                entry.audioElement.play().catch(() => voiceSetStatus("A hang lejátszásához kattints az oldalon vagy ellenőrizd a böngésző hangbeállításait."));
            }
            updateRemoteMediaVisibility();
        };
        pc.onconnectionstatechange = () => {
            if (["failed", "closed"].includes(pc.connectionState)) closeVoicePeer(peerId);
        };
        return entry;
    }

    async function receiveVoiceSignal(data) {
        if ((!voiceEnabled && !cameraEnabled) || !data || !data.from || !data.signal) return;
        const peerId = data.from;
        const signal = data.signal;
        const entry = voicePeers.get(peerId) || await ensureVoicePeer(peerId, "Játékos");
        if (!entry) return;

        try {
            if (signal.type === "offer" || signal.type === "answer") {
                const readyForOffer = !entry.makingOffer && (entry.pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
                const offerCollision = signal.type === "offer" && !readyForOffer;
                entry.ignoreOffer = !entry.polite && offerCollision;
                if (entry.ignoreOffer) return;
                entry.isSettingRemoteAnswerPending = signal.type === "answer";
                if (offerCollision && entry.polite) await entry.pc.setLocalDescription({ type: "rollback" });
                await entry.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
                entry.isSettingRemoteAnswerPending = false;
                for (const candidate of entry.pendingCandidates.splice(0)) await entry.pc.addIceCandidate(candidate);
                if (signal.type === "offer") {
                    await entry.pc.setLocalDescription();
                    socket.emit("voice:signal", { targetId: peerId, signal: { type: entry.pc.localDescription.type, sdp: entry.pc.localDescription.sdp } });
                }
            } else if (signal.type === "candidate" && signal.candidate) {
                if (entry.ignoreOffer) return;
                const candidate = new RTCIceCandidate(signal.candidate);
                if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(candidate);
                else entry.pendingCandidates.push(candidate);
            }
        } catch (error) {
            console.warn("[Kiiszik media] Jelzési hiba:", error);
        }
    }

    function closeVoicePeer(peerId) {
        const entry = voicePeers.get(peerId);
        if (!entry) return;
        try { entry.pc.close(); } catch {}
        if (entry.mediaCard) entry.mediaCard.remove();
        voicePeers.delete(peerId);
        updateRemoteMediaVisibility();
    }

    ui.voiceToggle.addEventListener("change", refreshLocalMedia);
    ui.cameraToggle.addEventListener("change", refreshLocalMedia);

    function playPenaltyRecording(data) {
        if (!data || !data.dataUrl) return;
        if (lastPenaltyAudio) {
            lastPenaltyAudio.pause();
            lastPenaltyAudio = null;
        }
        const message = data.isTest
            ? `🔊 Próba: ${data.playerName} büntető hangfelvétele.`
            : `🔊 ${data.playerName} visszalép ${data.spacesBack} mezőt. ${data.reason || "Büntetés"}.`;
        setFeedback(message, "success");
        const audio = new Audio(data.dataUrl);
        audio.volume = 1;
        lastPenaltyAudio = audio;
        audio.addEventListener("ended", () => { if (lastPenaltyAudio === audio) lastPenaltyAudio = null; }, { once: true });
        audio.play().catch(() => {
            setFeedback(`${message} A böngésző blokkolta a hang automatikus lejátszását. Kattints egyszer az oldalon, és ellenőrizd a hangerőt.`, "error");
        });
    }

    // A készülő játéktábla innen tudja jelezni, ha egy játékos hátralép.
    // Ezt a műveletet csak a szoba vezetőjének böngészője küldheti a szervernek.
    window.KiiszikGameEffects = window.KiiszikGameEffects || {};
    window.KiiszikGameEffects.playerKnockedBack = (targetPlayerId, spacesBack = 3, reason = "Kiütötték") => {
        if (!socket || !socket.connected || !currentRoom) return false;
        socket.emit("game:penalty-trigger", { targetId: String(targetPlayerId), spacesBack, reason });
        return true;
    };
    window.addEventListener("kiiszik:player-knocked-back", (event) => {
        const detail = event.detail || {};
        window.KiiszikGameEffects.playerKnockedBack(detail.targetPlayerId, detail.spacesBack || 3, detail.reason || "Kiütötték");
    });

    // ---- Socket responses ----
    if (socket) {
        socket.on("connect", () => {
            connectedStatus(true);
            requestRooms();
        });
        socket.on("disconnect", () => {
            connectedStatus(false);
            rooms = [];
            renderRooms();
            if (currentRoom) setFeedback("A szerverkapcsolat megszakadt. Próbál újracsatlakozni…", "error");
        });
        socket.on("room:list-result", (list) => {
            rooms = Array.isArray(list) ? list : [];
            renderRooms();
        });
        socket.on("room:list-updated", requestRooms);
        socket.on("room:create-result", (result) => {
            if (createRoomTimeout) {
                clearTimeout(createRoomTimeout);
                createRoomTimeout = null;
            }
            if (!result || !result.ok) {
                setFeedback(result?.message || "Nem sikerült létrehozni a szobát.", "error");
                return;
            }
            pendingJoinCode = null;
            ui.roomPassword.value = "";
            if (result.room) {
                // Azonnali, biztos átváltás a várószobára.
                renderRoomState(result.room);
            } else {
                // Kompatibilitási tartalék, ha régebbi szerverválasz érkezik.
                socket.emit("room:state-request");
            }
            setFeedback("Szoba létrehozva! Várjuk a többi játékost.", "success");
        });
        socket.on("room:join-result", (result) => {
            if (result?.ok) {
                ui.passwordPanel.hidden = true;
                ui.joinPassword.value = "";
                pendingJoinCode = null;
                if (result.room) renderRoomState(result.room);
                else socket.emit("room:state-request");
                setFeedback("Sikeresen csatlakoztál a szobához.", "success");
                return;
            }
            const reason = result?.reason;
            if (reason === "PASSWORD_REQUIRED" || reason === "BAD_PASSWORD") {
                ui.passwordPanel.hidden = false;
                ui.passwordRoomLabel.textContent = "Add meg a kiválasztott szoba jelszavát a belépéshez.";
                ui.joinPassword.value = "";
                ui.joinPassword.focus();
                setFeedback(reason === "BAD_PASSWORD" ? "Hibás jelszó. Próbáld újra." : "Ehhez a szobához jelszó szükséges.", "error");
            } else {
                setFeedback(result?.message || "Nem sikerült belépni a szobába.", "error");
                ui.passwordPanel.hidden = true;
            }
        });
        socket.on("room:state", renderRoomState);
        socket.on("room:action-result", (result) => {
            setFeedback(result?.message || (result?.ok ? "Kész." : "A művelet nem sikerült."), result?.ok ? "success" : "error");
        });
        socket.on("room:leave-result", () => {
            currentRoom = null;
            uploadedPenaltyRecordingRoomCode = null;
            onlineGameLaunchedRoomCode = null;
            pendingJoinCode = null;
            ui.passwordPanel.hidden = true;
            showOnlineSetup();
            requestRooms();
        });
        socket.on("room:kicked", (data) => {
            disableMedia(false);
            currentRoom = null;
            uploadedPenaltyRecordingRoomCode = null;
            onlineGameLaunchedRoomCode = null;
            showOnlineSetup();
            setFeedback(data?.message || "A szobavezető eltávolított a szobából.", "error");
            requestRooms();
        });
        socket.on("room:expired", (data) => {
            disableMedia(false);
            currentRoom = null;
            uploadedPenaltyRecordingRoomCode = null;
            onlineGameLaunchedRoomCode = null;
            showOnlineSetup();
            setFeedback(data?.message || "A szoba várakozási ideje lejárt.", "error");
            requestRooms();
        });
        socket.on("room:started", (data = {}) => {
            if (currentRoom) {
                currentRoom.started = true;
                if (data.code) currentRoom.code = data.code;
                launchOnlineGame(currentRoom);
            } else {
                // Ha az állapotfrissítés és az indulás eseménye eltérő sorrendben érkezik,
                // kérjük le a szoba állapotát, és a started mező elindítja a játékot.
                socket.emit("room:state-request");
            }
        });
        socket.on("penalty:recording-saved", (result) => {
            if (!result || !result.ok) {
                uploadedPenaltyRecordingRoomCode = null;
                if (result?.message) setFeedback(`A büntetőhang nem került a szobába: ${result.message}`, "error");
                return;
            }
            if (currentRoom) {
                const own = currentRoom.players.find((player) => player.id === socket.id);
                if (own) own.hasPenaltyRecording = true;
            }
        });
        socket.on("game:penalty-voice", playPenaltyRecording);
        socket.on("voice:peers", async (list) => {
            for (const peer of (Array.isArray(list) ? list : [])) {
                await ensureVoicePeer(peer.id, peer.name);
            }
        });
        socket.on("voice:peer-available", async (peer) => {
            if ((voiceEnabled || cameraEnabled) && peer?.id) {
                await ensureVoicePeer(peer.id, peer.name);
            }
        });
        socket.on("voice:peer-left", (data) => {
            if (data?.id) closeVoicePeer(data.id);
        });
        socket.on("voice:signal", receiveVoiceSignal);
        socket.on("voice:status", (data) => {
            if (data && data.message) voiceSetStatus(data.message, !data.ok);
        });
    } else {
        connectedStatus(false);
        setFeedback("Az online módhoz Socket.IO-szerver kell. A helyi játékmód szerver nélkül is előkészíthető.", "error");
    }

    if (socket && socket.connected) connectedStatus(true);
    makeLocalNameInputs();
    refreshTimer = window.setInterval(() => {
        if (!currentRoom && currentMode === "online" && screen && !screen.hidden) requestRooms();
    }, 10000);

    window.addEventListener("beforeunload", () => {
        if (createRoomTimeout) clearTimeout(createRoomTimeout);
        if (lastPenaltyAudio) lastPenaltyAudio.pause();
        disableMedia(false);
        if (refreshTimer) clearInterval(refreshTimer);
        if (roomCountdownTimer) clearInterval(roomCountdownTimer);
    });
})();
