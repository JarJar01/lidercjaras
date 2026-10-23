(() => {
  "use strict";
  const BASE = "/game/";
  let questionBank = null;
  const fallbackQuestionBank = {
    white: ["Mondj el egy kínos, de vicces randitörténetet!", "Ki a társaság legnagyobb bajkeverője, és miért?"],
    yellow: ["Melyik emlékedet mesélnéd el legszívesebben a társaságnak?", "Válassz valakit, aki mondjon rólad egy vicces történetet!"],
    red: ["Tartsatok egy közös, alkoholmentes koccintást!", "Mindenki mondjon egy vicces szót a körből!"],
    curses: [], shields: [], boosts: []
  };
  const bankReady = fetch(`${BASE}question-bank.json?v=20261023-19`).then((response) => {
    if (!response.ok) throw new Error("A kérdésbank nem tölthető be.");
    return response.json();
  }).then((data) => { questionBank = data; return data; }).catch((error) => {
    console.error("Kiiszik: a kérdésbank betöltése nem sikerült, alap kérdéseket használok.", error);
    questionBank = fallbackQuestionBank;
    return questionBank;
  });

  const app = {
    root: null, ui: {}, mode: null, socket: null, state: null,
    local: null, tickHandle: null, localTimerHandle: null, localMoveHandle: null,
    currentWhiteOptionId: null, selectedChatTab: "chat", noticeHandle: null,
    media: {}, mediaOriginals: [], localCameraCard: null, localCameraName: null, running: false, lastHandledTimeoutTurn: null, diceAnimationInterval: null, diceAnimationTimeout: null, diceHideTimeout: null, diceRollActive: false, diceResultVisible: false, avatarUrl: null
  };

  function byId(id) { return app.root ? app.root.querySelector(`#${id}`) : null; }
  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function makeBoard() {
    return Array.from({ length: 100 }, () => {
      const r = Math.random();
      return r < 0.54 ? "white" : r < 0.82 ? "yellow" : "red";
    });
  }
  // 100 mezőből álló, befelé csavarodó útvonal egy ház alaprajzán.
  // A koordináták külön függvényben vannak, így az animáció is a látható úton halad.
  function makeSpiralPath(count = 100, columns = 16, rows = 10) {
    // Széles, képernyőarányú tábla: a spirál a teljes 16×10-es alapot kitölti.
    const path = [];
    let top = 0, right = columns - 1, bottom = rows - 1, left = 0;
    while (top <= bottom && left <= right && path.length < count) {
      for (let col = left; col <= right && path.length < count; col += 1) path.push({ row: top, col });
      top += 1;
      for (let row = top; row <= bottom && path.length < count; row += 1) path.push({ row, col: right });
      right -= 1;
      for (let col = right; col >= left && path.length < count && top <= bottom; col -= 1) path.push({ row: bottom, col });
      bottom -= 1;
      for (let row = bottom; row >= top && path.length < count && left <= right; row -= 1) path.push({ row, col: left });
      left += 1;
    }
    return path.slice(0, count);
  }
  const SPIRAL_PATH = makeSpiralPath(100, 16, 10);
  function sampleTwo(values) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, 2).map((text, index) => ({ id: `opt-${index}`, text }));
  }
  function makeStaticUi() {
    if (app.root) return;
    const root = document.createElement("section");
    root.id = "kiiszik-game-overlay";
    root.className = "kg-overlay";
    root.hidden = true;
    root.setAttribute("aria-label", "Kiiszik játéktér");
    root.innerHTML = `
      <header class="kg-topbar">
        <div class="kg-topbar-spacer" aria-hidden="true"></div>
        <div class="kg-top-controls">
          <button class="kg-top-button" id="kg-pause-toggle" type="button">⏸ Szünet</button>
          <button class="kg-top-button is-danger" id="kg-exit-button" type="button">Kilépés</button>
        </div>
        <div class="kg-game-status" id="kg-game-status" hidden></div>
      </header>
      <div class="kg-camera-strip" id="kg-camera-strip">
        <div class="kg-camera-title"><span>📹</span><div>JÁTÉKOS KAMERÁK<br><small>balról jobbra</small></div></div>
        <div class="kg-camera-rail" id="kg-camera-rail">
          <div class="kg-camera-empty" id="kg-camera-empty">A kamerát bekapcsoló játékosok itt jelennek meg.</div>
        </div>
      </div>
      <div class="kg-media-toolbar">
        <span class="kg-media-toolbar-label">🎧 Hang és kép</span>
        <button class="kg-top-button" id="kg-mic-toggle" type="button">🎙 Mikrofon: KI</button>
        <button class="kg-top-button" id="kg-camera-toggle" type="button">📷 Webkamera: KI</button>
        <span class="kg-media-hint">A mikrofon és a kamera külön kapcsolható.</span>
      </div>
      <div class="kg-status-banner" id="kg-pause-banner" hidden>⏸ A parti szünetel, amíg a társaság megszavazza a folytatást.</div>
      <main class="kg-main">
        <aside class="kg-left-sidebar" aria-label="Játékpanelek">
          <button type="button" class="kg-sidebar-button" id="kg-sidebar-log-toggle" aria-controls="kg-left-log-drawer" aria-expanded="false"><span>📜</span><small>Esemény-<br>napló</small></button>
          <button type="button" class="kg-sidebar-button" id="kg-sidebar-hand-toggle" aria-controls="kg-left-hand-drawer" aria-expanded="false"><span>🃏</span><small>Kártyáim</small><b class="kg-sidebar-count" id="kg-card-count">0</b></button>
          <section class="kg-left-drawer kg-log-panel" id="kg-left-log-drawer" hidden>
            <div class="kg-drawer-heading"><h3>📜 Eseménynapló</h3><button type="button" class="kg-drawer-close" id="kg-sidebar-close-toggle" aria-label="Oldalsáv bezárása">×</button></div>
            <div class="kg-game-logs" id="kg-game-logs"></div>
          </section>
          <section class="kg-left-drawer kg-card-panel" id="kg-left-hand-drawer" hidden>
            <div class="kg-drawer-heading"><h3>🃏 Kártyáim</h3><span class="kg-card-count" id="kg-drawer-card-count">0</span></div>
            <div class="kg-hand" id="kg-hand"><div class="kg-card-empty">Nincs kártyád. Néha a mezőkön találsz egyet.</div></div>
          </section>
        </aside>
        <section class="kg-panel kg-board-wrap">
          <div class="kg-panel-heading"><div><p class="kg-eyebrow">KIISZIK · 100 MEZŐ</p><h2>KIISZIK PÁLYA</h2></div><div class="kg-game-status" id="kg-position-summary">🚪 Start → 🚽 Cél</div></div>
          <div class="kg-board-surface" id="kg-board-surface">
            <div class="kg-entrance-zone" id="kg-entrance-marker"><span>🚪 BEJÁRAT / START</span><span class="kg-start-tokens" id="kg-start-tokens"></span></div>
            <div class="kg-tile-grid" id="kg-tile-grid"></div>
            <div class="kg-moving-token" id="kg-moving-token" aria-hidden="true"></div>
            <section class="kg-panel kg-turn-panel kg-roll-stage">
              <div class="kg-turn-line"><div class="kg-turn-summary"><p class="kg-eyebrow">SORON KÖVETKEZIK</p><div class="kg-turn-playerline"><span class="kg-turn-avatar" id="kg-turn-avatar">🙂</span><div class="kg-turn-name" id="kg-turn-name">Játékos</div></div><div class="kg-turn-subtitle" id="kg-turn-subtitle">Dobj a kockával!</div></div><div class="kg-timer" id="kg-timer">60</div></div>
              <div class="kg-progress"><span id="kg-progress-bar"></span></div>
              <div class="kg-turn-actions"><button class="kg-dice-button" id="kg-dice-button" type="button"><span class="kg-dice-cube" id="kg-dice-face">⚄</span><span class="kg-dice-label">DOBÁS</span></button></div>
              <div class="kg-current-status" id="kg-current-status" role="status" aria-live="polite">A parti készen áll.</div>
              <div class="kg-roll-info" id="kg-roll-info">Dobás után mezőről mezőre lépsz</div>
            </section>
          </div>
          <div class="kg-board-footer"><div class="kg-legend"><span><i class="white"></i> Fehér · szivass</span><span><i class="yellow"></i> Sárga · te vagy soron</span><span><i class="red"></i> Piros · mindenki</span></div></div>
        </section>
        <aside class="kg-right-sidebar">
          <section class="kg-panel kg-chat-panel"><div class="kg-drawer-heading"><h3 class="kg-list-heading">💬 Parti chat</h3></div><div class="kg-chat-messages" id="kg-chat-messages"></div><form class="kg-chat-form" id="kg-chat-form"><input id="kg-chat-input" maxlength="180" placeholder="Üzenet a társaságnak…" autocomplete="off"><button type="submit">Küldés</button></form></section>
        </aside>
      </main>

      <div class="kg-pause-vote-modal" id="kg-pause-vote-modal" hidden role="dialog" aria-modal="true" aria-labelledby="kg-pause-vote-title">
        <div class="kg-pause-vote-backdrop"></div>
        <section class="kg-pause-vote-card">
          <div class="kg-pause-vote-icon">⏸</div>
          <h2 id="kg-pause-vote-title">Szünet szavazás</h2>
          <p id="kg-pause-vote-text">Egy játékos szünetet szeretne kérni.</p>
          <div class="kg-pause-vote-counts" id="kg-pause-vote-counts">Igen: 0 · Nem: 0</div>
          <div class="kg-pause-vote-buttons">
            <button type="button" id="kg-pause-vote-yes" class="kg-pause-vote-yes">Igen</button>
            <button type="button" id="kg-pause-vote-no" class="kg-pause-vote-no">Nem</button>
          </div>
        </section>
      </div>
      <div class="kg-task-modal" id="kg-task-modal" hidden role="dialog" aria-modal="true" aria-label="Mezőkártya">
        <div class="kg-task-modal-backdrop"></div>
        <div class="kg-task-modal-stage">
          <div class="kg-task-modal-caption"><span>🃏</span><div><strong>MEZŐKÁRTYA</strong><small>A feladat és a szavazás itt jelenik meg</small></div></div>
          <section class="kg-panel kg-action-panel kg-task-card" id="kg-action-panel">
            <div class="kg-panel-heading"><h3>Mező feladata</h3><span class="kg-action-type" id="kg-action-type">KÖVETKEZIK</span></div>
            <div id="kg-action-content"><p class="kg-small-note">Dobj a kockával, és nézd meg, milyen mezőre érkezel.</p></div>
            <button class="kg-next-button" id="kg-next-button" type="button" hidden>Következő játékos →</button>
          </section>
        </div>
      </div>
      <div class="kg-finish-overlay" id="kg-finish-overlay" hidden><div class="kg-finish-card"><div class="kg-finish-icon">🚽🎉</div><h2 id="kg-finish-title">Megvan a WC!</h2><p id="kg-finish-copy">A parti véget ért.</p><button id="kg-finish-exit" type="button">Vissza a lobbyba</button><div class="kg-privacy-note">A Kiiszik 18+ társasjáték. Játsszatok felelősen, és tartsátok tiszteletben, ha valaki passzol.</div></div></div>
      <div class="kg-slap-impact" id="kg-slap-impact" aria-hidden="true"><span>🖐️</span><strong>💥 KIÜTÉS! 💥</strong></div>
      <div class="kg-notice" id="kg-notice" hidden></div>`;
    document.body.append(root);
    app.root = root;
    // A markup azonosítói kebab-case formájúak (pl. dice-button), a kód viszont
    // camelCase property-ket használ (pl. app.ui.diceButton). Konvertáljuk azokat,
    // mielőtt az eseménykezelőket bekötnénk; enélkül a játékindítás azonnal hibára fut.
    ["game-status", "task-modal", "pause-vote-modal", "pause-vote-title", "pause-vote-text", "pause-vote-counts", "pause-vote-yes", "pause-vote-no", "camera-rail", "turn-avatar", "mic-toggle", "camera-toggle", "pause-toggle", "exit-button", "camera-strip", "camera-empty", "pause-banner", "position-summary", "board-surface", "entrance-marker", "start-tokens", "tile-grid", "moving-token", "turn-name", "turn-subtitle", "timer", "progress-bar", "dice-button", "dice-face", "roll-info", "current-status", "action-type", "action-content", "next-button", "card-count", "drawer-card-count", "hand", "chat-messages", "chat-form", "chat-input", "game-logs", "left-log-drawer", "left-hand-drawer", "sidebar-log-toggle", "sidebar-hand-toggle", "sidebar-close-toggle", "finish-overlay", "finish-title", "finish-copy", "finish-exit", "notice", "slap-impact"].forEach((id) => {
      const property = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      app.ui[property] = byId(`kg-${id}`);
    });
    app.ui.turnPanel = app.root.querySelector(".kg-turn-panel");
    app.ui.actionPanel = byId("kg-action-panel");
    app.ui.diceButton.addEventListener("click", roll);
    app.ui.nextButton.addEventListener("click", completeTurn);
    app.ui.pauseToggle.addEventListener("click", togglePause);
    app.ui.pauseVoteYes.addEventListener("click", () => answerPauseVote(true));
    app.ui.pauseVoteNo.addEventListener("click", () => answerPauseVote(false));
    app.ui.exitButton.addEventListener("click", stop);
    app.ui.finishExit.addEventListener("click", stop);
    app.ui.chatForm.addEventListener("submit", sendChat);
    app.ui.micToggle.addEventListener("click", () => toggleMedia("microphone"));
    app.ui.cameraToggle.addEventListener("click", () => toggleMedia("camera"));
    const toggleDrawer = (which) => {
      const target = which === "logs" ? app.ui.leftLogDrawer : app.ui.leftHandDrawer;
      const other = which === "logs" ? app.ui.leftHandDrawer : app.ui.leftLogDrawer;
      const open = target.hidden;
      app.ui.leftLogDrawer.hidden = true;
      app.ui.leftHandDrawer.hidden = true;
      app.ui.leftLogDrawer.classList.remove("is-open");
      app.ui.leftHandDrawer.classList.remove("is-open");
      target.hidden = !open;
      target.classList.toggle("is-open", open);
      app.ui.sidebarLogToggle.setAttribute("aria-expanded", String(open && which === "logs"));
      app.ui.sidebarHandToggle.setAttribute("aria-expanded", String(open && which === "hand"));
    };
    app.ui.sidebarLogToggle.addEventListener("click", () => toggleDrawer("logs"));
    app.ui.sidebarHandToggle.addEventListener("click", () => toggleDrawer("hand"));
    app.ui.sidebarCloseToggle.addEventListener("click", () => {
      app.ui.leftLogDrawer.hidden = true; app.ui.leftHandDrawer.hidden = true;
      app.ui.sidebarLogToggle.setAttribute("aria-expanded", "false");
      app.ui.sidebarHandToggle.setAttribute("aria-expanded", "false");
    });
  }

  function setNotice(message, collision = false) {
    if (!app.ui.notice) return;
    app.ui.notice.textContent = message;
    app.ui.notice.classList.toggle("is-collision", collision);
    app.ui.notice.hidden = false;
    if (app.noticeHandle) clearTimeout(app.noticeHandle);
    app.noticeHandle = setTimeout(() => { if (app.ui.notice) app.ui.notice.hidden = true; }, 4000);
  }
  function setStatus(message) { if (app.ui.currentStatus) app.ui.currentStatus.textContent = message || ""; }
  function currentPlayer(state = app.state) { return state?.players?.find((player) => player.id === state.currentPlayerId) || null; }
  function displayPlayerName(player) { return player && player.nickname && Number(player.nicknameTurns) > 0 ? player.nickname : (player?.name || "Játékos"); }
  function localActive() { return app.mode === "local" && app.local ? app.local.players[app.local.turnIndex] : null; }
  function canControlTurn(state = app.state) {
    if (!state || state.gameOver || state.paused) return false;
    if (app.mode === "local") return Boolean(app.local && state.currentPlayerId === app.local.players[app.local.turnIndex]?.id);
    return Boolean(app.socket && state.currentPlayerId === app.socket.id);
  }
  function myCardHand(state = app.state) {
    if (!state) return [];
    if (app.mode === "local") return localActive()?.cards || [];
    return Array.isArray(state.privateHand) ? state.privateHand : [];
  }
  function addLocalLog(message, type = "info") {
    if (!app.local) return;
    app.local.logs.push({ id: `l-${Date.now()}-${Math.random()}`, at: Date.now(), message, type });
    if (app.local.logs.length > 40) app.local.logs.splice(0, app.local.logs.length - 40);
  }
  function render() {
    const state = app.state;
    if (!app.root || !state) return;
    // A játéktér felső sávjából eltávolítottuk a státuszfeliratot; az elem rejtve marad,
    // hogy a játék többi kódja továbbra is frissíthesse a belső státuszát.
    app.ui.gameStatus.textContent = app.mode === "online" ? `ONLINE · ${state.roomCode || "SZOBÁBAN"}` : "EGY KÉSZÜLÉKEN · HELYI PARTI";
    reorderRemoteCameras(state);
    app.ui.pauseBanner.hidden = !state.paused;
    app.ui.pauseToggle.textContent = app.mode === "local"
      ? (state.paused ? "▶ Folytatás" : "⏸ Szünet")
      : (state.paused ? "▶ Folytatás kérése" : "⏸ Szünet kérése");
    app.ui.pauseToggle.classList.toggle("is-on", Boolean(state.paused));
    renderPauseRequest(state);
    app.root.classList.toggle("kg-local-mode", app.mode === "local");
    app.ui.taskModal.hidden = !state.pending;
    app.ui.taskModal.classList.toggle("type-white", state.pending?.type === "white");
    app.ui.taskModal.classList.toggle("type-yellow", state.pending?.type === "yellow");
    app.ui.taskModal.classList.toggle("type-red", state.pending?.type === "red");
    app.ui.pauseToggle.hidden = false;
    app.ui.micToggle.hidden = app.mode === "local";
    app.ui.cameraToggle.hidden = app.mode === "local";
    const active = currentPlayer(state);
    app.ui.turnName.textContent = displayPlayerName(active);
    setPlayerAvatar(app.ui.turnAvatar, active ? { ...active, name: displayPlayerName(active) } : active, initials(displayPlayerName(active)));
    const localCanRoll = canControlTurn(state) && state.phase === "turn" && !state.pending;
    app.ui.turnPanel.hidden = !(localCanRoll || app.diceRollActive);
    app.ui.turnPanel.classList.toggle("is-your-turn", localCanRoll);
    const activeState = state.players.find((player) => player.id === state.currentPlayerId);
    const currentPos = activeState ? activeState.position : 0;
    const activeEffects = [];
    if (active?.nicknameTurns > 0 && active.nickname) activeEffects.push(`🏷️ ${active.nickname}: még ${active.nicknameTurns} kör`);
    if (active?.barkTurns > 0) activeEffects.push(`🐶 Ugatási átok: ${active.barkTurns} kör`);
    if (active?.flamingoTurns > 0) activeEffects.push("🦩 Flamingó-átok: 5 mp-es póz dobás előtt");
    app.ui.turnSubtitle.textContent = state.gameOver ? "A parti véget ért." : state.phase === "moving" ? "A bábu ugrál a pályán…" : state.pending ? "" : [`Mező ${currentPos}/100 · ${state.turnNumber || 1}. kör`, ...activeEffects].join(" · ");
    let seconds = 0;
    if (state.paused) seconds = 0;
    else if (state.turnEndsAt) seconds = Math.max(0, Math.ceil((state.turnEndsAt - Date.now()) / 1000));
    app.ui.timer.textContent = state.paused ? "Ⅱ" : String(seconds).padStart(2, "0");
    app.ui.timer.classList.toggle("is-low", !state.paused && seconds <= 10);
    app.ui.progressBar.style.width = `${state.paused ? 0 : Math.min(100, Math.max(0, seconds / 60 * 100))}%`;
    app.ui.diceButton.disabled = !(canControlTurn(state) && state.phase === "turn" && !state.pending);
    app.ui.diceButton.setAttribute("aria-label", app.ui.diceButton.disabled ? "Dobókocka, most nem te dobsz" : "Dobás a dobókockával");
    if (!app.ui.diceButton.classList.contains("is-rolling") && !app.diceResultVisible) app.ui.diceFace.textContent = "⚄";
    app.ui.rollInfo.textContent = state.phase === "moving" ? "A bábu lépeget…" : localCanRoll ? "Kattints a kockára a dobáshoz" : "";
    app.ui.positionSummary.textContent = state.gameOver ? "🏆 A célba értek!" : `🚪 Start → ${Math.max(0, currentPos)}/100 → 🚽 WC`;
    // A mozgás alatt ne rajzoljuk újra a teljes táblát minden időzítő-ticknél;
    // így a lassabb, mezőről mezőre ugró bábuanimáció látható marad.
    if (state.phase !== "moving") renderBoard(state);
    renderAction(state);
    renderHand(state);
    renderChat(state);
    renderLogs(state);
    renderFinish(state);
    // A kamerák láthatóságát és sorrendjét a reorderRemoteCameras kezeli.
    app.ui.cameraEmpty.textContent = app.mode === "online" ? "A bekapcsolt webkamerák balról jobbra jelennek meg." : "A helyi játékosok egy készüléken játszanak.";
    syncMediaButtons();
  }

  function renderBoard(state) {
    const board = app.ui.tileGrid;
    board.replaceChildren();
    const positionByPlayer = new Map();
    state.players.forEach((player) => {
      const pos = Number(player.position) || 0;
      if (!positionByPlayer.has(pos)) positionByPlayer.set(pos, []);
      positionByPlayer.get(pos).push(player);
    });
    app.ui.startTokens.replaceChildren();
    (positionByPlayer.get(0) || []).forEach((player) => app.ui.startTokens.append(makeToken(player, state.players.indexOf(player))));
    const colors = Array.isArray(state.board) && state.board.length === 100 ? state.board : makeBoard();
    const houseCore = document.createElement("div");
    houseCore.className = "kg-house-core kg-board-center-brand";
    houseCore.style.gridRow = "4 / span 4";
    houseCore.style.gridColumn = "3 / span 12";
    houseCore.innerHTML = `
      <div class="kg-board-logo" aria-label="Kiiszik">
        <strong>KIISZIK</strong>
      </div>`;
    board.append(houseCore);
    colors.forEach((color, index) => {
      const number = index + 1;
      const tile = document.createElement("div");
      tile.className = `kg-tile tile-${["white", "yellow", "red"].includes(color) ? color : "white"}`;
      tile.dataset.tile = String(number);
      const coord = SPIRAL_PATH[index] || { row: 0, col: 0 };
      tile.style.gridRow = String(coord.row + 1);
      tile.style.gridColumn = String(coord.col + 1);
      tile.style.zIndex = String(5 + (100 - number));
      if (number === 1) tile.classList.add("kg-tile-start");
      if (number === 100) tile.classList.add("kg-tile-finish");
      const num = document.createElement("span");
      num.className = "kg-tile-number";
      num.textContent = String(number);
      const icon = document.createElement("span");
      icon.className = "kg-tile-icon";
      icon.textContent = number === 1 ? "🚪" : number === 100 ? "🚽" : color === "white" ? "❔" : color === "yellow" ? "🥃" : "💥";
      const tokens = document.createElement("div");
      tokens.className = "kg-tile-players";
      (positionByPlayer.get(number) || []).forEach((player) => tokens.append(makeToken(player, state.players.indexOf(player))));
      if (state.currentPlayerId && (state.players.find((p) => p.id === state.currentPlayerId)?.position === number)) tile.classList.add("is-active");
      tile.append(num, icon, tokens);
      board.append(tile);
    });
  }
  function safeAvatarUrl(value) {
    return typeof value === "string" && value.length <= 100000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) ? value : null;
  }
  function setPlayerAvatar(element, player, fallback = "🙂") {
    if (!element) return;
    element.replaceChildren();
    const avatarUrl = safeAvatarUrl(player?.avatarUrl);
    if (avatarUrl) {
      const image = document.createElement("img");
      image.className = "kg-avatar-photo";
      image.src = avatarUrl;
      image.alt = "";
      image.draggable = false;
      element.append(image);
    } else {
      element.textContent = fallback || initials(player?.name);
    }
    if (player?.shield || player?.curseImmune) {
      const badge = document.createElement("i");
      badge.className = "kg-token-badge";
      badge.textContent = player.shield ? "🛡" : "6✓";
      element.append(badge);
    }
  }
  function makeToken(player, index) {
    const token = document.createElement("span");
    token.className = `kg-token token-${(index % 8) + 1}`;
    const shownName = displayPlayerName(player);
    setPlayerAvatar(token, { ...player, name: shownName }, initials(shownName));
    token.title = `${shownName}${player.shield ? " · pajzs" : ""}${player.curseImmune ? " · átokvédett a következő körig" : ""}`;
    if (player.nicknameTurns > 0) token.classList.add("is-cursed-nickname");
    return token;
  }
  function renderAction(state) {
    const container = app.ui.actionContent;
    container.replaceChildren();
    const pending = state.pending;
    app.ui.nextButton.hidden = true;
    app.ui.nextButton.disabled = true;
    app.ui.actionType.className = "kg-action-type";
    if (!pending) {
      app.ui.actionType.textContent = state.gameOver ? "VÉGE" : state.phase === "moving" ? "MOZGÁS" : state.paused ? "SZÜNET" : "KÖVETKEZIK";
      const paragraph = document.createElement("p");
      paragraph.className = "kg-small-note";
      paragraph.textContent = state.gameOver ? "A győztes elérte a WC-t." : state.phase === "moving" ? "A kocka dobott, a bábu animációval halad a mezőre." : "Dobj a kockával, és nézd meg, milyen mezőre érkezel.";
      container.append(paragraph);
      return;
    }
    app.ui.actionType.classList.add(`type-${pending.type}`);
    const labels = { white: "FEHÉR · SZIVATÁS", yellow: app.mode === "local" ? "SÁRGA · VÉLETLEN FELADAT" : "SÁRGA · SZAVAZÁS", red: "PIROS · MINDENKI", skipped: "ÁTOK · KÖR KIMARAD", nickname: "ÁTOK · BECENÉV" };
    app.ui.actionType.textContent = labels[pending.type] || "FELADAT";
    const prompt = document.createElement("div");
    prompt.className = "kg-action-prompt";
    if (pending.type === "white" && !pending.resolved) prompt.textContent = app.mode === "local" && state.players.length === 1
      ? "Válassz egyet a két kérdés közül. Ezt magadnak teszed fel; ha passzolsz, egy korty, alkoholmentes ital vagy passz is választható."
      : "Válassz két kérdés közül egyet, utána jelöld ki, ki vállalja a választ vagy a büntetést.";
    else if (pending.type === "yellow" && !pending.resolved) prompt.textContent = app.mode === "local" ? "A játék véletlenszerűen választ egy feladatot a kérdésbankból." : "A társaság szavaz a két feladat közül. A legtöbb szavazat nyer, döntetlennél a játék véletlenül választ.";
    else if (pending.type === "nickname" && !pending.resolved) prompt.textContent = `${currentPlayer(state)?.name || "A játékos"} átok alatt áll. A többiek válasszanak: Kutyakapitány vagy Verébvezér. A választott nevet 3 saját körön át használjuk.`;
    else if (pending.type === "red") prompt.textContent = `${state.players.length === 1 ? "🔴 PIROS MEZŐ · EGYJÁTÉKOS" : "🔴 PIROS MEZŐ · MINDENKI"}. ${pending.text || "Közös feladat következik."} Víz, üdítő vagy passz is választható.`;
    else if (pending.type === "skipped") prompt.textContent = pending.text || "Ezt a kört ki kell hagynod.";
    else if (pending.type === "yellow" && pending.resolved) prompt.textContent = app.mode === "local"
      ? `A játék véletlenszerűen ezt választotta: „${pending.text}”. ${currentPlayer(state)?.name || "A játékos"} válaszolhat, vagy választhat 1 kortyot, alkoholmentes italt vagy passzt.`
      : `A szavazás eredménye: „${pending.text}”. ${currentPlayer(state)?.name || "A játékos"} válaszolhat, vagy választhat 1 kortyot, alkoholmentes italt vagy passzt.`;
    else if (pending.type === "white" && pending.resolved) {
      const target = state.players.find((player) => player.id === pending.targetId);
      prompt.textContent = `Kiválasztott kérdés: „${pending.text}” — célpont: ${displayPlayerName(target)}. Válasz vagy 1 korty, alkoholmentes ital vagy passz.`;
    } else prompt.textContent = pending.text || "A mező feladata aktív.";
    container.append(prompt);
    if (pending.type === "white" && !pending.resolved) {
      const canChoose = canControlTurn(state);
      const sub = document.createElement("div");
      sub.className = "kg-action-subtitle";
      sub.textContent = "1. Válassz kérdést";
      container.append(sub);
      const options = document.createElement("div");
      options.className = "kg-options";
      pending.options.forEach((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `kg-option-button${app.currentWhiteOptionId === option.id ? " is-selected" : ""}`;
        button.textContent = option.text;
        button.disabled = !canChoose;
        button.addEventListener("click", () => {
          app.currentWhiteOptionId = option.id;
          if (app.mode === "local" && state.players.length === 1) {
            chooseWhite(state.currentPlayerId);
            return;
          }
          render();
        });
        options.append(button);
      });
      container.append(options);
      if (app.currentWhiteOptionId && pending.options.some((option) => option.id === app.currentWhiteOptionId)) {
        const soloLocal = app.mode === "local" && state.players.length === 1;
        const targetTitle = document.createElement("div");
        targetTitle.className = "kg-action-subtitle";
        targetTitle.textContent = soloLocal ? "2. Ezt a kérdést magadnak teszed fel" : "2. Kit szivasson meg a kérdés?";
        container.append(targetTitle);
        const targets = document.createElement("div");
        targets.className = "kg-target-list";
        if (soloLocal) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "kg-target-button";
          button.textContent = "Kérdés kiválasztása magamnak";
          button.disabled = !canChoose;
          button.addEventListener("click", () => chooseWhite(state.currentPlayerId));
          targets.append(button);
        } else {
          state.players.filter((player) => player.id !== state.currentPlayerId).forEach((player) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "kg-target-button";
            button.textContent = displayPlayerName(player);
            button.disabled = !canChoose;
            button.addEventListener("click", () => chooseWhite(player.id));
            targets.append(button);
          });
        }
        container.append(targets);
      }
    } else if ((pending.type === "yellow" || pending.type === "nickname") && !pending.resolved) {
      const counts = pending.votes || {};
      const myVote = pending.myVote || null;
      if (app.mode === "local") {
        const label = document.createElement("div"); label.className = "kg-small-note"; label.textContent = "Egykészülékes módban nincs szavazás: a játék véletlenszerűen választott."; container.append(label);
      } else if (state.currentPlayerId === app.socket?.id) {
        const label = document.createElement("div"); label.className = "kg-small-note"; label.textContent = `A többiek szavaznak (${pending.submittedVotes || 0}/${pending.voterCount || 0}). Te most nem szavazol.`; container.append(label);
      } else {
        const sub = document.createElement("div"); sub.className = "kg-action-subtitle"; sub.textContent = `Szavazás (${pending.submittedVotes || 0}/${pending.voterCount || 0})`; container.append(sub);
        const options = document.createElement("div"); options.className = "kg-options";
        pending.options.forEach((option) => {
          const button = document.createElement("button"); button.type = "button";
          button.className = `kg-option-button${myVote === option.id ? " is-selected" : ""}`;
          button.textContent = `${option.text} · ${counts[option.id] || 0} szavazat`;
          button.disabled = Boolean(myVote) || state.paused;
          button.addEventListener("click", () => vote(option.id));
          options.append(button);
        });
        container.append(options);
      }
    } else if (pending.type === "yellow" && pending.resolved) {
      const detail = document.createElement("p"); detail.className = "kg-small-note";
      detail.textContent = app.mode === "local" ? "Nincs szavazás: a helyi mód automatikusan választ a közös kérdésbankból." : `Szavazatok: ${(pending.votes && Object.values(pending.votes).reduce((sum, count) => sum + Number(count || 0), 0)) || pending.submittedVotes || 0}.`;
      container.append(detail);
    } else if (pending.type === "white" && pending.resolved) {
      const detail = document.createElement("p"); detail.className = "kg-small-note"; detail.textContent = "A feladat lezárult. A célpont dönthet, hogy válaszol vagy passzol."; container.append(detail);
    }
    if (pending.type === "skipped") {
      const note = document.createElement("p"); note.className = "kg-small-note";
      note.textContent = "Az átok idejére a dobás kimarad.";
      container.append(note);
    }
    if (pending.resolved && canControlTurn(state) && state.phase === "action") {
      app.ui.nextButton.hidden = false;
      app.ui.nextButton.disabled = Boolean(state.paused);
      app.ui.nextButton.textContent = pending.type === "skipped" ? "Kör lezárása →" : "Következő játékos →";
    }
  }
  function renderHand(state) {
    const hand = app.ui.hand;
    hand.replaceChildren();
    const cards = myCardHand(state);
    app.ui.cardCount.textContent = String(cards.length);
    if (app.ui.drawerCardCount) app.ui.drawerCardCount.textContent = String(cards.length);
    if (!cards.length) {
      const empty = document.createElement("div"); empty.className = "kg-card-empty"; empty.textContent = "Nincs kártyád. Néha a mezőkön találsz egyet."; hand.append(empty); return;
    }
    cards.forEach((card) => {
      const box = document.createElement("article"); box.className = `kg-card kind-${card.kind || "boost"}`;
      const title = document.createElement("strong"); title.textContent = card.title;
      const description = document.createElement("p"); description.textContent = card.description;
      box.append(title, description);
      if (card.kind === "curse") {
        const targets = document.createElement("div"); targets.className = "kg-card-targets";
        state.players.filter((player) => player.id !== getViewingPlayerId(state)).forEach((player) => {
          const button = document.createElement("button"); button.type = "button"; button.textContent = `Átok: ${player.name}`;
          button.addEventListener("click", () => playCard(card.instanceId, player.id)); targets.append(button);
        });
        box.append(targets);
      } else {
        const button = document.createElement("button"); button.type = "button"; button.textContent = card.kind === "shield" ? "Pajzs aktiválása" : card.id === "cleanse" ? "Átok eltávolítása" : "Bónusz aktiválása";
        button.addEventListener("click", () => playCard(card.instanceId)); box.append(button);
      }
      hand.append(box);
    });
  }
  function getViewingPlayerId(state) { return app.mode === "local" ? localActive()?.id : app.socket?.id; }
  function renderChat(state) {
    const box = app.ui.chatMessages;
    box.replaceChildren();
    (state.chat || []).slice(-35).forEach((message) => {
      const line = document.createElement("div"); line.className = "kg-chat-message";
      const name = document.createElement("strong"); name.textContent = `${message.name || "Játékos"}: `;
      const text = document.createElement("span"); text.textContent = message.message;
      line.append(name, text); box.append(line);
    });
    box.scrollTop = box.scrollHeight;
  }
  function renderLogs(state) {
    const box = app.ui.gameLogs;
    box.replaceChildren();
    (state.logs || []).filter((entry) => !(entry.type === "red" && /Mindenki választhat:.*korty vagy alkoholmentes alternatíva/i.test(entry.message || ""))).slice(-16).forEach((entry) => {
      const line = document.createElement("div"); line.className = `kg-log-item${entry.type ? ` type-${entry.type}` : ""}`; line.textContent = entry.message; box.append(line);
    });
    box.scrollTop = box.scrollHeight;
  }
  function renderFinish(state) {
    app.ui.finishOverlay.hidden = !state.gameOver;
    if (!state.gameOver) return;
    const winner = state.players.find((player) => player.id === state.winnerId);
    app.ui.finishTitle.textContent = winner ? `${displayPlayerName(winner)} nyerte a partit!` : "Vége a partinak!";
    app.ui.finishCopy.textContent = winner ? `${displayPlayerName(winner)} beért a WC-hez a 100. mezőn. A társaság teljesítette a kihívást.` : "A parti véget ért.";
  }

  function toggleMedia(kind) {
    if (!app.media) return;
    const input = kind === "microphone" ? app.media.microphone : app.media.camera;
    if (!input) { setNotice("A média vezérlő nem elérhető ebben a módban."); return; }
    input.checked = !input.checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    syncMediaButtons();
  }
  function syncMediaButtons() {
    if (!app.media) return;
    const micOn = Boolean(app.media.microphone?.checked);
    const cameraOn = Boolean(app.media.camera?.checked);
    if (app.ui.micToggle) { app.ui.micToggle.textContent = `🎙 Mikrofon: ${micOn ? "BE" : "KI"}`; app.ui.micToggle.classList.toggle("is-on", micOn); }
    if (app.ui.cameraToggle) { app.ui.cameraToggle.textContent = `📷 Kamera: ${cameraOn ? "BE" : "KI"}`; app.ui.cameraToggle.classList.toggle("is-on", cameraOn); }
  }
  function rememberMediaOriginal(element) {
    if (!element || app.mediaOriginals.some((entry) => entry.element === element)) return;
    app.mediaOriginals.push({ element, parent: element.parentElement, next: element.nextSibling });
  }
  function attachMediaElements() {
    if (app.mode !== "online") return;
    const localPreview = app.media.localPreview;
    if (!localPreview) return;
    if (!app.localCameraCard) {
      rememberMediaOriginal(localPreview);
      const card = document.createElement("article");
      card.className = "kg-camera-card-local";
      card.dataset.playerId = app.socket?.id || "local";
      const name = document.createElement("strong");
      name.className = "kg-camera-local-name";
      name.textContent = "Te";
      app.localCameraName = name;
      card.append(localPreview, name);
      app.localCameraCard = card;
    }
    if (app.localCameraCard.parentElement !== app.ui.cameraRail) app.ui.cameraRail.append(app.localCameraCard);
    app.ui.cameraEmpty.hidden = Boolean(app.ui.cameraRail.querySelector("video:not([hidden])"));
  }
  function restoreMediaElements() {
    for (const original of app.mediaOriginals.splice(0).reverse()) {
      if (!original.parent) continue;
      try {
        if (original.element.classList?.contains("lobby-remote-media-card")) original.element.style.display = "";
        if (original.next && original.next.parentNode === original.parent) original.parent.insertBefore(original.element, original.next);
        else original.parent.append(original.element);
      } catch (_) { /* A lobby DOM újrarajzolása esetén a video később is újracsatolható. */ }
    }
    if (app.localCameraCard) app.localCameraCard.remove();
    app.localCameraCard = null;
    app.localCameraName = null;
    if (app.media.remoteMedia) app.media.remoteMedia.hidden = app.media.remoteMedia.children.length === 0;
  }

  function start(config = {}) {
    // A játékfelület azonnal jelenjen meg; az online mód kérdéseit a szerver küldi.
    // Így a kérdésbank fetch-elése nem akadályozhatja meg a parti megnyitását.
    makeStaticUi();
    if (app.running) stop(false);
    app.mode = config.mode === "online" ? "online" : "local";
    app.avatarUrl = safeAvatarUrl(config.avatarUrl);
    app.socket = config.socket || window.kiiszikSocket || null;
    app.local = null;
    app.state = null;
    app.pauseRequestLocal = null;
    app.currentWhiteOptionId = null;
    app.lastHandledTimeoutTurn = null;
    app.root.hidden = false;
    app.running = true;
    app.ui.gameStatus.textContent = app.mode === "online" ? "ONLINE · JÁTÉK INDUL…" : "EGY KÉSZÜLÉKEN · JÁTÉK INDUL…";
    attachMediaElements();
    if (app.mode === "online") {
      app.stateRequestAttempts = 0;
      app.ui.gameStatus.textContent = "ONLINE · JÁTÉKÁLLAPOT KÉRÉSE…";
      app.ui.diceButton.disabled = true;
      bindSocket(app.socket);
      requestOnlineState();
    } else {
      // A helyi parti nem várhat a kérdésbank-hálózati kérésére. Ha a JSON késik,
      // a tartalék bankkal azonnal elindul; amint a fájl betöltődik, a közös bank lép életbe.
      if (!questionBank) questionBank = fallbackQuestionBank;
      createLocalGame(config.players || ["Játékos 1"], config.penaltyAudioDataUrl || null);
      bankReady.then((data) => { if (data && app.running && app.mode === "local") questionBank = data; });
    }
    render();
    return Promise.resolve(true);
  }

  function requestOnlineState() {
    if (!app.running || app.mode !== "online" || app.state) return;
    app.stateRequestAttempts = (app.stateRequestAttempts || 0) + 1;
    if (app.socket && app.socket.connected) {
      app.socket.emit("game:request-state");
    }
    if (app.stateRequestTimer) clearTimeout(app.stateRequestTimer);
    if (app.stateRequestAttempts < 8) {
      app.stateRequestTimer = setTimeout(requestOnlineState, 900);
    } else {
      app.ui.gameStatus.textContent = "ONLINE · NINCS JÁTÉKÁLLAPOT";
      setStatus("Nem érkezett válasz a játékszervertől. Ellenőrizd a kapcsolatot, majd lépj vissza a lobbyba és indítsd újra a partit.");
      setNotice("Nem sikerült betölteni a játékállapotot. A dobás addig nem aktiválható, amíg a szerver nem válaszol.");
    }
  }
  function bindSocket(socket) {
    if (!socket) return;
    unbindSocket(socket);
    socket.on("game:state", onGameState);
    socket.on("game:state-error", onGameStateError);
    socket.on("game:move-start", onMoveStart);
    socket.on("game:collision", onCollision);
    socket.on("game:move-back", onMoveBack);
    socket.on("game:private-notice", onPrivateNotice);
    socket.on("game:curse-revealed", onCurseRevealed);
    socket.on("game:penalty-voice", onPenaltyVoiceNotice);
    socket.on("disconnect", onGameDisconnect);
  }
  function unbindSocket(socket) {
    if (!socket) return;
    socket.off("game:state", onGameState);
    socket.off("game:state-error", onGameStateError);
    socket.off("game:move-start", onMoveStart);
    socket.off("game:collision", onCollision);
    socket.off("game:move-back", onMoveBack);
    socket.off("game:private-notice", onPrivateNotice);
    socket.off("game:curse-revealed", onCurseRevealed);
    socket.off("game:penalty-voice", onPenaltyVoiceNotice);
    socket.off("disconnect", onGameDisconnect);
  }
  function onGameState(state) {
    if (!app.running || app.mode !== "online" || !state) return;
    app.state = state;
    if (app.stateRequestTimer) clearTimeout(app.stateRequestTimer);
    app.stateRequestTimer = null;
    app.stateRequestAttempts = 0;
    app.currentWhiteOptionId = null;
    render();
    setStatus(state.gameOver ? "A parti véget ért." : state.pending ? "" : state.phase === "turn" ? `${displayPlayerName(currentPlayer(state))} dobhat.` : state.phase === "moving" ? "A bábu mozgásban van." : "");
  }
  function onGameStateError(data) {
    if (!app.running || app.mode !== "online") return;
    app.ui.gameStatus.textContent = "ONLINE · SZERVER VÁLASZRA VÁR";
    if (data?.message) setStatus(data.message);
  }
  function onMoveStart(move) {
    if (!app.running || app.mode !== "online" || !move) return;
    startDiceAnimation(1050, move.roll);
    app.ui.gameStatus.textContent = `${move.playerName || "Játékos"} dobott: ${move.roll}`;
    animateMove(move).catch((error) => console.warn("A bábuanimáció megszakadt:", error));
  }
  function onCollision(data) {
    if (!app.running || !data) return;
    showSlapImpact();
    setNotice(`💥 ${data.attackerName} nekiment ${data.targetName} játékosnak! ${data.targetName} ${data.spacesBack} mezőt visszalép.`, true);
  }
  function showSlapImpact() {
    const effect = app.ui.slapImpact;
    if (!effect) return;
    effect.classList.remove("is-playing");
    // Újrafuttatja a rövid kézcsapás-animációt akkor is, ha gyorsan ismétlődik.
    void effect.offsetWidth;
    effect.classList.add("is-playing");
    setTimeout(() => effect.classList.remove("is-playing"), 1000);
  }
  function reorderRemoteCameras(state) {
    const remote = app.media.remoteMedia;
    const rail = app.ui.cameraRail;
    if (!remote || !rail || !Array.isArray(state.players)) return;
    const seatOrder = new Map(state.players.map((player, index) => [player.id, index]));
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const knownCards = [...new Set([
      ...remote.querySelectorAll(".lobby-remote-media-card"),
      ...rail.querySelectorAll(".lobby-remote-media-card")
    ])];
    const items = [];
    const localPreview = app.media.localPreview;
    const localPlayer = state.players.find((player) => player.id === app.socket?.id);
    if (localPreview && app.localCameraCard) {
      const isVisible = Boolean(localPlayer && localPlayer.camera && !localPreview.hidden);
      if (localPlayer && app.localCameraName) app.localCameraName.textContent = `${displayPlayerName(localPlayer)} (te)`;
      app.localCameraCard.style.display = isVisible ? "" : "none";
      app.localCameraCard.dataset.playerId = localPlayer?.id || app.socket?.id || "local";
      if (isVisible) items.push({ element: app.localCameraCard, player: localPlayer, order: Number(localPlayer.cameraOrder) || Number.MAX_SAFE_INTEGER, seat: seatOrder.get(localPlayer.id) ?? 999 });
    }
    knownCards.forEach((card) => {
      const player = byId.get(card.dataset.playerId);
      const visible = Boolean(player && player.camera);
      card.style.display = visible ? "" : "none";
      const label = card.querySelector(".lobby-remote-media-name");
      if (label && player) label.textContent = displayPlayerName(player);
      const audio = card.querySelector("audio");
      if (audio && player) audio.muted = !player.voice;
      if (!app.mediaOriginals.some((entry) => entry.element === card)) rememberMediaOriginal(card);
      if (visible) items.push({ element: card, player, order: Number(player.cameraOrder) || Number.MAX_SAFE_INTEGER, seat: seatOrder.get(player.id) ?? 999 });
    });
    items.sort((a, b) => (a.order - b.order) || (a.seat - b.seat));
    items.forEach((item) => rail.append(item.element));
    const visibleCamera = items.length > 0;
    app.ui.cameraEmpty.hidden = visibleCamera;
  }
  function onMoveBack(data) {
    if (data?.spaces) setNotice(`${data.playerId === app.socket?.id ? "Te" : "A játékos"} ${data.spaces} mezőt hátralépett: ${data.reason || "átok"}.`);
  }
  function onPrivateNotice(data) { if (data?.message) setNotice(data.message); }
  function onCurseRevealed(data) { if (data?.playerId === app.socket?.id && data.text) setNotice(`😈 ${data.text}`, true); }
  function onPenaltyVoiceNotice(data) { if (data && !data.isTest && data.playerId) setStatus(`🔊 ${data.playerName || "Játékos"} büntetőhangja lejátszódik.`); }
  function onGameDisconnect() { if (app.running && app.mode === "online") { setStatus("A kapcsolat megszakadt; a szerver újracsatlakozására várunk."); app.ui.diceButton.disabled = true; } }

  async function animateMove(move) {
    const boardSurface = app.ui.boardSurface;
    const overlayToken = app.ui.movingToken;
    if (!boardSurface || !overlayToken) return;
    const maxTo = Math.min(100, Number(move.to) || 0);
    const from = Math.max(0, Number(move.from) || 0);
    const steps = [];
    for (let n = Math.max(1, from + 1); n <= maxTo; n += 1) steps.push(n);
    if (!steps.length) return;
    const movingPlayer = (app.state?.players || []).find((player) => player.id === move.playerId || player.name === move.playerName);
    setPlayerAvatar(overlayToken, movingPlayer || { name: move.playerName }, initials(move.playerName));
    // Hagyjunk időt a középen dobott kocka látványos leesésének, mielőtt a bábu ugrani kezd.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    overlayToken.classList.add("is-visible");
    for (let index = 0; index < steps.length; index += 1) {
      const number = steps[index];
      const tile = app.ui.tileGrid.querySelector(`[data-tile="${number}"]`);
      if (!tile) continue;
      app.ui.tileGrid.querySelectorAll(".is-stepping").forEach((item) => item.classList.remove("is-stepping"));
      tile.classList.add("is-stepping");
      overlayToken.classList.remove("is-jumping");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      overlayToken.classList.add("is-jumping");
      const containerRect = boardSurface.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      overlayToken.style.left = `${tileRect.left - containerRect.left + tileRect.width / 2 - overlayToken.offsetWidth / 2}px`;
      overlayToken.style.top = `${tileRect.top - containerRect.top + tileRect.height / 2 - overlayToken.offsetHeight / 2}px`;
      await new Promise((resolve) => setTimeout(resolve, 485));
    }
    await new Promise((resolve) => setTimeout(resolve, 280));
    overlayToken.classList.remove("is-visible");
    app.ui.tileGrid.querySelectorAll(".is-stepping").forEach((item) => item.classList.remove("is-stepping"));
  }

  function startDiceAnimation(duration = 1050, finalRoll = null) {
    if (app.diceAnimationInterval) clearInterval(app.diceAnimationInterval);
    if (app.diceAnimationTimeout) clearTimeout(app.diceAnimationTimeout);
    if (app.diceHideTimeout) clearTimeout(app.diceHideTimeout);
    const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
    app.diceRollActive = true;
    app.diceResultVisible = false;
    app.ui.turnPanel.hidden = false;
    app.ui.diceButton.style.setProperty("--kg-dice-roll-duration", `${duration}ms`);
    app.ui.diceButton.classList.add("is-rolling");
    app.ui.diceButton.disabled = true;
    app.diceAnimationInterval = setInterval(() => {
      // Csak az értékek pörögnek; maga a kocka középen marad.
      app.ui.diceFace.textContent = faces[Math.floor(Math.random() * faces.length)];
    }, 65);
    app.diceAnimationTimeout = setTimeout(() => {
      if (app.diceAnimationInterval) clearInterval(app.diceAnimationInterval);
      app.diceAnimationInterval = null;
      app.diceAnimationTimeout = null;
      app.ui.diceButton.classList.remove("is-rolling");
      const finalValue = Number(finalRoll);
      app.ui.diceFace.textContent = Number.isInteger(finalValue) && finalValue >= 1 && finalValue <= 6
        ? faces[finalValue - 1]
        : faces[Math.floor(Math.random() * faces.length)];
      app.diceResultVisible = true;
      // A végső dobásérték röviden látszik, utána a panel eltűnik a következő körig.
      app.diceHideTimeout = setTimeout(() => {
        app.diceHideTimeout = null;
        app.diceResultVisible = false;
        app.diceRollActive = false;
        const localCanRoll = Boolean(app.state && canControlTurn() && app.state.phase === "turn" && !app.state.pending);
        app.ui.turnPanel.hidden = !localCanRoll;
        if (app.state) app.ui.diceButton.disabled = !localCanRoll;
        if (localCanRoll) app.ui.diceFace.textContent = "⚄";
      }, 260);
    }, duration);
  }
  function roll() {
    if (!app.state || !canControlTurn() || app.state.phase !== "turn" || app.state.pending) return;
    if (app.mode === "online") {
      app.socket.emit("game:roll");
      setStatus("Dobás…");
      return;
    }
    localRoll();
  }
  function localRoll() {
    const game = app.local;
    const player = localActive();
    const state = app.state;
    if (!game || !player || !state || state.phase !== "turn") return;
    const die = player.forceOne ? 1 : 1 + Math.floor(Math.random() * 6);
    player.forceOne = false;
    if (die === 6) player.curseImmune = true;
    const bonus = Math.min(2, Math.max(0, player.bonusRoll || 0));
    player.bonusRoll = 0;
    const spaces = Math.max(1, Math.min(8, die + bonus));
    const from = player.position;
    const to = Math.min(100, from + spaces);
    startDiceAnimation(1050, die);
    game.phase = "moving";
    game.turnEndsAt = null;
    game.lastRoll = { playerId: player.id, value: die, spacesMoved: spaces, from, to };
    state.phase = game.phase;
    state.turnEndsAt = game.turnEndsAt;
    state.lastRoll = game.lastRoll;
    state.players = game.players.map(publicLocalPlayer);
    render();
    animateMove({ playerId: player.id, playerName: player.name, from, to, roll: die })
      .then(() => finishLocalMove(player, from, to, die, spaces))
      .catch((error) => { console.warn("A bábuanimáció megszakadt:", error); finishLocalMove(player, from, to, die, spaces); });
    clearTimeout(game.moveHandle);
  }
  function publicLocalPlayer(player) {
    return { id: player.id, name: player.name, nickname: player.nickname || null, nicknameTurns: player.nicknameTurns || 0, barkTurns: player.barkTurns || 0, flamingoTurns: player.flamingoTurns || 0, avatarUrl: player.avatarUrl || null, position: player.position, shield: player.shield, curseImmune: player.curseImmune, forceOne: player.forceOne, bonusRoll: player.bonusRoll, skipTurns: player.skipTurns, finished: player.finished, hasPenaltyRecording: Boolean(player.penaltyRecording), isHost: player.index === 0 };
  }
  function finishLocalMove(player, from, destination, die, spaces) {
    const game = app.local;
    if (!game || app.mode !== "local") return;
    player.position = destination;
    game.phase = "action";
    const occupant = destination < 100 ? game.players.find((other) => other.id !== player.id && other.position === destination) : null;
    if (occupant) {
      const oldPos = occupant.position;
      const back = 2 + Math.floor(Math.random() * 3);
      occupant.position = localFreePosition(occupant.id, oldPos, back);
      addLocalLog(`BUMM! ${player.name} nekiment ${occupant.name} játékosnak. ${occupant.name} ${oldPos - occupant.position} mezőt hátracsúszik!`, "collision");
      showSlapImpact();
      setNotice(`💥 ${player.name} kiütötte ${occupant.name} játékost! ${oldPos - occupant.position} mező hátra.`, true);
      if (occupant.penaltyRecording) playLocalPenalty(occupant, oldPos - occupant.position);
    }
    addLocalLog(`${player.name} ${die}-t dobott, ${spaces} mezőt lépett (${from} → ${destination}).`, "move");
    if (destination >= 100) {
      player.finished = true;
      game.gameOver = true;
      game.winnerId = player.id;
      game.phase = "finished";
      game.pending = null;
      game.turnEndsAt = null;
      app.state = localPublicState();
      render();
      return;
    }
    localPendingForTile(player);
  }
  function localFreePosition(playerId, from, back) {
    const game = app.local;
    const occupied = new Set(game.players.filter((item) => item.id !== playerId).map((item) => item.position));
    let pos = Math.max(0, from - back);
    while (pos > 0 && occupied.has(pos)) pos -= 1;
    if (occupied.has(pos)) { for (let candidate = 0; candidate <= 100; candidate += 1) if (!occupied.has(candidate)) return candidate; }
    return pos;
  }
  function localPendingForTile(player) {
    const game = app.local;
    const color = game.board[Math.max(0, player.position - 1)] || "white";
    let pending;
    if (color === "white") {
      const options = sampleTwo(questionBank.white);
      pending = { id: `local-${Date.now()}`, type: "white", options, resolved: false, votes: {} };
      addLocalLog(game.players.length === 1
        ? `${player.name} egyedül fehér mezőre lépett: válasszon egy kérdést magának.`
        : `${player.name} fehér mezőre lépett: válasszon egy kérdést és jelöljön ki valakit.`, "white");
    } else if (color === "yellow") {
      const options = sampleTwo(questionBank.yellow);
      const winner = options[Math.floor(Math.random() * options.length)];
      pending = { id: `local-${Date.now()}`, type: "yellow", options, chosenOptionId: winner.id, text: winner.text, resolved: true, votes: {}, sipCount: 1 };
      addLocalLog(`${player.name} sárga mezőre lépett. Szavazás helyett a játék választott: „${winner.text}”.`, "yellow");
    } else {
      pending = { id: `local-${Date.now()}`, type: "red", text: questionBank.red[Math.floor(Math.random() * questionBank.red.length)], resolved: true, votes: {}, sipCount: 1 };
      addLocalLog(`Piros mező! Mindenki választhat: ${pending.sipCount} korty vagy alkoholmentes alternatíva.`, "red");
    }
    if (Math.random() < .27) {
      const pool = [...questionBank.curses, ...questionBank.shields, ...questionBank.boosts];
      const card = clone(pool[Math.floor(Math.random() * pool.length)]);
      player.cards.push({ ...card, instanceId: `card-${Date.now()}-${Math.random().toString(16).slice(2)}` });
      addLocalLog(`${player.name} talált egy kártyát.`, "card");
      setNotice(`🃏 ${player.name} talált egy kártyát: ${card.title}`);
    }
    game.pending = pending;
    game.phase = "action";
    game.turnEndsAt = Date.now() + 60_000;
    app.state = localPublicState();
    render();
  }

  function localPublicState() {
    const game = app.local;
    if (!game) return null;
    const active = game.players[game.turnIndex];
    let myVote = null;
    const pending = game.pending ? { ...game.pending, options: game.pending.options ? clone(game.pending.options) : [], votes: game.pending.votes || {}, myVote, submittedVotes: Object.keys(game.pending.votes || {}).length, voterCount: Math.max(0, game.players.length - 1) } : null;
    return {
      mode: "local", roomCode: "HELYI", board: game.board, phase: game.phase, turnNumber: game.turnNumber, turnIndex: game.turnIndex,
      currentPlayerId: active?.id || null, turnEndsAt: game.turnEndsAt, paused: game.paused, pauseRequest: null, pauseVotes: 0, resumeVotes: 0, pauseVoteCount: 0,
      lastRoll: game.lastRoll, pending, players: game.players.map(publicLocalPlayer), privateHand: active?.cards || [], logs: clone(game.logs), chat: clone(game.chat), winnerId: game.winnerId, gameOver: game.gameOver,
      myId: active?.id || null
    };
  }
  function localStartTurn() {
    const game = app.local;
    if (!game || game.gameOver) return;
    const player = localActive();
    if (!player) return;
    player.curseImmune = false;
    if (player.secretCurses.length) {
      const curse = player.secretCurses.shift();
      if (player.shield) {
        player.shield = false;
        addLocalLog(`${player.name} pajzsa felfogott egy titkos átkot!`, "shield");
        setNotice(`${player.name} pajzsa felfogott egy átkot!`);
      } else {
        addLocalLog(`${player.name} átok alá került: ${curse.title}.`, "curse");
        setNotice(`😈 ${player.name}: ${curse.title}. ${curse.description}`, true);
        if (curse.id === "freeze") player.skipTurns = Math.max(player.skipTurns, 2);
        else if (curse.id === "ones") player.forceOne = true;
        else if (curse.id === "back") { const old = player.position; player.position = localFreePosition(player.id, old, 3); addLocalLog(`${player.name} ${old - player.position} mezőt visszalépett az átok miatt.`, "curse"); }
        else if (curse.id === "nickname") { player.nickname = ["Kutyakapitány", "Verébvezér"][Math.floor(Math.random() * 2)]; player.nicknameTurns = 3; setNotice(`🏷️ A játék ezt a becenevet választotta neked: ${player.nickname}. 3 saját körig így szólítanak!`, true); }
        else if (curse.id === "bark") { player.barkTurns = Math.max(player.barkTurns || 0, 2); setNotice("🐶 Ugatási átok: a következő két körödben vakkants egyet, ha megszólítanak!", true); }
        else if (curse.id === "flamingo") { player.flamingoTurns = Math.max(player.flamingoTurns || 0, 1); setNotice("🦩 Flamingó-átok: a dobás előtt tarts 5 másodpercig vicces pózt. Ne igyál egyensúlyozás közben!", true); }
      }
    }
    game.pending = null;
    game.lastRoll = null;
    if (player.skipTurns > 0) {
      player.skipTurns -= 1;
      game.phase = "action";
      game.pending = { id: `skip-${Date.now()}`, type: "skipped", text: `${player.name}, ezt a kört átok miatt ki kell hagynod. Még ${player.skipTurns} kihagyott kör marad.`, resolved: true, options: [], votes: {} };
      addLocalLog(`${player.name} kihagy egy kört az átok miatt.`, "curse");
    } else game.phase = "turn";
    game.turnEndsAt = Date.now() + 60_000;
    app.state = localPublicState();
    render();
  }
  function tickLocalCurseTurns(player) {
    if (!player) return;
    if (player.nicknameTurns > 0) { player.nicknameTurns -= 1; if (player.nicknameTurns <= 0) { player.nicknameTurns = 0; player.nickname = null; addLocalLog(`${player.name} beceneve visszaállt.`, "curse"); } }
    if (player.barkTurns > 0) player.barkTurns -= 1;
    if (player.flamingoTurns > 0) player.flamingoTurns -= 1;
  }
  function completeTurn() {
    const state = app.state;
    if (!state || !canControlTurn(state) || state.paused || state.gameOver) return;
    if (app.mode === "online") {
      app.socket.emit("game:complete");
      return;
    }
    if (state.phase !== "action" || !state.pending || !state.pending.resolved) return;
    tickLocalCurseTurns(localActive());
    app.local.turnIndex = (app.local.turnIndex + 1) % app.local.players.length;
    app.local.turnNumber += 1;
    app.local.pending = null;
    app.local.lastRoll = null;
    addLocalLog(`Következik: ${localActive().name}.`, "turn");
    localStartTurn();
  }
  function chooseWhite(targetId) {
    // Helyi módban a valódi játékállapotot módosítjuk; az app.state csak megjelenítéshez készített másolat.
    const pending = app.mode === "local" ? app.local?.pending : app.state?.pending;
    if (!pending || pending.type !== "white" || pending.resolved || !app.currentWhiteOptionId) return;
    if (app.mode === "online") {
      app.socket.emit("game:white-choose", { optionId: app.currentWhiteOptionId, targetId });
      app.currentWhiteOptionId = null;
      return;
    }
    const game = app.local;
    const active = localActive();
    const option = pending.options.find((item) => item.id === app.currentWhiteOptionId);
    const target = game.players.find((player) => player.id === targetId && (game.players.length === 1 ? player.id === active.id : player.id !== active.id));
    if (!option || !target) return;
    pending.chosenOptionId = option.id;
    pending.text = option.text;
    pending.targetId = target.id;
    pending.resolved = true;
    pending.sipCount = 1;
    addLocalLog(`${active.name} ezt választotta: „${option.text}”. Célpont: ${target.name}. Válasz vagy ${pending.sipCount} korty / alkoholmentes alternatíva.`, "white");
    app.currentWhiteOptionId = null;
    app.state = localPublicState();
    render();
  }
  function vote(optionId) {
    if (!app.state || !["yellow", "nickname"].includes(app.state.pending?.type)) return;
    if (app.mode === "online") app.socket.emit("game:vote", { optionId });
  }
  function playCard(instanceId, targetId = null) {
    const card = myCardHand().find((item) => item.instanceId === instanceId);
    if (!card) return;
    if (app.mode === "online") {
      app.socket.emit("game:card-play", { cardId: instanceId, targetId });
      return;
    }
    const owner = localActive();
    const cardIndex = owner.cards.findIndex((item) => item.instanceId === instanceId);
    if (cardIndex < 0) return;
    if (card.kind === "curse") {
      const target = app.local.players.find((item) => item.id === targetId && item.id !== owner.id);
      if (!target) { setNotice("Válassz másik játékost az átokhoz."); return; }
      if (target.shield || target.curseImmune) { setNotice(`${target.name} most átokvédett; a kártyát megtartottad.`); return; }
      owner.cards.splice(cardIndex, 1);
      target.secretCurses.push({ id: card.id, title: card.title, description: card.description, fromName: owner.name });
      setNotice(`Titokban átkot tettél ${target.name} játékosra.`, true);
    } else if (card.kind === "shield") {
      owner.cards.splice(cardIndex, 1);
      owner.shield = true;
      addLocalLog(`${owner.name} nyilvános pajzsot aktivált.`, "shield");
    } else if (card.id === "cleanse") {
      if (!owner.secretCurses.length) { setNotice("Nincs eltávolítható átok; a kártyát megtartottad."); return; }
      owner.cards.splice(cardIndex, 1); owner.secretCurses.shift(); addLocalLog(`${owner.name} eltávolított egy rá váró átkot.`, "boost");
    } else {
      owner.cards.splice(cardIndex, 1);
      owner.bonusRoll = Math.min(2, owner.bonusRoll + (card.id === "lucky" ? 2 : 1));
      addLocalLog(`${owner.name} bónuszt tett félre a következő dobására.`, "boost");
    }
    app.state = localPublicState(); render();
  }
  function togglePause() {
    if (!app.state || app.state.gameOver) return;
    const action = app.state.paused ? "resume" : "pause";
    if (app.mode === "online") {
      if (app.state.pauseRequest) {
        setStatus("Már folyamatban van egy szünetről szóló szavazás.");
        return;
      }
      app.socket.emit("game:pause-request", { action });
      setStatus(action === "pause" ? "Szünetkérést küldtél a társaságnak." : "Folytatási kérést küldtél a társaságnak.");
      return;
    }
    if (app.pauseRequestLocal) return;
    app.pauseRequestLocal = {
      id: `local-pause-${Date.now()}`,
      requesterName: localActive()?.name || "Játékos",
      action,
      yesVotes: 0,
      noVotes: 0,
      myVote: null,
      playerCount: app.local?.players.length || 1
    };
    renderPauseRequest(app.state);
  }

  function renderPauseRequest(state = app.state) {
    if (!app.ui.pauseVoteModal) return;
    const request = app.mode === "online" ? state?.pauseRequest : app.pauseRequestLocal;
    app.ui.pauseVoteModal.hidden = !request;
    if (!request) return;
    const action = request.action === "resume" ? "resume" : "pause";
    const requester = request.requesterName || "Egy játékos";
    app.ui.pauseVoteTitle.textContent = action === "resume" ? "Folytatás szavazás" : "Szünet szavazás";
    app.ui.pauseVoteText.textContent = action === "resume"
      ? `${requester} szeretné folytatni a partit. Megszavazzátok?`
      : `${requester} szünetet szeretne kérni. Igen vagy nem?`;
    app.ui.pauseVoteCounts.textContent = `Igen: ${Number(request.yesVotes) || 0} · Nem: ${Number(request.noVotes) || 0} · Szavazott: ${Number(request.voteCount) || 0}/${Number(request.playerCount) || (state?.players?.length || 1)}`;
    const alreadyVoted = request.myVote !== null && request.myVote !== undefined;
    app.ui.pauseVoteYes.disabled = alreadyVoted;
    app.ui.pauseVoteNo.disabled = alreadyVoted;
    app.ui.pauseVoteYes.textContent = action === "resume" ? "Igen, folytassuk" : "Igen, szünet";
    app.ui.pauseVoteNo.textContent = action === "resume" ? "Nem, maradjon szünet" : "Nem, folytassuk";
  }

  function answerPauseVote(yes) {
    const request = app.mode === "online" ? app.state?.pauseRequest : app.pauseRequestLocal;
    if (!request) return;
    if (app.mode === "online") {
      app.socket.emit("game:pause-vote", { requestId: request.id, yes: Boolean(yes) });
      setStatus(yes ? "Igen szavazat elküldve." : "Nem szavazat elküldve.");
      return;
    }
    const game = app.local;
    if (yes && game) {
      if (request.action === "pause" && !game.paused) {
        game.paused = true;
        game.pausedAt = Date.now();
        if (game.tickHandle) clearInterval(game.tickHandle);
        addLocalLog(`${request.requesterName} szünetet kért; a helyi játék szünetel.`, "pause");
      } else if (request.action === "resume" && game.paused) {
        const pausedFor = Math.max(0, Date.now() - (game.pausedAt || Date.now()));
        game.paused = false;
        game.pausedAt = null;
        if (game.turnEndsAt) game.turnEndsAt += pausedFor;
        startLocalTicker();
        addLocalLog("A helyi parti folytatódik.", "pause");
      }
    } else if (!yes) {
      addLocalLog(`${request.requesterName} szünetkérését elutasítottad.`, "pause");
    }
    app.pauseRequestLocal = null;
    app.state = localPublicState();
    render();
  }

  function sendChat(event) {
    event.preventDefault();
    const message = app.ui.chatInput.value.trim().replace(/\s+/g, " ").slice(0, 180);
    if (!message) return;
    app.ui.chatInput.value = "";
    if (app.mode === "online") { app.socket.emit("game:chat", { message }); return; }
    const player = localActive();
    app.local.chat.push({ id: `chat-${Date.now()}`, playerId: player.id, name: player.name, message, at: Date.now() });
    app.state = localPublicState(); renderChat(app.state);
  }
  function playLocalPenalty(player, spacesBack) {
    if (!player.penaltyRecording) return;
    try {
      const audio = new Audio(player.penaltyRecording);
      audio.volume = .95;
      audio.play().catch(() => setNotice(`${player.name} büntetőhangja lejátszásra vár; kattints az oldalon.`));
    } catch (_) { /* A játék ettől még folytatódik. */ }
  }
  function startLocalTicker() {
    if (app.local?.tickHandle) clearInterval(app.local.tickHandle);
    app.local.tickHandle = setInterval(() => {
      if (!app.running || app.mode !== "local" || !app.local || app.local.paused || app.local.gameOver) return;
      app.state = localPublicState();
      render();
      if (app.state.turnEndsAt && Date.now() >= app.state.turnEndsAt && app.lastHandledTimeoutTurn !== app.state.turnNumber) {
        app.lastHandledTimeoutTurn = app.state.turnNumber;
        handleLocalTimeout();
      }
    }, 250);
  }
  function handleLocalTimeout() {
    const game = app.local;
    if (!game || game.gameOver) return;
    const pending = game.pending;
    if (pending && !pending.resolved && pending.type === "white") {
      const active = localActive();
      const option = pending.options[Math.floor(Math.random() * pending.options.length)];
      const target = game.players.find((player) => player.id !== active.id) || active;
      pending.resolved = true; pending.chosenOptionId = option.id; pending.text = option.text; pending.targetId = target.id; pending.sipCount = 1;
      addLocalLog(`Az idő lejárt: ${target.name} kapta ezt a kérdést: „${option.text}”.`, "white");
    }
    addLocalLog(`${localActive().name} ideje lejárt, következik a következő játékos.`, "timer");
    tickLocalCurseTurns(localActive());
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    game.turnNumber += 1;
    localStartTurn();
  }

  function stop(dispatch = true) {
    if (!app.root) return;
    const oldMode = app.mode;
    if (app.socket) unbindSocket(app.socket);
    if (app.tickHandle) clearInterval(app.tickHandle);
    if (app.stateRequestTimer) clearTimeout(app.stateRequestTimer);
    app.stateRequestTimer = null;
    if (app.diceAnimationInterval) clearInterval(app.diceAnimationInterval);
    if (app.diceAnimationTimeout) clearTimeout(app.diceAnimationTimeout);
    if (app.diceHideTimeout) clearTimeout(app.diceHideTimeout);
    app.diceAnimationInterval = null; app.diceAnimationTimeout = null; app.diceHideTimeout = null; app.diceRollActive = false; app.diceResultVisible = false;
    if (app.local?.tickHandle) clearInterval(app.local.tickHandle);
    if (app.local?.moveHandle) clearTimeout(app.local.moveHandle);
    app.local = null;
    app.pauseRequestLocal = null;
    if (app.ui.pauseVoteModal) app.ui.pauseVoteModal.hidden = true;
    restoreMediaElements();
    app.root.hidden = true;
    app.running = false;
    app.mode = null;
    app.state = null;
    app.currentWhiteOptionId = null;
    app.avatarUrl = null;
    if (dispatch) window.dispatchEvent(new CustomEvent("kiiszik:game-exit", { detail: { mode: oldMode } }));
  }
  function createLocalGame(names, penaltyAudioDataUrl) {
    const players = (Array.isArray(names) ? names : []).slice(0, 8).map((value, index) => ({
      id: `local-player-${index + 1}`, name: String(typeof value === "string" ? value : value.name || `Játékos ${index + 1}`).trim().slice(0, 20) || `Játékos ${index + 1}`,
      position: 0, cards: [], shield: false, curseImmune: false, forceOne: false, bonusRoll: 0, skipTurns: 0, curseBack: 0,
      secretCurses: [], finished: false, index, avatarUrl: index === 0 ? safeAvatarUrl(app.avatarUrl) : null,
      penaltyRecording: index === 0 ? penaltyAudioDataUrl : null, nickname: null, nicknameTurns: 0, barkTurns: 0, flamingoTurns: 0
    }));
    if (players.length === 0) players.push({ id: "local-player-1", name: "Játékos", position: 0, cards: [], shield: false, curseImmune: false, forceOne: false, bonusRoll: 0, skipTurns: 0, curseBack: 0, secretCurses: [], finished: false, index: 0, avatarUrl: safeAvatarUrl(app.avatarUrl), penaltyRecording: penaltyAudioDataUrl || null, nickname: null, nicknameTurns: 0, barkTurns: 0, flamingoTurns: 0 });
    app.local = { board: makeBoard(), players, turnIndex: 0, turnNumber: 1, phase: "turn", turnEndsAt: Date.now() + 60_000, paused: false, pausedAt: null, lastRoll: null, pending: null, logs: [], chat: [], gameOver: false, winnerId: null, moveHandle: null, tickHandle: null };
    addLocalLog(`Elindult a Kiiszik parti ${players.length} játékossal. Start: BEJÁRAT, cél: WC.`, "start");
    localStartTurn();
    startLocalTicker();
  }

  window.KiiszikGame = {
    setMediaControls(elements = {}) { app.media = { ...app.media, ...elements }; syncMediaButtons(); },
    start,
    stop,
    getState() { return app.state; }
  };
})();
