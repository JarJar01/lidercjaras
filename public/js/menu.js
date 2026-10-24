"use strict";

// ================================================
// LIDÉRCJÁRÁS – NYUGODT FANTASY ZENE ÉS BEÁLLÍTÁSOK
// ================================================

const gearButton = document.getElementById("gearButton");
const startGameButton = document.getElementById("startGameButton");
const music = new Audio("/music/lidercjaras-fantasy.mp3");
music.loop = true;
music.preload = "auto";
let settingsWindow = null;
let lastStatus = "A nyugodt fantasy zene indításra vár.";
let lastStatusIsError = false;
let musicStartedByGesture = false;
let phaseVoiceEnabled = localStorage.getItem("ljPhaseVoiceEnabled") !== "false";
let musicVolume = getSavedNumber("ljMusicVolume", 0.28, 0, 1);
let announcementPlaying = false;
const announcementAudio = new Audio();
announcementAudio.preload = "auto";
announcementAudio.volume = 0.98;
music.volume = musicVolume;

// Helyi, előre elkészített magyar bemondások. Így a játék nem a böngésző
// véletlenszerű alapértelmezett (gyakran gépies) beszédhangjára támaszkodik.
const phaseAudioFiles = {
    countdown: "jatek_kezdodik.mp3",
    intro: "ismerkedes_kezdodik.mp3",
    "night-shadowbinder": "arnyekkoto_kore.mp3",
    "dawn-soulreaper": "lelekrablo_kore.mp3",
    "night-swapper": "arnycserelo_kore.mp3",
    "night-special-spirit": "bohoc_liderc_kore.mp3",
    "night-spirits": "lidercek_kore.mp3",
    "night-healer": "gyogyito_kore.mp3",
    "night-hunters": "vadasz_kore.mp3",
    "night-fool": "bolond_kore.mp3",
    "night-infectious": "fertozo_kore.mp3",
    "night-adventurer": "kalandor_kore.mp3",
    "night-seer": "latnok_kore.mp3",
    "dawn-result": "reggel_eredmeny.mp3",
    day: "nappal_kezdodik.mp3",
    "vote-result": "szavazas_eredmenye.mp3",
    "game-over": "jatek_vege.mp3"
};

function applyMusicVolume() {
    // A háttérzene a bemondás idejére lehalkul, utána visszaáll a beállított értékre.
    music.volume = Math.min(1, Math.max(0, musicVolume * (announcementPlaying ? 0.18 : 1)));
}

announcementAudio.addEventListener("ended", () => {
    announcementPlaying = false;
    applyMusicVolume();
});
announcementAudio.addEventListener("error", () => {
    announcementPlaying = false;
    applyMusicVolume();
    setStatus("A bemondás MP3-fájlja nem tölthető be. Ellenőrizd a public/audio/announcements mappát.", true);
});

function getSavedNumber(key, fallback, min, max) {
    const saved = localStorage.getItem(key);
    if (saved === null) return fallback;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
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

async function playMusic() {
    try {
        await music.play();
        musicStartedByGesture = true;
        setStatus("Most szól: A holdfény ösvénye – nyugodt fantasy zene.");
        return true;
    } catch (error) {
        setStatus("A böngésző az első kattintásig nem engedi elindítani a zenét. Kattints a felületre, és elindul.", true);
        return false;
    }
}

function updateVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return;
    musicVolume = Math.min(1, Math.max(0, volume));
    applyMusicVolume();
    saveSetting("ljMusicVolume", musicVolume);
    const volumeValue = document.getElementById("ljVolumeValue");
    const volumeIcon = document.getElementById("ljVolumeIcon");
    if (volumeValue) volumeValue.textContent = `${Math.round(musicVolume * 100)}%`;
    if (volumeIcon) volumeIcon.textContent = musicVolume === 0 ? "🔇" : musicVolume < 0.45 ? "🔉" : "🔊";
}

