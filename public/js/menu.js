"use strict";

// ================================================
// LIDÉRCJÁRÁS – ZENE, HÁTTÉR ÉS JÁTÉKOSNÉV
// ================================================

const gearButton = document.getElementById("gearButton");
const startGameButton = document.getElementById("startGameButton");

const tracks = [
    { name: "Lidércek suttogása", src: "/music/zene1.mp3" },
    { name: "Az elátkozott erdő", src: "/music/zene2.mp3" }
];

const themes = {
    purple: "Lila lidércfény",
    blood: "Vérholdvörös",
    blue: "Kísérteties kék",
    green: "Lidérczöld"
};

const effects = {
    fog: "Mozgó köd",
    lights: "Lebegő fények",
    spirits: "Lidércfények"
};

const music = new Audio();
music.loop = true;
music.preload = "none";

let selectedTrack = getSavedNumber("ljSelectedTrack", 0, 0, tracks.length - 1);
let selectedTheme = getSavedChoice("ljTheme", themes, "purple");
let selectedEffect = getSavedChoice("ljEffect", effects, "fog");
let settingsWindow = null;
let lastStatus = "A háttérzene indításra vár.";
let lastStatusIsError = false;

music.volume = getSavedNumber("ljMusicVolume", 0.35, 0, 1);
music.src = tracks[selectedTrack].src;
applyAppearance();

function getSavedNumber(key, fallback, min, max) {
    const saved = localStorage.getItem(key);
    if (saved === null) return fallback;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function getSavedChoice(key, choices, fallback) {
    const saved = localStorage.getItem(key);
    return Object.prototype.hasOwnProperty.call(choices, saved) ? saved : fallback;
}

function saveSetting(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (error) {
        console.warn("A beállítást nem sikerült elmenteni:", error);
    }
}

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function setStatus(message, isError = false) {
    lastStatus = message;
    lastStatusIsError = isError;
    const status = document.getElementById("ljMusicStatus");
    if (status) {
        status.textContent = message;
        status.classList.toggle("error", isError);
    }
}

function applyAppearance() {
    document.body.classList.remove(
        "lj-theme-purple", "lj-theme-blood", "lj-theme-blue", "lj-theme-green",
        "lj-effect-fog", "lj-effect-lights", "lj-effect-spirits"
    );
    document.body.classList.add(`lj-theme-${selectedTheme}`);
    document.body.classList.add(`lj-effect-${selectedEffect}`);
    saveSetting("ljTheme", selectedTheme);
    saveSetting("ljEffect", selectedEffect);
}

async function playMusic() {
    try {
        await music.play();
        setStatus(`Most szól: ${tracks[selectedTrack].name}`);
    } catch (error) {
        setStatus("A böngésző nem indította el automatikusan a zenét. Kattints a Játék indítása gombra vagy válassz zenét a beállításokban.", true);
    }
}

function changeTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return;
    selectedTrack = index;
    music.src = tracks[selectedTrack].src;
    music.load();
    saveSetting("ljSelectedTrack", selectedTrack);
    playMusic();
}

function updateVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return;
    music.volume = Math.min(1, Math.max(0, volume));
    saveSetting("ljMusicVolume", music.volume);

    const volumeValue = document.getElementById("ljVolumeValue");
    const volumeIcon = document.getElementById("ljVolumeIcon");
    if (volumeValue) volumeValue.textContent = `${Math.round(music.volume * 100)}%`;
    if (volumeIcon) volumeIcon.textContent = music.volume === 0 ? "🔇" : music.volume < 0.5 ? "🔉" : "🔊";
}

