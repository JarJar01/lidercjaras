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
        fool: "☻",
        swapper: "🔄",
        infectious: "☣",
        seer: "🔮",
        landlord: "♜",
        spouses: "💍",
        adventurer: "🧭"
    };
    const phaseLabels = {
        countdown: "Kezdés",
        intro: "Ismerkedés",
        "night-swapper": "Szerepcserélő köre",
        "night-special-spirit": "Bohóc lidérc különleges köre",
        "night-spirits": "Lidércek köre",
        "night-healer": "Gyógyító köre",
        "night-hunters": "Vadászok köre",
        "night-fool": "Bolond köre",
        "night-infectious": "Fertőző köre",
        "night-adventurer": "Kalandor küldetése",
        "night-seer": "Látnok szeánsza",
        "dawn-result": "Hajnalodik",
        day: "Nappal",
        "vote-result": "Szavazás eredménye",
        "game-over": "Játék vége"
    };
    const phaseTitles = {
        countdown: "A sötétség elnyeli a falut",
        intro: "Ismerkedjetek meg egymással",
        "night-swapper": "Titkos szerepcsere",
        "night-special-spirit": "A különleges lidérc dönt",
        "night-spirits": "A lidércek vadásznak",
        "night-healer": "A gyógyító védelmet választ",
        "night-hunters": "A vadászok döntenek",
        "night-fool": "A bolond kivárja az éjszakát",
        "night-infectious": "A fertőzés továbbterjed",
        "night-adventurer": "A Kalandor célpontot keres",
        "night-seer": "A Látnok a holtakkal beszél",
        "dawn-result": "Felszáll a reggeli köd",
        day: "A falu felébred",
        "vote-result": "A falu döntött",
        "game-over": "Véget ért a Lidércjárás"
    };
    const nightPhases = new Set(["night-swapper", "night-special-spirit", "night-spirits", "night-healer", "night-hunters", "night-fool", "night-infectious", "night-adventurer", "night-seer"]);

    let myRole = null;
    let myRoleLabel = "";
    let myRoleDescription = "";
    let myTeamMembers = [];
    let myHealerUsesRemaining = 2;
    let myLivingHealerCount = 1;
    let mySpecialSpirit = false;
    let mySwapperUsed = false;
    let myRoleSwapUsed = false;
    let mySpiritInspectUsed = false;
    let amIInfected = false;
    let infectedPlayerIds = new Set();
    let rematchReadyIds = [];
    let rematchReadyCount = 0;
    let rematchReadyTotal = 0;
    let rematchStatusMessage = "";
    const speakingPlayerIds = new Set();
    let gameState = null;
    let currentPhase = "";
    let currentRound = 0;
    let actionSubmitted = false;
    let hunterActionBlocked = false;
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
        } else if (phase === "night-swapper") {
            if (myRole !== "swapper") {
                panel.appendChild(makeElement("p", "game-muted", "Most a Szerepcserélő titkos szerepcseréje zajlik. A többiek várjanak."));
            } else if (myRoleSwapUsed) {
                panel.appendChild(makeElement("p", "game-muted", "A teljes játékban már felhasználtad a szerepcserédet."));
            } else {
                appendSectionDescription(panel, "Vakon válassz ki egy másik élő játékost. Megkapod a szerepét, ő pedig Falusi lesz. A szerepét előre nem látod, és a csere után nem cserélhet vissza.");
                otherPlayers.forEach((player) => {
                    addChoiceButton(panel, `🔄 Vakon szerepet cserélek: ${player.username}`, () => {
                        setActionStatus("A szerepcsere rögzítve. Az új szereped csak a kör végén jelenik meg.");
                        sendAction("cigan-role-swap", { targetId: player.id });
                    }, "is-neutral");
                });
            }
        } else if (phase === "night-special-spirit") {
            if (myRole !== "spirits" || !mySpecialSpirit) {
                panel.appendChild(makeElement("p", "game-muted", "A Bohóc lidérc titkos képességköre zajlik. A többi játékos várjon."));
            } else if (gameState.specialSpiritActionSubmitted) {
                panel.appendChild(makeElement("p", "game-muted", "Ebben a különleges körben már döntöttél. Várd meg a rendes lidérckört.") );
            } else {
                const livingTeammates = myTeamMembers.filter((member) => players.some((player) => player.id === member.id));
                const sabotageReady = Boolean(gameState.specialSpiritSabotageReady);
                const cooldown = Math.max(0, Number(gameState.specialSpiritSabotageRoundsRemaining) || 0);
                appendSectionDescription(panel, `Bohóc lidércként 20 másodperced van. A szabotázsod 3 körönként használható újra; a szerepvizsgálatot legfeljebb egyszer használhatod a teljes játékban. Ezután a rendes lidérckörben még támadhatsz.`);
                if (sabotageReady) {
                    otherPlayers.forEach((player) => {
                        addChoiceButton(panel, `🎭 Felveszem ezt a nevet: ${player.username}`, () => {
                            setActionStatus("Névfelvétel rögzítve. A célpont a saját nevét látja; a többiek téged a felvett néven látnak.");
                            sendAction("swapper-action", { targetId: player.id, effect: "rename" });
                        }, "is-neutral");
                        addChoiceButton(panel, `🔇 Lenémítom: ${player.username}`, () => {
                            setActionStatus("A némítás rögzítve. Három kör múlva használhatod újra a szabotázst.");
                            sendAction("swapper-action", { targetId: player.id, effect: "mute" });
                        }, "is-danger");
                    });
                } else {
                    panel.appendChild(makeElement("p", "game-muted", `A szabotázs még ${cooldown} körig nem használható.`));
                }
                if (livingTeammates.length <= 1 && !mySpiritInspectUsed) {
                    appendSectionDescription(panel, "Mivel egyedüli lidérc vagy, egyszer a teljes játékban megvizsgálhatod egy másik élő játékos szerepét. Ez a szabotázs időzítésétől független képesség.");
                    otherPlayers.forEach((player) => {
                        addChoiceButton(panel, `☷ Megvizsgálom: ${player.username}`, () => {
                            setActionStatus(`Megvizsgálod ${player.username} szerepét…`);
                            sendAction("special-spirit-inspect", { targetId: player.id });
                        }, "is-neutral");
                    });
                }
                if (!sabotageReady && (livingTeammates.length > 1 || mySpiritInspectUsed)) {
                    panel.appendChild(makeElement("p", "game-muted", "Ebben a különleges körben most nincs használható képességed. A normál lidérckör következik.") );
                }
            }
        } else if (phase === "night-spirits") {
            if (myRole !== "spirits") {
                panel.appendChild(makeElement("p", "game-muted", "A falu alszik. Most a lidércek titkos köre zajlik."));
            } else {
                const livingTeammates = myTeamMembers.filter((member) => players.some((player) => player.id === member.id));
                if (livingTeammates.length <= 1) {
                    appendSectionDescription(panel, mySpecialSpirit
                        ? "Egyedüli Bohóc lidércként megtámadhatsz egy játékost. A különleges képességkörben egyszer névfelvételt, némítást vagy (egyedüliként) szerepvizsgálatot választhattál."
                        : "Egyedüli lidércként megtámadhatsz egy játékost, vagy megvizsgálhatod egy másik élő játékos szerepét. A szerepvizsgálat a teljes játékban egyszer használható.");
                    otherPlayers.forEach((player) => {
                        addChoiceButton(panel, `☾  Megtámadom: ${player.username}`, () => {
                            setActionStatus("A támadási döntés elküldve. Várd meg a kör végét.");
                            sendAction("spirit-action", { type: "attack", targetId: player.id });
                        }, "is-danger");
                    });
                    if (mySpecialSpirit) {
                        panel.appendChild(makeElement("p", "game-muted", "A különleges képességköri döntésed külön történt meg. Ebben a körben most a lidérctámadásról döntesz."));
                    } else if (!mySpiritInspectUsed) {
                        panel.appendChild(makeElement("p", "game-action-description", "Vagy vizsgáld meg egy játékos szerepét. Ezt a lehetőséget csak egyszer használhatod a teljes játék során:"));
                        otherPlayers.forEach((player) => {
                            addChoiceButton(panel, `☷  Megnézem ${player.username} szerepét`, () => {
                                setActionStatus(`Megvizsgálod ${player.username} szerepét…`);
                                sendAction("spirit-action", { type: "inspect", targetId: player.id });
                            }, "is-neutral");
                        });
                    } else {
                        panel.appendChild(makeElement("p", "game-action-description", "A játék során már felhasználtad az egyszeri szerepvizsgálatodat."));
                    }
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
                panel.appendChild(makeElement("p", "game-muted", "A gyógyítók most külön-külön választanak. Ha többen vannak életben, mindegyiküknek ugyanazt a játékost kell választania a sikeres védelemhez."));
            } else {
                if (myLivingHealerCount > 1) {
                    appendSectionDescription(panel, "Több gyógyító van életben, de nem látjátok egymás nevét és nem tudjátok, kik a társaitok. Mindegyikőtök külön szavaz; a védelem csak akkor sikerül, ha minden élő gyógyító ugyanazt a játékost választja.");
                } else {
                    appendSectionDescription(panel, `Egyedüli életben lévő gyógyítóként még ${myHealerUsesRemaining} védési alkalommal rendelkezel. Éjszakánként egyszer használhatod, és saját magadat is megvédheted.`);
                }
                players.forEach((player) => {
                    addChoiceButton(panel, `${player.id === socket.id ? "✚ Saját magam védelme" : `✚ Megvédem: ${player.username}`}`, () => {
                        setActionStatus(myLivingHealerCount > 1
                            ? `A gyógyítói szavazatod rögzítve. Ha minden társad ugyanazt választotta, a védelem sikerül.`
                            : `A védelmi döntés elküldve: ${player.username}.`);
                        sendAction("healer-protect", { targetId: player.id });
                    }, "is-neutral");
                });
            }
        } else if (phase === "night-hunters") {
            if (myRole !== "hunters") {
                panel.appendChild(makeElement("p", "game-muted", "Most a vadászok köre van. A többi falu csendben vár."));
            } else if (hunterActionBlocked) {
                panel.appendChild(makeElement("p", "game-muted", "Ebben az éjszakában nem használhatod a vadász képességedet. Várd meg a reggelt."));
            } else {
                const livingHunters = myTeamMembers.filter((member) => players.some((player) => player.id === member.id));
                appendSectionDescription(panel, livingHunters.length === 1
                    ? "Egyedüli vadászként egy élő játékosra lőhetsz, vagy passzolhatsz. A vadász nem vizsgálhat szerepet. Ha ártatlant lősz le, te is meghalsz."
                    : "Egy lövésed van erre az éjszakára. A többi életben lévő vadásszal titkos chatben és privát hangon is egyeztethetsz. Ha nem lidércet találsz el, a célpont és te is meghaltok. Dönthetsz úgy is, hogy nem lősz.");
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
            panel.appendChild(makeElement("p", "game-muted", myRole === "fool" ? "Nincs éjszakai képességed. Várd meg a reggelt, és próbáld elérni, hogy a falu később kiszavazzon." : "Az éjszaka csendes köre zajlik. Várd meg a reggelt."));
        } else if (phase === "night-infectious") {
            if (myRole !== "infectious") {
                panel.appendChild(makeElement("p", "game-muted", "A Fertőző most titokban kiválasztja a következő célpontját."));
            } else {
                appendSectionDescription(panel, "Minden éjszaka egy még nem fertőzött, élő játékost jelölhetsz meg. A nyilvános napló nem árulja el, kit fertőztél meg. Csak te látod a fertőzött játékosok jelzését.");
                const candidates = otherPlayers.filter((player) => !infectedPlayerIds.has(player.id));
                if (!candidates.length) {
                    panel.appendChild(makeElement("p", "game-muted", "Már minden más élő játékos fertőzött. Ha ez reggelig is így marad, megnyered a játékot."));
                } else {
                    candidates.forEach((player) => {
                        addChoiceButton(panel, `☣ Megfertőzöm: ${player.username}`, () => {
                            setActionStatus("A fertőzési célpont rögzítve. A többiek csak annyit látnak majd, hogy valaki megfertőződött.");
                            sendAction("infectious-action", { targetId: player.id });
                        }, "is-danger");
                    });
                }
            }
        } else if (phase === "night-adventurer") {
            if (myRole !== "adventurer") {
                panel.appendChild(makeElement("p", "game-muted", "A Kalandor most titkos küldetésen van. A többiek várjanak."));
            } else {
                const tasks = Array.isArray(gameState.adventurerTasks) ? gameState.adventurerTasks : [];
                const nextTask = tasks.find((task) => !task.solved);
                tasks.forEach((task) => {
                    panel.appendChild(makeElement("p", `game-adventurer-task${task.solved ? " is-solved" : ""}`, `${task.solved ? "✓" : "○"} Találd meg: ${task.label}${task.solved ? ` — ${task.targetName || "megtalálva"}` : ""}`));
                });
                if (gameState.adventurerTurnFailed) {
                    panel.appendChild(makeElement("p", "game-adventurer-failed", "Rossz tipp! A köröd erre az éjszakára véget ért. Következő éjszaka újra próbálkozhatsz.") );
                } else if (!nextTask) {
                    panel.appendChild(makeElement("p", "game-muted", "Mindhárom szerepet megtaláltad."));
                } else {
                    appendSectionDescription(panel, `Küldetés ${tasks.filter((task) => task.solved).length + 1}/3: találd meg a(z) ${nextTask.label} szerepű játékost. Egyetlen tipp van erre a feladatra ezen az éjszakán. Helyes válasznál zöld jelzést kapsz és jöhet a következő; hibás válasznál a köröd véget ér. Minden három feladatot el kell találnod a győzelemhez.`);
                    gameState.players.filter((player) => player.id !== socket.id && player.connected !== false).forEach((player) => {
                        addChoiceButton(panel, `🧭 ${player.username}${player.alive ? "" : " · kiesett"}`, () => {
                            setActionStatus(`Tipp elküldve: ${player.username}.`);
                            sendAction("adventurer-guess", { roleKey: nextTask.role, targetId: player.id });
                        }, player.alive ? "is-neutral" : "is-danger");
                    });
                }
            }
        } else if (phase === "night-seer") {
            if (myRole === "seer" && isMyselfAlive()) {
                panel.appendChild(makeElement("p", "game-muted", "A szeánsz idején a Látnok csak hangon beszélhet a halottakkal. Szöveges chat nincs; az élők más játékosai nem hallják ezt a csatornát."));
            } else if (!isMyselfAlive()) {
                panel.appendChild(makeElement("p", "game-muted", "A Látnok szeánszot tart. Ebben a rövid körben csak a Látnokkal beszélhetsz hangon; a többi élő játékos nem hallja."));
            } else {
                panel.appendChild(makeElement("p", "game-muted", "A Látnok a holtakkal beszél. A falu alszik."));
            }
        } else if (phase === "dawn-result") {
            panel.appendChild(makeElement("p", "game-muted", "A reggeli eredmény mindjárt megjelenik. A voice chat nappal ismét elérhető az életben maradt játékosoknak."));
        } else if (phase === "day") {
            appendSectionDescription(panel, "Beszéljétek meg, mi történhetett, majd adj le egy szavazatot. A szavazatodat nem lehet módosítani. A SKIP azt jelenti, hogy senkit nem szeretnél kiszavazni.");
            players.forEach((player) => {
                const label = player.id === socket.id ? "Magamra szavazok" : `Szavazok rá: ${player.username}`;
                addChoiceButton(panel, label, () => {
                    setActionStatus(`A szavazatod elküldve: ${player.id === socket.id ? "magadra" : player.username}.`);
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
        const showVotes = ["day", "vote-result"].includes(gameState.phase);
        const votesByVoter = new Map((gameState.voteDetails || []).map((vote) => [vote.voterId, vote]));
        const voteCounts = gameState.voteCounts && typeof gameState.voteCounts === "object" ? gameState.voteCounts : {};
        gameState.players.forEach((player) => {
            const dead = !player.alive || player.connected === false;
            const canShowSpeaker = speakingPlayerIds.has(player.id) && (!dead || gameState.phase === "game-over");
            const row = makeElement("div", `game-player-row${dead ? " is-dead" : ""}${canShowSpeaker ? " is-speaking" : ""}`);
            const avatarWrap = makeElement("span", "game-player-avatar-wrap");
            const avatar = makeElement("span", "game-player-avatar", dead ? "†" : player.username.slice(0, 1).toLocaleUpperCase("hu-HU"));
            avatarWrap.appendChild(avatar);
            if (showVotes) {
                const voteCount = Number(voteCounts[player.id]) || 0;
                avatarWrap.appendChild(makeElement("span", "game-vote-count-badge", String(voteCount)));
            }
            const info = makeElement("div", "game-player-info");
            info.appendChild(makeElement("strong", "", player.username + (player.id === socket.id ? " (te)" : "")));
            info.appendChild(makeElement("span", "", dead ? "Kiesett" : (player.isHost ? "Házigazda · életben" : "Életben")));
            if (canShowSpeaker) {
                info.appendChild(makeElement("span", "game-speaking-badge", "🎙 Éppen beszél"));
            }
            if (myRole === "infectious" && infectedPlayerIds.has(player.id)) {
                info.appendChild(makeElement("span", "game-infected-badge", "☣ Fertőzött (csak neked látszik)"));
            }
            if (player.id === socket.id && gameState.infectedSelf) {
                info.appendChild(makeElement("span", "game-infected-badge", "☣ Megfertőződtél"));
            }
            if (showVotes) {
                const vote = votesByVoter.get(player.id);
                if (vote) {
                    const label = vote.submitted ? "Szavazott" : "Még nem szavazott";
                    info.appendChild(makeElement("span", `game-player-vote${vote.submitted ? "" : " is-pending"}`, label));
                } else if (gameState.phase === "day" && !dead) {
                    info.appendChild(makeElement("span", "game-player-vote is-pending", "Még nem szavazott"));
                }
            }
            row.append(avatarWrap, info);
            const publicVoicePhases = new Set(["intro", "dawn-result", "day", "vote-result", "game-over"]);
            if (player.id !== socket.id && publicVoicePhases.has(gameState.phase) && typeof window.lidercRenderPlayerVoiceControls === "function") {
                const voiceControls = window.lidercRenderPlayerVoiceControls(player, "game");
                if (voiceControls) row.appendChild(voiceControls);
            }
            row.appendChild(makeElement("span", "game-player-status", dead ? "✕" : "●"));
            container.appendChild(row);
        });
    }

    window.lidercGameRefreshPlayers = renderPlayers;

    function renderPublicLog() {
        const panel = $("gamePublicLogPanel");
        const messages = $("gamePublicLogMessages");
        if (!panel || !messages || !gameState) return;
        const entries = Array.isArray(gameState.lastNightLog) ? gameState.lastNightLog : [];
        messages.replaceChildren();
        entries.forEach((entry) => {
            messages.appendChild(makeElement("div", "game-public-log-entry", entry.text || "Éjszakai esemény történt."));
        });
        panel.hidden = entries.length === 0;
    }

    function renderRoleCard() {
        const panel = $("gameRoleCard");
        if (!panel || !myRole) return;
        panel.hidden = false;
        panel.classList.toggle("is-clown-spirit", mySpecialSpirit);
        $("gameRoleSymbol").textContent = mySpecialSpirit ? "🎭" : (roleSymbols[myRole] || "✦");
        $("gameRoleName").textContent = myRoleLabel || "Titkos szerep";
        $("gameRoleDescription").textContent = myRoleDescription || "A szereped titkos. Figyeld a játékmenetet.";
        const teamLine = $("gameRoleTeamMembers");
        if (teamLine) {
            const teammates = myTeamMembers.filter((member) => member.id !== socket.id).map((member) => member.username);
            teamLine.hidden = teammates.length === 0;
            teamLine.textContent = teammates.length ? `A szereped társai: ${teammates.join(", ")}.` : "";
        }
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
        const canUseSeance = Boolean(gameState.seerChannelAvailable && ((myRole === "seer" && meAlive) || !meAlive));
        const activeTeamRole = canUseSeance && phase === "night-seer" ? "seance" :
            (myRole === "spirits" && ["night-special-spirit", "night-spirits"].includes(phase)) ? "spirits" :
            (myRole === "hunters" && phase === "night-hunters") ? "hunters" :
            (myRole === "spouses" && nightPhases.has(phase) && phase !== "night-seer") ? "spouses" : null;
        const activeTeamMembers = myTeamMembers.filter((member) => gameState.players.some((player) => player.id === member.id && player.alive && player.connected !== false));
        const showTeamChat = Boolean(activeTeamRole && activeTeamRole !== "seance" && meAlive && (activeTeamRole === "spouses" ? activeTeamMembers.length >= 1 : activeTeamMembers.length > 1));
        $("gameTeamChatPanel").hidden = !showTeamChat;
        $("gameTeamChatTitle").textContent = activeTeamRole === "hunters" ? "Vadászok titkos csatornája" :
            activeTeamRole === "spouses" ? "Házastársak titkos csatornája" :
            activeTeamRole === "seance" ? "Látnok és halottak csatornája" : "Lidércek titkos csatornája";
        $("gameTeamChatHint").textContent = activeTeamRole === "hunters"
            ? "Csak az életben lévő vadászok látják és hallják ezt a beszélgetést."
            : activeTeamRole === "spouses"
                ? "Csak te és a házastársad látjátok ezt a privát beszélgetést éjszaka."
                : activeTeamRole === "seance"
                    ? "A Látnok és a halott játékosok beszélhetnek itt. Az élők többi tagja nem látja ezt a csatornát."
                    : "Csak az életben lévő lidércek látják és hallják ezt a beszélgetést. A többi játékos nem kapja meg a hangot vagy az üzeneteket.";
        if (myRole === "fool" && phase === "night-fool") {
            // A bolond várakozik, képesség nincs.
        }
        renderPlayers();
        renderPublicLog();
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
            hunterActionBlocked = false;
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
        myLivingHealerCount = 1;
        mySpecialSpirit = false;
        mySwapperUsed = false;
        myRoleSwapUsed = false;
        mySpiritInspectUsed = false;
        amIInfected = false;
        infectedPlayerIds = new Set();
        actionSubmitted = false;
        hunterActionBlocked = false;
        actionStatusMessage = "";
        rematchReadyIds = [];
        rematchReadyCount = 0;
        rematchReadyTotal = 0;
        rematchStatusMessage = "";
        speakingPlayerIds.clear();
        $("gameRoleCard").hidden = true;
        $("gameEndPanel").hidden = true;
        $("gameTeamChatPanel").hidden = true;
    });

    socket.on("private-role", (payload = {}) => {
        myRole = payload.role || null;
        myRoleLabel = payload.label || "Titkos szerep";
        myRoleDescription = payload.roleDescription || "A szereped titkos.";
        myTeamMembers = Array.isArray(payload.teamMembers) ? payload.teamMembers : [];
        mySpecialSpirit = Boolean(payload.specialSpirit);
        mySwapperUsed = Boolean(payload.swapperUsed);
        myRoleSwapUsed = Boolean(payload.roleSwapUsed);
        mySpiritInspectUsed = Boolean(payload.spiritInspectUsed);
        myLivingHealerCount = Math.max(1, Number(payload.livingHealerCount) || 1);
        infectedPlayerIds = myRole === "infectious" ? new Set(Array.isArray(payload.infectedPlayerIds) ? payload.infectedPlayerIds : []) : new Set();
        if (myRole === "healer") myHealerUsesRemaining = Number.isInteger(payload.healerUsesRemaining) ? payload.healerUsesRemaining : 2;
        renderRoleCard();
        renderGame();
    });

    socket.on("role-swap-used", (payload = {}) => {
        myRoleSwapUsed = Boolean(payload.used);
        renderRoleCard();
        renderActions();
    });

    socket.on("swapper-used", (payload = {}) => {
        mySwapperUsed = Boolean(payload.used);
        renderRoleCard();
        renderActions();
    });

    socket.on("game-state", (state = {}) => {
        if (gameState && state.phase !== gameState.phase) speakingPlayerIds.clear();
        resetActionIfNewPhase(state);
        gameState = state;
        amIInfected = Boolean(state.infectedSelf);
        renderGame();
        if (state.message) showNotice(state.message, `${state.phase}|${state.round}|${state.message}`);
        else showNotice("");
    });

    socket.on("player-speaking", (payload = {}) => {
        if (!payload.playerId) return;
        if (payload.speaking) speakingPlayerIds.add(payload.playerId);
        else speakingPlayerIds.delete(payload.playerId);
        renderPlayers();
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

    socket.on("hunter-action-locked", (payload = {}) => {
        hunterActionBlocked = true;
        actionSubmitted = true;
        setActionStatus(payload.message || "Ebben az éjszakában nem használhatod a vadász képességedet.");
        renderActions();
    });

    socket.on("player-role-revealed", (payload = {}) => {
        setActionStatus(`${payload.targetName || "A játékos"} szerepe: ${payload.label || "ismeretlen"}. Ezt az információt csak te látod.`);
    });

    socket.on("role-change-notice", (payload = {}) => {
        setActionStatus(String(payload.message || "A szereped megváltozott."));
        appendChatMessage({ fromName: "Játékrendszer", text: String(payload.message || "A szereped megváltozott."), system: true });
    });

    socket.on("infectious-state", (payload = {}) => {
        if (myRole !== "infectious") return;
        infectedPlayerIds = new Set(Array.isArray(payload.infectedPlayerIds) ? payload.infectedPlayerIds : []);
        renderGame();
    });

    socket.on("infection-self-status", (payload = {}) => {
        amIInfected = Boolean(payload.infected);
        if (gameState) gameState.infectedSelf = amIInfected;
        renderGame();
    });

    socket.on("spirit-inspect-used", (payload = {}) => {
        mySpiritInspectUsed = Boolean(payload.used);
        renderActions();
    });

    socket.on("healer-status", (payload = {}) => {
        if (myRole !== "healer") return;
        myLivingHealerCount = Math.max(0, Number(payload.livingCount) || 0);
        myHealerUsesRemaining = Math.max(0, Number(payload.usesRemaining) || 0);
        renderGame();
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
        infectedPlayerIds = new Set();
        actionSubmitted = false;
        hunterActionBlocked = false;
        actionStatusMessage = "";
        rematchReadyIds = [];
        rematchReadyCount = 0;
        rematchReadyTotal = 0;
        rematchStatusMessage = "";
        speakingPlayerIds.clear();
        currentPhase = "";
        currentRound = 0;
        $("gameRoleCard").hidden = true;
        $("gameEndPanel").hidden = true;
        $("gameTeamChatPanel").hidden = true;
        $("gameTeamChatMessages").replaceChildren(makeElement("p", "game-chat-empty", "Még nincs üzenet."));
    });

    socket.on("team-chat-message", (payload = {}) => {
        if (!myRole) return;
        if (payload.team === "seance") {
            const seanceViewer = Boolean(gameState?.seerChannelAvailable && ((myRole === "seer" && isMyselfAlive()) || !isMyselfAlive()));
            if (!seanceViewer) return;
        } else if (payload.team !== myRole) {
            return;
        }
        appendChatMessage({ fromName: payload.fromName || "Csapattárs", text: payload.text || "", at: payload.at || Date.now() });
    });

    socket.on("adventurer-guess-result", (payload = {}) => {
        // A Kalandor új tippelése csak helyes válasz után engedélyezett ugyanabban az éjszakai körben.
        actionSubmitted = !payload.correct;
        setActionStatus(payload.message || (payload.correct ? "Helyes találat!" : "Nem talált."), !payload.correct);
        showNotice(payload.message || "Kalandor-tipp kiértékelve.", `adventurer|${payload.roleKey}|${payload.targetId}|${payload.correct}`);
        renderActions();
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