function playPhaseAnnouncement(phase, text, test = false) {
    if (!text || (!test && !phaseVoiceEnabled)) return false;
    const filename = phaseAudioFiles[phase] || (test ? phaseAudioFiles["night-spirits"] : "kovetkezo_kor.mp3");
    try {
        announcementAudio.pause();
        announcementAudio.currentTime = 0;
        announcementAudio.src = `/audio/announcements/${filename}`;
        announcementPlaying = true;
        applyMusicVolume();
        announcementAudio.play().then(() => {
            if (test) setStatus("Hangpróba: a helyi, mélyebb fantasy bemondás szól.");
        }).catch(() => {
            announcementPlaying = false;
            applyMusicVolume();
            if (test) setStatus("A bemondás nem indult el. Kattints még egyszer a Hangpróba gombra, vagy ellenőrizd a böngésző hangengedélyét.", true);
        });
        return true;
    } catch (error) {
        announcementPlaying = false;
        applyMusicVolume();
        if (test) setStatus("Nem sikerült elindítani a bemondást.", true);
        return false;
    }
}

// A játékképernyő a fázis azonosítóját adja át, ezért mindig a hozzá tartozó
// valódi MP3-at játsszuk le, nem a böngésző alapértelmezett géphangját.
window.lidercPlayPhaseAnnouncement = (phase, text) => playPhaseAnnouncement(phase, text, false);
window.lidercSpeakAnnouncement = (text) => {
    const phaseByText = {
        "A Lidércjárás hamarosan elkezdődik.": "countdown",
        "Kezdődik az ismerkedési idő.": "intro",
        "Az Árnyékkötő köre következik.": "night-shadowbinder",
        "A Lélekrabló választhat a halottak közül.": "dawn-soulreaper",
        "Az Árnycserélő köre következik.": "night-swapper",
        "A Bohóc lidérc különleges köre következik.": "night-special-spirit",
        "A lidércek köre következik.": "night-spirits",
        "A gyógyító köre következik.": "night-healer",
        "A vadászok köre következik.": "night-hunters",
        "A Bolond köre következik.": "night-fool",
        "A Fertőző köre következik.": "night-infectious",
        "A Kalandor köre következik.": "night-adventurer",
        "A Látnok köre következik.": "night-seer",
        "Hajnalodik. Az éjszaka eredménye következik.": "dawn-result",
        "Reggel van. A falu felébredhet.": "day",
        "A szavazás eredménye következik.": "vote-result",
        "A Lidércjárás véget ért.": "game-over"
    };
    return playPhaseAnnouncement(phaseByText[text] || "countdown", text, false);
};

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
    const description = createElement("p", "lj-modal-description", "Nyugodt fantasy háttérzene és a körök hangos bemondása.");

    const musicCard = createElement("section", "lj-music-card");
    musicCard.append(
        createElement("div", "lj-music-art", "♫"),
        createElement("div", "lj-music-copy")
    );
    const musicCopy = musicCard.querySelector(".lj-music-copy");
    musicCopy.append(
        createElement("strong", "", "A holdfény ösvénye"),
        createElement("span", "", "Nyugodt, varázslatos fantasy háttérzene")
    );
    const musicActionRow = createElement("div", "lj-music-actions");
    const musicToggle = createElement("button", "lj-inline-action", music.paused ? "Zene indítása" : "Zene szüneteltetése");
    musicToggle.type = "button";
    musicActionRow.appendChild(musicToggle);
    musicCard.appendChild(musicActionRow);

    const volumeField = createElement("div", "lj-field");
    const volumeLabel = createElement("label", "lj-field-label", "Háttérzene hangereje");
    volumeLabel.htmlFor = "ljVolumeSlider";
    const volumeRow = createElement("div", "lj-volume-row");
    const volumeIcon = createElement("span", "lj-volume-icon", musicVolume === 0 ? "🔇" : musicVolume < 0.45 ? "🔉" : "🔊");
    volumeIcon.id = "ljVolumeIcon";
    const volumeSlider = createElement("input", "lj-volume-slider");
    volumeSlider.type = "range";
    volumeSlider.id = "ljVolumeSlider";
    volumeSlider.min = "0";
    volumeSlider.max = "1";
    volumeSlider.step = "0.01";
    volumeSlider.value = String(musicVolume);
    const volumeValue = createElement("span", "lj-volume-value", `${Math.round(musicVolume * 100)}%`);
    volumeValue.id = "ljVolumeValue";
    volumeRow.append(volumeIcon, volumeSlider, volumeValue);
    volumeField.append(volumeLabel, volumeRow);

    const voiceCard = createElement("section", "lj-voice-announcement-card");
    const voiceCopy = createElement("div", "lj-voice-announcement-copy");
    voiceCopy.append(
        createElement("strong", "", "Körök hangos bemondása"),
        createElement("span", "", "Előre elkészített, mélyebb fantasy bemondások MP3-ból.")
    );
    const voiceToggleLabel = createElement("label", "lj-switch-label");
    voiceToggleLabel.htmlFor = "ljPhaseVoiceToggle";
    const voiceToggle = createElement("input", "lj-switch-input");
    voiceToggle.type = "checkbox";
    voiceToggle.id = "ljPhaseVoiceToggle";
    voiceToggle.checked = phaseVoiceEnabled;
    const switchVisual = createElement("span", "lj-switch-visual");
    voiceToggleLabel.append(voiceToggle, switchVisual);
    voiceCard.append(voiceCopy, voiceToggleLabel);
    const voiceActionRow = createElement("div", "lj-music-actions");
    const voiceTestButton = createElement("button", "lj-inline-action", "Hangpróba");
    voiceTestButton.type = "button";
    voiceActionRow.appendChild(voiceTestButton);
    voiceCard.appendChild(voiceActionRow);

    const status = createElement("div", "lj-status", lastStatus);
    status.id = "ljMusicStatus";
    status.classList.toggle("error", lastStatusIsError);
    const guide = createElement("section", "lj-rules-guide");
    const guideHeading = createElement("h3", "lj-guide-heading", "Játékszabályok és szerepek");
    const guideIntro = createElement("p", "lj-guide-intro", "A falu nappal megbeszél és szavaz; éjszaka a titkos szerepképességek működnek.");
    const roleDetails = createElement("details", "lj-guide-details");
    const roleSummary = createElement("summary", "", "Mit tudnak a szerepek?");
    const roleList = createElement("div", "lj-guide-list");
    [
        ["Lidérc", "Éjszaka közösen választanak célpontot. Több lidércnek ugyanarra kell szavaznia. Egyedül maradva támadhat vagy egyetlen alkalommal megvizsgálhat egy élő játékost. A lidércek egymással privát hangon és szöveges chaten beszélhetnek."],
        ["Gyógyító", "Ha több gyógyító él, mindegyik külön szavaz, nincs chat vagy ping; védelem csak akkor történik, ha mind ugyanazt a játékost választja. Ha egyedüli gyógyító marad, összesen két éjszakán védhet, éjszakánként legfeljebb egyszer."],
        ["Falusi", "Nincs éjszakai képessége. Nappal a beszélgetés és a szavazás segít felderíteni a lidérceket."],
        ["Vadász", "Éjszaka egyszer lőhet egy élő játékosra vagy passzolhat. Nem vizsgál szerepet. Több vadász a saját éjszakai körében privát hangon és szöveges chaten egyeztethet."],
        ["Bolond", "A célja, hogy a falu nappali szavazással kiszavazza. Ha így esik ki, ő nyeri a játékot."],
        ["Bohóc lidérc", "A lidércek közül legfeljebb egy válik Bohóc lidérccé. A külön körben szabotázst használhat, például Hamis szavazatot, némítást vagy hangelvékonyítást. A képesség használata után a beállított pihenőidőt ki kell várnia."],
        ["Fertőző", "Éjszakánként megfertőzhet egy élő játékost. Csak ő látja, ki fertőzött; a nyilvános napló nem nevezi meg őket."],
        ["Látnok", "Külön szeánszon beszélhet a halott játékosokkal. Az élők többi tagja nem látja ezt a kommunikációt."],
        ["Földesúr", "A nappali szavazata két szavazati pontot ér."],
        ["Házastársak", "Párokban kerülnek a játékba. Éjszaka privát hangon és chaten beszélhetnek; egyikük halálakor a párja is kiesik."],
        ["Kalandor", "Három, ténylegesen beállított szerepet kell megtalálnia. A célpont halála nem törli a feladatot; mindhárom helyes találat szükséges a győzelemhez."],
        ["Lélekrabló", "Hajnalban átveheti egy halott játékos szerepét, képességeit és győzelmi oldalát."],
        ["Árnyékkötő", "A lidércek szövetségese. Minden második éjszakán letilthatja egy nem lidérc játékos különleges képességét."],
        ["Árnycserélő", "Éjszaka egyszer vakon szerepet cserél egy másik élő játékossal; a kiválasztott Falusi lesz."]
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
        "A szereposztást követően jön a beállított ismerkedési idő.",
        "Éjszaka a szerepek képességei aktiválódnak, a nyilvános chat zárva lehet.",
        "Reggel megjelennek az éjszakai események, majd a falu megbeszél és titkosan szavaz; SKIP is választható.",
        "A körök addig ismétlődnek, amíg valamelyik csapat vagy egy különleges szerep nem nyer."
    ].forEach((text) => flowList.appendChild(createElement("li", "", text)));
    flowDetails.append(flowSummary, flowList);
    guide.append(guideHeading, guideIntro, roleDetails, flowDetails);
    const footer = createElement("p", "lj-footer", "A hangerő és a hangbemondás beállítása ezen a böngészőn mentődik el.");

    modal.append(header, description, musicCard, volumeField, voiceCard, guide, status, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    settingsWindow = overlay;

    function closeSettings() {
        if (settingsWindow) settingsWindow.remove();
        settingsWindow = null;
        document.removeEventListener("keydown", handleEscape);
    }
    function handleEscape(event) { if (event.key === "Escape") closeSettings(); }
    closeButton.addEventListener("click", closeSettings);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeSettings(); });
    document.addEventListener("keydown", handleEscape);
    volumeSlider.addEventListener("input", () => updateVolume(volumeSlider.value));
    musicToggle.addEventListener("click", async () => {
        if (music.paused) {
            await playMusic();
            musicToggle.textContent = music.paused ? "Zene indítása" : "Zene szüneteltetése";
        } else {
            music.pause();
            musicToggle.textContent = "Zene indítása";
            setStatus("A háttérzene szünetel.");
        }
    });
    voiceToggle.addEventListener("change", () => {
        phaseVoiceEnabled = voiceToggle.checked;
        saveSetting("ljPhaseVoiceEnabled", phaseVoiceEnabled);
        if (!phaseVoiceEnabled) {
            announcementAudio.pause();
            announcementPlaying = false;
            applyMusicVolume();
        }
        setStatus(phaseVoiceEnabled ? "A körök hangos bemondása bekapcsolva." : "A körök hangos bemondása kikapcsolva.");
    });
    voiceTestButton.addEventListener("click", () => playPhaseAnnouncement("night-spirits", "A lidércek köre következik.", true));
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

// A böngészők autoplay-védelme miatt az első felhasználói kattintás indítja a zenét.
function ensureMusicOnInteraction() {
    if (!musicStartedByGesture && music.paused) playMusic();
}
document.addEventListener("pointerdown", ensureMusicOnInteraction, { passive: true });
document.addEventListener("keydown", ensureMusicOnInteraction);
music.addEventListener("play", () => { musicStartedByGesture = true; });
music.addEventListener("error", () => setStatus("A fantasy zene nem töltődött be. Ellenőrizd a public/music/lidercjaras-fantasy.mp3 fájlt.", true));

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
        // A gombnyomás felhasználói művelet, ezért a böngésző engedélyezheti a zenét.
        if (music.paused) playMusic();
        openNameDialog();
    });
}

// Autoplay-próba: ha a böngésző tiltja, a következő kattintás indítja a zenét.
playMusic();