function openSettings() {
    if (settingsWindow) {
        settingsWindow.remove();
        settingsWindow = null;
        return;
    }

    const overlay = createElement("div", "lj-overlay");
    overlay.id = "ljSettingsOverlay";
    const modal = createElement("section", "lj-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "ljSettingsTitle");

    const header = createElement("div", "lj-modal-header");
    const title = createElement("h2", "", "Beállítások");
    title.id = "ljSettingsTitle";
    const closeButton = createElement("button", "lj-close-icon", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Bezárás");
    header.append(title, closeButton);

    const description = createElement("p", "lj-modal-description", "Állítsd be a háttérzenét és a lidérces hangulatot.");

    const trackField = createElement("div", "lj-field");
    const trackLabel = createElement("label", "lj-field-label", "Háttérzene");
    trackLabel.htmlFor = "ljTrackSelect";
    const trackSelect = createElement("select", "lj-select");
    trackSelect.id = "ljTrackSelect";
    tracks.forEach((track, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = track.name;
        trackSelect.appendChild(option);
    });
    trackSelect.value = String(selectedTrack);
    trackField.append(trackLabel, trackSelect);

    const volumeField = createElement("div", "lj-field");
    const volumeLabel = createElement("label", "lj-field-label", "Hangerő");
    volumeLabel.htmlFor = "ljVolumeSlider";
    const volumeRow = createElement("div", "lj-volume-row");
    const volumeIcon = createElement("span", "lj-volume-icon", music.volume === 0 ? "🔇" : music.volume < 0.5 ? "🔉" : "🔊");
    volumeIcon.id = "ljVolumeIcon";
    const volumeSlider = createElement("input", "lj-volume-slider");
    volumeSlider.type = "range";
    volumeSlider.id = "ljVolumeSlider";
    volumeSlider.min = "0";
    volumeSlider.max = "1";
    volumeSlider.step = "0.01";
    volumeSlider.value = String(music.volume);
    const volumeValue = createElement("span", "lj-volume-value", `${Math.round(music.volume * 100)}%`);
    volumeValue.id = "ljVolumeValue";
    volumeRow.append(volumeIcon, volumeSlider, volumeValue);
    volumeField.append(volumeLabel, volumeRow);

    const themeField = createElement("div", "lj-field");
    const themeLabel = createElement("label", "lj-field-label", "Háttérszín");
    themeLabel.htmlFor = "ljThemeSelect";
    const themeSelect = createElement("select", "lj-select");
    themeSelect.id = "ljThemeSelect";
    Object.entries(themes).forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        themeSelect.appendChild(option);
    });
    themeSelect.value = selectedTheme;
    themeField.append(themeLabel, themeSelect);

    const effectField = createElement("div", "lj-field");
    const effectLabel = createElement("label", "lj-field-label", "Háttéranimáció");
    effectLabel.htmlFor = "ljEffectSelect";
    const effectSelect = createElement("select", "lj-select");
    effectSelect.id = "ljEffectSelect";
    Object.entries(effects).forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        effectSelect.appendChild(option);
    });
    effectSelect.value = selectedEffect;
    effectField.append(effectLabel, effectSelect);

    const status = createElement("div", "lj-status", lastStatus);
    status.id = "ljMusicStatus";
    status.classList.toggle("error", lastStatusIsError);
    const guide = createElement("section", "lj-rules-guide");
    const guideHeading = createElement("h3", "lj-guide-heading", "Játékszabályok és szerepek");
    const guideIntro = createElement("p", "lj-guide-intro", "A cél az, hogy kiderítsd, kik a lidércek. A falu nappal megbeszél és szavaz; éjszaka a szerepek titkos képességei működnek.");
    const roleDetails = createElement("details", "lj-guide-details");
    const roleSummary = createElement("summary", "", "Mit tudnak a szerepek?");
    const roleList = createElement("div", "lj-guide-list");
    [
        ["Lidérc", "Éjszaka közösen választanak célpontot. Több lidércnek ugyanarra kell szavaznia. Egyedül maradva támadhat vagy megvizsgálhatja egy élő játékos szerepét. A lidércek egymással privát hangon és szöveges chaten beszélhetnek."],
        ["Gyógyító", "Ha több gyógyító él, mindegyik külön szavaz, nincs chat vagy ping; védelem csak akkor történik, ha mind ugyanazt a játékost választja. Ha egyedüli gyógyító marad, összesen két éjszakán védhet, éjszakánként legfeljebb egyszer."],
        ["Falusi", "Nincs éjszakai képessége. Nappal a beszélgetés és a szavazás segít felderíteni a lidérceket."],
        ["Vadász", "Éjszaka egyszer lőhet egy élő játékosra vagy passzolhat. Nem vizsgál szerepet. Több vadász a saját éjszakai körében privát hangon és szöveges chaten egyeztethet. Ha a lidércek ugyanazon az éjszakán megölik, nem támadhat vissza."],
        ["Bolond", "A célja, hogy a falu nappali szavazással kiszavazza. Ha így esik ki, ő nyeri a játékot."],
        ["Bohóc lidérc", "Nem külön beállítható kaszt: a lidércek közül legfeljebb egy válik Bohóc lidérccé. A külön 20 másodperces körében Hamis szavazatot használhat: kiválaszt egy élő játékost, akinek a következő nappali voksát a szerver titokban SKIP-ként számolja el. A szabotázs három körönként használható újra; az egyedüli lidérc egyszeri szerepvizsgálata külön képesség marad."],
        ["Fertőző", "Éjszakánként megfertőzhet egy még nem fertőzött, élő játékost. Csak ő látja a fertőzött személyeket; a nyilvános napló nem nevezi meg őket. Akkor nyer, ha minden más életben lévő játékos megfertőződött."],
        ["Látnok", "A halott játékosokkal külön szöveges csatornán beszélhet, és segítséget kérhet tőlük. Az élők többi tagja nem látja ezt a beszélgetést."],
        ["Földesúr", "A nappali szavazata két szavazati pontot ér. Egy célpontot vagy a SKIP lehetőséget választja, és a voks kétszer számít."],
        ["Házastársak", "A beállított játékosok párokba kerülnek. Éjszaka privát hangon és chaten beszélhetnek egymással. Ha egyikük meghal, a párja is kiesik."],
        ["Kalandor", "Három, a szobában tényleg beállított szerepet kell megtalálnia. Éjszakánként egy játékosra tippelhet. A célpont halála nem törli a feladatot; mindhárom helyes találat után nyer."],
        ["Lélekrabló", "Új halál után, hajnalban kiválaszthat egy halott játékost, és átveheti a szerepét, képességeit és győzelmi oldalát. Halott Lélekrabló szerepét nem veheti át."],
        ["Árnyékkötő", "A lidércek szövetségese. Minden második éjszakán kiválaszthat egy élő, nem lidérc játékost, akinek arra az éjszakára letiltja a különleges képességét. A lidércekkel titkos csatornán kommunikálhat."]
    ].forEach(([name, descriptionText]) => {
        const entry = createElement("article", "lj-guide-entry");
        entry.append(createElement("strong", "", name), createElement("p", "", descriptionText));
        roleList.appendChild(entry);
    });
    roleDetails.append(roleSummary, roleList);
    const flowDetails = createElement("details", "lj-guide-details");
    const flowSummary = createElement("summary", "", "Hogyan zajlik egy játék?");
    const flowList = createElement("ol", "lj-guide-steps");
    [
        "Mindenki READY állapotba kerül, majd a házigazda elindítja a játékot.",
        "A 10 másodperces sötétedés alatt mindenki titkos szerepet kap, utána jön a beállított ismerkedési idő.",
        "Éjszaka az Árnycserélő egyszer vakon szerepet cserélhet; a lidércek támadnak, a gyógyítók védenek, a vadászok lőhetnek, a Fertőző fertőzhet, a Kalandor szerepeket keres. Minden Lidérc külön 50% eséllyel lehet Bohóc lidérc. A nappali szavazatok titkosak: csak az látszik, ki szavazott már, a célpont nem.",
        "Reggel megjelennek az éjszakai események, majd a falu megbeszél és szavaz; SKIP is választható.",
        "A körök addig ismétlődnek, amíg a falu vagy a lidércek nem győznek, vagy a bolond nem nyer a kiszavazásával."
    ].forEach((text) => flowList.appendChild(createElement("li", "", text)));
    flowDetails.append(flowSummary, flowList);
    guide.append(guideHeading, guideIntro, roleDetails, flowDetails);

    const footer = createElement("p", "lj-footer", "A beállításaid ezen a böngészőn automatikusan elmentődnek.");

    modal.append(header, description, trackField, volumeField, themeField, effectField, guide, status, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    settingsWindow = overlay;

    function closeSettings() {
        if (settingsWindow) settingsWindow.remove();
        settingsWindow = null;
        document.removeEventListener("keydown", handleEscape);
    }
    function handleEscape(event) {
        if (event.key === "Escape") closeSettings();
    }

    closeButton.addEventListener("click", closeSettings);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeSettings();
    });
    document.addEventListener("keydown", handleEscape);
    trackSelect.addEventListener("change", () => changeTrack(Number(trackSelect.value)));
    volumeSlider.addEventListener("input", () => updateVolume(volumeSlider.value));
    themeSelect.addEventListener("change", () => {
        selectedTheme = themeSelect.value;
        applyAppearance();
    });
    effectSelect.addEventListener("change", () => {
        selectedEffect = effectSelect.value;
        applyAppearance();
    });
    closeButton.focus();
}

