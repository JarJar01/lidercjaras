"use strict";

(() => {
    const socket = window.lidercSocket;
    if (!socket) {
        console.error("Lidércjárás: a Socket.IO kapcsolat nem található.");
        return;
    }

    const $ = (id) => document.getElementById(id);
    const roleSymbols = {
        spirits: "☾",
        healer: "✚",
        villagers: "⌂",
        hunters: "➶",
        fool: "☻"
    };
    const phaseLabels = {
        countdown: "Kezdés",
        intro: "Ismerkedés",
        "night-spirits": "Lidércek köre",
        "night-healer": "Gyógyító köre",
        "night-hunters": "Vadászok köre",
        "night-fool": "Bolond köre",
        "dawn-result": "Hajnalodik",
        day: "Nappal",
        "vote-result": "Szavazás eredménye",
        "game-over": "Játék vége"
    };
    const phaseTitles = {
        countdown: "A sötétség elnyeli a falut",
        intro: "Ismerkedjetek meg egymással",
        "night-spirits": "A lidércek vadásznak",
        "night-healer": "A gyógyító védelmet választ",
        "night-hunters": "A vadászok döntenek",
        "night-fool": "A bolond kivárja az éjszakát",
        "dawn-result": "Felszáll a reggeli köd",
        day: "A falu felébred",
        "vote-result": "A falu döntött",
        "game-over": "Véget ért a Lidércjárás"
    };
    const nightPhases = new Set(["night-spirits", "night-healer", "night-hunters", "night-fool"]);

    let myRole = null;
    let myRoleLabel = "";
    let myRoleDescription = "";
    let myTeamMembers = [];
    let myHealerUsesRemaining = 2;
    let rematchReadyIds = [];
    let rematchReadyCount = 0;
    let rematchReadyTotal = 0;
    let rematchStatusMessage = "";
    let gameState = null;
    let currentPhase = "";
    let currentRound = 0;
    let actionSubmitted = false;
    let actionStatusMessage = "";
    let timerInterval = null;
    let lastNoticeKey = "";

    function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function appendChatMessage({ fromName = "Játékos", text = "", at = Date.now(), system = false } = {}) {
        const container = $("gameTeamChatMessages");
        if (!container) return;
        const empty = container.querySelector(".game-chat-empty");
        if (empty) empty.remove();
        const line = makeElement("div", system ? "game-chat-line game-chat-system" : "game-chat-line");
        const time = makeElement("time", "", new Date(at).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" }));
        line.appendChild(time);
        if (!system) line.appendChild(makeElement("strong", "", `${fromName}: `));
        line.appendChild(document.createTextNode(text));
        container.appendChild(line);
        while (container.children.length > 50) container.firstElementChild.remove();
        container.scrollTop = container.scrollHeight;
    }

    function setActionStatus(message, isError = false) {
        actionStatusMessage = message || "";
        const actions = $("gameActions");
        if (!actions) return;
        let status = actions.querySelector(".game-action-status");
        if (!actionStatusMessage) {
            if (status) status.remove();
            return;
        }
        if (!status) {
            status = makeElement("p", "game-action-status");
            actions.appendChild(status);
        }
        status.textContent = actionStatusMessage;
        status.classList.toggle("is-error", Boolean(isError));
    }

    function showNotice(text, key = "") {
        const notice = $("gameNotice");
        if (!notice) return;
        const value = text || "";
        notice.textContent = value;
        notice.hidden = !value;
        if (key) lastNoticeKey = key;
    }

    function isMyselfAlive() {
        if (!gameState) return true;
        const me = gameState.players.find((player) => player.id === socket.id);
        return Boolean(me && me.alive && me.connected !== false);
    }

    function alivePlayers() {
        return gameState ? gameState.players.filter((player) => player.alive && player.connected !== false) : [];
    }

    function addChoiceButton(container, label, onClick, variant = "") {
        const button = makeElement("button", `game-choice-button${variant ? ` ${variant}` : ""}`, label);
        button.type = "button";
        button.disabled = actionSubmitted;
        button.addEventListener("click", () => {
            if (actionSubmitted) return;
            actionSubmitted = true;
            renderActions();
            onClick();
        });
        container.appendChild(button);
        return button;
    }

    function sendAction(eventName, payload) {
        if (!socket.connected) {
            actionSubmitted = false;
            setActionStatus("Megszakadt a szerverkapcsolat. Várj, amíg újracsatlakozik.", true);
            renderActions();
            return;
        }
        socket.emit(eventName, payload);
    }

    function appendSectionDescription(container, message) {
        container.appendChild(makeElement("p", "game-action-description", message));
    }

    function renderActions() {
        const panel = $("gameActions");
        if (!panel) return;
        panel.replaceChildren();

        if (!gameState) {
            panel.appendChild(makeElement("p", "game-muted", "Kapcsolódás a játékmenethez…"));
            return;
        }
        if (!isMyselfAlive()) {
            panel.appendChild(makeElement("p", "game-muted", "Kiestél a játékból. Megfigyelőként követheted a hátralévő eseményeket, de már nem cselekedhetsz és nem szavazhatsz."));
            if (actionStatusMessage) setActionStatus(actionStatusMessage);
            return;
        }

        const phase = gameState.phase;
        const players = alivePlayers();
        const otherPlayers = players.filter((player) => player.id !== socket.id);

        if (phase === "countdown") {
            panel.appendChild(makeElement("p", "game-muted", "A szereped titokban kiosztásra került. Figyeld a saját szerepkártyádat; a történet hamarosan elkezdődik."));
        } else if (phase === "intro") {
            panel.appendChild(makeElement("p", "game-muted", "Most még mindenki beszélhet egymással. Ismerkedjetek, figyeljétek meg a többieket, és készüljetek az éjszakára."));
        } else if (phase === "night-spirits") {
            if (myRole !== "spirits") {
                panel.appendChild(makeElement("p", "game-muted", "A falu alszik. Most a lidércek titkos köre zajlik."));
            } else {
                const livingTeammates = myTeamMembers.filter((member) => players.some((player) => player.id === member.id));
                if (livingTeammates.length <= 1) {
                    appendSectionDescription(panel, "Egyedüli lidércként vagy: választhatsz egy játékost, akit megtámadsz, VAGY megnézhetsz egy középső szerepkártyát. Csak egyet választhatsz.");
                    otherPlayers.forEach((player) => {
                        addChoiceButton(panel, `☾  Megtámadom: ${player.username}`, () => {
                            setActionStatus("A támadási döntés elküldve. Várd meg a kör végét.");
                            sendAction("spirit-action", { type: "attack", targetId: player.id });
                        }, "is-danger");
                    });
                    const cardTitle = makeElement("p", "game-action-description", "Vagy nézz meg egy középső kártyát:");
                    panel.appendChild(cardTitle);
                    [0, 1, 2].forEach((index) => {
                        addChoiceButton(panel, `Középső kártya ${index + 1} megtekintése`, () => {
                            setActionStatus("Megnézed a középső kártyát…");
                            sendAction("spirit-action", { type: "peek", cardIndex: index });
                        }, "is-neutral");
                    });
                } else {
                    appendSectionDescription(panel, "Több lidérc van életben. Titkos chatben egyeztessetek, majd mindannyian ugyanazt a célpontot jelöljétek meg. Eltérő választás esetén a támadás sikertelen.");
                    otherPlayers.filter((player) => !livingTeammates.some((mate) => mate.id === player.id)).forEach((player) => {
                        addChoiceButton(panel, `Közös támadási célpont: ${player.username}`, () => {
                            setActionStatus("A választásod rögzítve. A támadás csak egyhangú döntés esetén sikerül.");
                            sendAction("spirit-action", { type: "attack", targetId: player.id });
                        }, "is-danger");
                    });
                }
            }
        } else if (phase === "night-healer") {
            if (myRole !== "healer") {
                panel.appendChild(makeElement("p", "game-muted", "A gyógyító most egyetlen játékost védhet meg az éjszakai támadástól."));
            } else {
                appendSectionDescription(panel, "Válassz egy élő játékost, akit megvédesz. Saját magadat is választhatod, és a döntésed az éjszakára végleges.");
                players.forEach((player) => {
                    addChoiceButton(panel, `${player.id === socket.id ? "✚  Saját magam védelme" : `✚  Megvédem: ${player.username}`}`, () => {
                        setActionStatus(`A védelmi döntés elküldve: ${player.username}.`);
                        sendAction("healer-protect", { targetId: player.id });
                    }, "is-neutral");
                });
            }
        } else if (phase === "night-hunters") {
            if (myRole !== "hunters") {
                panel.appendChild(makeElement("p", "game-muted", "Most a vadászok köre van. A többi falu csendben vár."));
            } else {
                appendSectionDescription(panel, "Egy lövésed van erre az éjszakára. Ha nem lidércet találsz el, a célpont és te is meghaltok. Dönthetsz úgy is, hogy nem lősz.");
                otherPlayers.forEach((player) => {
                    addChoiceButton(panel, `➶  Rálövök: ${player.username}`, () => {
                        setActionStatus(`A lövés rögzítve: ${player.username}.`);
                        sendAction("hunter-shoot", { targetId: player.id });
                    }, "is-danger");
                });
                addChoiceButton(panel, "Most nem lövök · PASSZ", () => {
                    setActionStatus("Passzoltál erre az éjszakára.");
                    sendAction("hunter-shoot", { pass: true });
                }, "is-neutral");
            }
        } else if (phase === "night-fool") {
            panel.appendChild(makeElement("p", "game-muted", myRole === "fool" ? "Nincs éjszakai képességed. Várd meg a reggelt, és próbáld elérni, hogy a falu később kiszavazzon." : "Az éjszaka utolsó csendes köre zajlik. Várd meg a reggelt."));
        } else if (phase === "dawn-result") {
            panel.appendChild(makeElement("p", "game-muted", "A reggeli eredmény mindjárt megjelenik. A voice chat nappal ismét elérhető az életben maradt játékosoknak."));
        } else if (phase === "day") {
            appendSectionDescription(panel, "Beszéljétek meg, mi történhetett, majd adj le egy szavazatot. A szavazatodat nem lehet módosítani. A SKIP azt jelenti, hogy senkit nem szeretnél kiszavazni.");
            otherPlayers.forEach((player) => {
                addChoiceButton(panel, `Szavazok rá: ${player.username}`, () => {
                    setActionStatus(`A szavazatod elküldve: ${player.username}.`);
                    sendAction("day-vote", { targetId: player.id });
                });
            });
            addChoiceButton(panel, "SKIP · Senkit sem szavazok ki", () => {
                setActionStatus("A szavazatod: SKIP.");
                sendAction("day-vote", { targetId: "skip" });
            }, "is-neutral");
        } else if (phase === "vote-result") {
            panel.appendChild(makeElement("p", "game-muted", "A falu szavazásának eredménye rögzült. A következő éjszaka hamarosan elkezdődik, hacsak a játék véget nem ér."));
        } else if (phase === "game-over") {
            panel.appendChild(makeElement("p", "game-muted", "A játék véget ért. Nézd meg a győztes csapatot az eredményablakban."));
        } else {
            panel.appendChild(makeElement("p", "game-muted", "Várakozás a következő eseményre…"));
        }

        if (actionStatusMessage) setActionStatus(actionStatusMessage);
    }

    function renderPlayers() {
        const container = $("gamePlayersList");
        if (!container || !gameState) return;
        container.replaceChildren();
        const living = alivePlayers();
        $("gameAliveCount").textContent = `${living.length} élő`;
        gameState.players.forEach((player) => {
            const dead = !player.alive || player.connected === false;
            const row = makeElement("div", `game-player-row${dead ? " is-dead" : ""}`);
            const avatar = makeElement("span", "game-player-avatar", dead ? "†" : player.username.slice(0, 1).toLocaleUpperCase("hu-HU"));
            const info = makeElement("div", "game-player-info");
            info.appendChild(makeElement("strong", "", player.username + (player.id === socket.id ? " (te)" : "")));
            info.appendChild(makeElement("span", "", dead ? "Kiesett" : (player.isHost ? "Házigazda · életben" : "Életben")));
            row.append(avatar, info, makeElement("span", "game-player-status", dead ? "✕" : "●"));
            container.appendChild(row);
        });
    }

    function renderRoleCard() {
        const panel = $("gameRoleCard");
        if (!panel || !myRole) return;
        panel.hidden = false;
        $("gameRoleSymbol").textContent = roleSymbols[myRole] || "✦";
        $("gameRoleName").textContent = myRoleLabel || "Titkos szerep";
        $("gameRoleDescription").textContent = myRoleDescription || "A szereped titkos. Figyeld a játékmenetet.";
    }

    function renderGame() {
        if (!gameState) return;
        const phase = gameState.phase;
        const isNight = nightPhases.has(phase);
        const view = $("gameStartedView");
        view.classList.toggle("is-night", isNight || phase === "countdown");
        view.classList.toggle("is-day", phase === "day" || phase === "intro" || phase === "dawn-result");
        view.classList.toggle("is-countdown", phase === "countdown");
        $("gameStartedRoomName").textContent = gameState.roomName || "Lidércjárás";
        $("gameRoundLabel").textContent = gameState.round > 0 ? `JÁTÉK · ${gameState.round}. ÉJSZAKA` : "A KÖD LEERESZKEDIK";
        $("gamePhaseName").textContent = phaseLabels[phase] || "Játék";
        $("gamePhaseBadge").textContent = phaseLabels[phase] || "Játék";
        $("gamePhaseTitle").textContent = phaseTitles[phase] || "Lidércjárás";
        $("gameVoteStatus").hidden = phase !== "day";
        $("gameVoteStatus").textContent = phase === "day" ? `Leadott szavazatok: ${gameState.votesCast || 0} / ${gameState.votesEligible || 0}` : "";
        $("gameFadeOverlay").classList.toggle("is-active", phase === "countdown");
        $("gameFadeOverlay").classList.toggle("is-exiting", phase === "intro");

        if (phase === "game-over") {
            $("gameEndPanel").hidden = false;
            $("gameWinnerTitle").textContent = gameState.winnerLabel || "A játéknak vége";
            $("gameWinnerMessage").textContent = gameState.message || "A történet lezárult.";
            const alreadyReady = rematchReadyIds.includes(socket.id);
            $("gameEndReadyButton").textContent = alreadyReady
                ? "VISSZAVONOM A KÉSZSÉGET"
                : "KÉSZEN ÁLLOK A KÖVETKEZŐ JÁTÉKRA";
            $("rematchReadyStatus").textContent = rematchStatusMessage ||
                `Készen állók a következő menetre: ${rematchReadyCount}/${rematchReadyTotal || (gameState.players || []).filter((player) => player.connected !== false).length}. Ha mindenki kész, visszatértek a váróterembe.`;
        } else {
            $("gameEndPanel").hidden = true;
        }

        const meAlive = isMyselfAlive();
        const teamRole = (myRole === "spirits" && phase === "night-spirits") || (myRole === "hunters" && phase === "night-hunters");
        const activeTeamMembers = myTeamMembers.filter((member) => gameState.players.some((player) => player.id === member.id && player.alive && player.connected !== false));
        const showTeamChat = meAlive && teamRole && activeTeamMembers.length > 1;
        $("gameTeamChatPanel").hidden = !showTeamChat;
        $("gameTeamChatTitle").textContent = myRole === "spirits" ? "Lidércek titkos csatornája" : "Vadászok titkos csatornája";
        $("gameTeamChatHint").textContent = myRole === "spirits"
            ? "Csak az életben lévő lidércek látják ezt a beszélgetést. A többi játékos nem hallja és nem olvassa."
            : "Csak az életben lévő vadászok látják ezt a beszélgetést. A többi játékos nem hallja és nem olvassa.";
        if (myRole === "fool" && phase === "night-fool") {
            // A bolond várakozik, képesség nincs.
        }
        renderPlayers();
        renderActions();
        updateTimer();
    }

    function updateTimer() {
        const timer = $("gameTimer");
        if (!timer || !gameState) return;
        if (!gameState.endsAt) {
            timer.textContent = "—";
            return;
        }
        const secondsLeft = Math.max(0, Math.ceil((gameState.endsAt - Date.now()) / 1000));
        timer.textContent = String(secondsLeft).padStart(2, "0");
    }

    function resetActionIfNewPhase(state) {
        if (state.phase !== currentPhase || state.round !== currentRound) {
            currentPhase = state.phase;
            currentRound = state.round;
            actionSubmitted = false;
            actionStatusMessage = "";
        }
    }

    socket.on("game-started", (payload = {}) => {
        if (payload.room) $("gameStartedRoomName").textContent = payload.room.name || "Lidércjárás";
        myRole = null;
        myRoleLabel = "";
        myRoleDescription = "";
        myTeamMembers = [];
        myHealerUsesRemaining = 2;
        actionSubmitted = false;
        actionStatusMessage = "";
        rematchReadyIds = [];
        rematchReadyCount = 0;
        rematchReadyTotal = 0;
        rematchStatusMessage = "";
        $("gameRoleCard").hidden = true;
        $("gameEndPanel").hidden = true;
        $("gameTeamChatPanel").hidden = true;
    });

    socket.on("private-role", (payload = {}) => {
        myRole = payload.role || null;
        myRoleLabel = payload.label || "Titkos szerep";
        myRoleDescription = payload.roleDescription || "A szereped titkos.";
        myTeamMembers = Array.isArray(payload.teamMembers) ? payload.teamMembers : [];
        if (myRole === "healer") myHealerUsesRemaining = Number.isInteger(payload.healerUsesRemaining) ? payload.healerUsesRemaining : 2;
        renderRoleCard();
        renderGame();
    });

    socket.on("game-state", (state = {}) => {
        resetActionIfNewPhase(state);
        gameState = state;
        renderGame();
        if (state.message) showNotice(state.message, `${state.phase}|${state.round}|${state.message}`);
        else showNotice("");
    });

    socket.on("game-action-ack", (payload = {}) => {
        actionSubmitted = true;
        setActionStatus(payload.message || "A választásodat rögzítettük.");
        renderActions();
    });

    socket.on("game-action-error", (message) => {
        actionSubmitted = false;
        setActionStatus(String(message || "A művelet nem sikerült."), true);
        renderActions();
    });

    socket.on("center-card-revealed", (payload = {}) => {
        const text = `A középső ${Number(payload.cardIndex) + 1}. kártyán ez a szerep volt: ${payload.label || "ismeretlen"}.`;
        setActionStatus(text);
    });

    socket.on("healer-uses-left", (payload = {}) => {
        if (myRole !== "healer") return;
        myHealerUsesRemaining = Math.max(0, Number(payload.remaining) || 0);
        renderGame();
    });

    socket.on("rematch-ready-update", (payload = {}) => {
        rematchReadyIds = Array.isArray(payload.readyIds) ? payload.readyIds : [];
        rematchReadyCount = Number(payload.readyCount) || 0;
        rematchReadyTotal = Number(payload.total) || 0;
        rematchStatusMessage = String(payload.message || "");
        if (gameState && gameState.phase === "game-over") renderGame();
    });

    socket.on("return-to-waiting-room", () => {
        gameState = null;
        myRole = null;
        myRoleLabel = "";
        myRoleDescription = "";
        myTeamMembers = [];
        myHealerUsesRemaining = 2;
        actionSubmitted = false;
        actionStatusMessage = "";
        rematchReadyIds = [];
        rematchReadyCount = 0;
        rematchReadyTotal = 0;
        rematchStatusMessage = "";
        currentPhase = "";
        currentRound = 0;
        $("gameRoleCard").hidden = true;
        $("gameEndPanel").hidden = true;
        $("gameTeamChatPanel").hidden = true;
        $("gameTeamChatMessages").replaceChildren(makeElement("p", "game-chat-empty", "Még nincs üzenet."));
    });

    socket.on("team-chat-message", (payload = {}) => {
        if (!myRole || payload.team !== myRole) return;
        appendChatMessage({ fromName: payload.fromName || "Csapattárs", text: payload.text || "", at: payload.at || Date.now() });
    });

    socket.on("game-ended", (payload = {}) => {
        if (!gameState) return;
        gameState = { ...gameState, phase: "game-over", endsAt: null, winner: payload.winner, winnerLabel: payload.winnerLabel, message: payload.message || payload.winnerLabel };
        renderGame();
    });

    $("gameTeamChatForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const input = $("gameTeamChatInput");
        const text = input.value.trim();
        if (!text) return;
        if (!socket.connected) {
            appendChatMessage({ fromName: "Játékrendszer", text: "Nincs szerverkapcsolat, az üzenet nem ment el.", system: true });
            return;
        }
        socket.emit("team-chat-send", { text });
        input.value = "";
        input.focus();
    });

    $("gameVoiceToggleButton").addEventListener("click", () => {
        if (typeof window.lidercVoiceToggle === "function") window.lidercVoiceToggle();
        else appendChatMessage({ fromName: "Játékrendszer", text: "A hangvezérlés még nem érhető el ezen a felületen.", system: true });
    });

    function leaveGame() {
        if (window.confirm("Biztosan kilépsz a játékból? Ezzel kiesett játékosként folytatódik a játék.")) socket.emit("leave-room");
    }
    $("leaveGameButton").addEventListener("click", leaveGame);
    $("gameEndReadyButton").addEventListener("click", () => {
        const alreadyReady = rematchReadyIds.includes(socket.id);
        socket.emit("ready-next-game", { ready: !alreadyReady });
    });

    timerInterval = window.setInterval(updateTimer, 250);
    window.addEventListener("beforeunload", () => {
        if (timerInterval !== null) window.clearInterval(timerInterval);
    });
})();