if (gearButton) {
    gearButton.addEventListener("click", () => {
        gearButton.classList.remove("is-spinning");
        void gearButton.offsetWidth;
        gearButton.classList.add("is-spinning");
        openSettings();
    });
    gearButton.addEventListener("animationend", () => gearButton.classList.remove("is-spinning"));
}

music.addEventListener("error", () => {
    setStatus("Nem sikerült betölteni a zenefájlt. Ellenőrizd, hogy a public/music mappában van-e a zene1.mp3 és a zene2.mp3.", true);
});

// ================================================
// JÁTÉKOSNÉV MEGADÁSA
// ================================================

function openNameDialog() {
    if (document.getElementById("ljNameOverlay")) return;

    const overlay = createElement("div", "lj-name-overlay");
    overlay.id = "ljNameOverlay";
    const dialog = createElement("section", "lj-name-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "ljNameTitle");

    const heading = createElement("h2", "", "Ki vagy te, vándor?");
    heading.id = "ljNameTitle";
    const description = createElement("p", "", "Adj meg egy játékosnevet, hogy elkezdhesd a Lidércjárást.");
    const form = createElement("form", "lj-name-form");
    form.id = "ljNameForm";

    const label = createElement("label", "", "Játékosneved");
    label.htmlFor = "ljPlayerNameInput";
    const input = createElement("input", "lj-name-input");
    input.id = "ljPlayerNameInput";
    input.name = "playerName";
    input.type = "text";
    input.maxLength = 16;
    input.minLength = 2;
    input.autocomplete = "nickname";
    input.placeholder = "Írd be a neved...";
    input.required = true;

    const errorMessage = createElement("p", "lj-name-error", "");
    errorMessage.id = "ljNameError";
    errorMessage.setAttribute("aria-live", "polite");

    const actions = createElement("div", "lj-name-actions");
    const cancelButton = createElement("button", "lj-name-cancel", "Vissza");
    cancelButton.type = "button";
    const submitButton = createElement("button", "lj-name-submit", "Tovább");
    submitButton.type = "submit";
    actions.append(cancelButton, submitButton);
    form.append(label, input, errorMessage, actions);
    dialog.append(heading, description, form);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    input.value = localStorage.getItem("ljPlayerName") || "";
    input.focus();

    function closeDialog() {
        overlay.remove();
        document.removeEventListener("keydown", handleEscape);
    }
    function handleEscape(event) {
        if (event.key === "Escape") closeDialog();
    }

    cancelButton.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeDialog();
    });
    document.addEventListener("keydown", handleEscape);

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const playerName = input.value.trim();

        if (playerName.length < 2) {
            errorMessage.textContent = "A névnek legalább 2 karakter hosszúnak kell lennie.";
            input.focus();
            return;
        }
        if (playerName.length > 16) {
            errorMessage.textContent = "A név legfeljebb 16 karakter lehet.";
            input.focus();
            return;
        }

        const socket = window.lidercSocket;
        if (!socket) {
            errorMessage.textContent = "Nem sikerült kapcsolódni a szerverhez. Frissítsd az oldalt.";
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = "NÉV ELLENŐRZÉSE...";
        errorMessage.textContent = "Kapcsolódás a szerverhez...";
        let finished = false;
        let connectionTimeoutId = null;

        const finish = () => {
            if (connectionTimeoutId !== null) {
                window.clearTimeout(connectionTimeoutId);
                connectionTimeoutId = null;
            }
            submitButton.disabled = false;
            submitButton.textContent = "Tovább";
        };

        const sendNameCheck = () => {
            if (finished) return;
            if (!socket.connected) return;

            errorMessage.textContent = "Név ellenőrzése...";
            socket.timeout(8000).emit("check-name", playerName, (error, result) => {
                if (finished) return;
                finished = true;
                finish();

                if (error) {
                    errorMessage.textContent = "A szerver nem válaszolt a névellenőrzésre. Indítsd újra az npm start paranccsal, majd ellenőrizd a http://localhost:3000/health oldalt.";
                    input.focus();
                    return;
                }

                if (!result || !result.ok) {
                    errorMessage.textContent = result?.message || "Nem sikerült ellenőrizni a nevet.";
                    input.focus();
                    return;
                }

                localStorage.setItem("ljPlayerName", playerName);
                window.location.href = "/lobby";
            });
        };

        if (socket.connected) {
            sendNameCheck();
        } else {
            const onConnect = () => {
                socket.off("connect", onConnect);
                if (connectionTimeoutId !== null) {
                    window.clearTimeout(connectionTimeoutId);
                    connectionTimeoutId = null;
                }
                sendNameCheck();
            };

            socket.once("connect", onConnect);
            connectionTimeoutId = window.setTimeout(() => {
                if (finished) return;
                finished = true;
                socket.off("connect", onConnect);
                finish();
                errorMessage.textContent = "Nem sikerült kapcsolódni a szerverhez. Nézd meg, hogy a parancssorban fut-e az npm start, majd nyisd meg a http://localhost:3000/health címet.";
                input.focus();
            }, 10000);
        }
    });
}

if (startGameButton) {
    startGameButton.addEventListener("click", () => {
        // A kattintás felhasználói művelet, ezért a böngésző a zenét is engedélyezheti.
        if (music.paused) playMusic();
        openNameDialog();
    });
}

// Megpróbálja elindítani a zenét; a böngésző ezt letilthatja kattintás előtt.
music.play().then(() => {
    setStatus(`Most szól: ${tracks[selectedTrack].name}`);
}).catch(() => {
    setStatus("A háttérzene indításra vár.");
});
