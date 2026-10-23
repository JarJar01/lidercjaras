(() => {
    "use strict";

    console.info("[Kiiszik] menu.js elindult.");
    const $ = (id) => document.getElementById(id);
    const scene = document.querySelector(".k-scene");

    const ids = [
        "k-play-button", "k-settings-button", "k-modal", "k-modal-box",
        "k-age-yes", "k-age-no", "k-name-form", "k-player-name",
        "k-motion", "k-dizzy", "k-music-toggle", "k-music-track",
        "k-music-volume", "k-volume-label", "k-background-music", "k-settings-done",
        "k-toast", "k-player-badge", "k-player-badge-name", "k-player-avatar-img",
        "k-player-avatar-fallback", "k-avatar-preview-image", "k-avatar-placeholder",
        "k-avatar-status", "k-avatar-file", "k-camera-open", "k-camera-panel",
        "k-camera-video", "k-camera-capture", "k-camera-cancel", "k-avatar-upload",
        "k-avatar-use", "k-avatar-skip", "k-audio-meter", "k-audio-meter-bars",
        "k-audio-record-start", "k-audio-record-stop", "k-audio-player", "k-audio-playback",
        "k-audio-delete", "k-audio-status", "k-audio-skip", "k-audio-continue"
    ];
    const missing = ids.filter((id) => !$(id));
    if (!scene || missing.length) {
        console.error("[Kiiszik] Hiányzó HTML-elem:", missing.join(", "));
        window.alert("A Kiiszik menü nem tudott elindulni. Hiányzó HTML-elem: " +
            (missing.join(", ") || "k-scene") + ". Használd a ZIP teljes index.html fájlját.");
        return;
    }

    const playButton = $("k-play-button");
    const settingsButton = $("k-settings-button");
    const modal = $("k-modal");
    const modalBox = $("k-modal-box");
    const ageYes = $("k-age-yes");
    const ageNo = $("k-age-no");
    const nameForm = $("k-name-form");
    const nameInput = $("k-player-name");
    const motionToggle = $("k-motion");
    const dizzyToggle = $("k-dizzy");
    const musicToggle = $("k-music-toggle");
    const musicTrack = $("k-music-track");
    const musicVolume = $("k-music-volume");
    const volumeLabel = $("k-volume-label");
    const audio = $("k-background-music");
    const toast = $("k-toast");

    const playerBadge = $("k-player-badge");
    const playerBadgeName = $("k-player-badge-name");
    const playerAvatarImg = $("k-player-avatar-img");
    const playerAvatarFallback = $("k-player-avatar-fallback");
    const avatarPreview = $("k-avatar-preview-image");
    const avatarPlaceholder = $("k-avatar-placeholder");
    const avatarStatus = $("k-avatar-status");
    const avatarFile = $("k-avatar-file");
    const cameraOpen = $("k-camera-open");
    const cameraPanel = $("k-camera-panel");
    const cameraVideo = $("k-camera-video");
    const cameraCapture = $("k-camera-capture");
    const cameraCancel = $("k-camera-cancel");
    const avatarUpload = $("k-avatar-upload");
    const avatarUse = $("k-avatar-use");
    const avatarSkip = $("k-avatar-skip");
    const audioMeter = $("k-audio-meter");
    const audioMeterBars = $("k-audio-meter-bars");
    const audioRecordStart = $("k-audio-record-start");
    const audioRecordStop = $("k-audio-record-stop");
    const audioPlayer = $("k-audio-player");
    const audioPlayback = $("k-audio-playback");
    const audioDelete = $("k-audio-delete");
    const audioStatus = $("k-audio-status");
    const audioSkip = $("k-audio-skip");
    const audioContinue = $("k-audio-continue");

    const musicFiles = { zene1: "/music/zene1.mp3", zene2: "/music/zene2.mp3" };
    let ageConfirmed = false;
    let playerName = "";
    let profileFinished = false;
    let previousFocus = null;
    let toastTimer = null;
    let cameraStream = null;
    let selectedAvatarUrl = null;
    let selectedAvatarDataUrl = null;
    let avatarSelected = false;
    let currentProfileStep = "age";
    let penaltyAudioBlob = null;
    let penaltyAudioDataUrl = null;
    let penaltyAudioUrl = null;
    let penaltyAudioPersisted = false;
    let audioRecorder = null;
    let audioRecordingStream = null;
    let audioRecordingChunks = [];
    let audioRecordingTimeout = null;
    let audioContext = null;
    let audioAnalyser = null;
    let audioMeterSource = null;
    let audioMeterFrame = 0;
    let finishingProfile = false;
    let audioLoadGeneration = 0;

    // A hangfelvételhez külön, tartós IndexedDB-tárhelyet használunk; Blob nem fér el megbízhatóan a localStorage-ban.
    const AUDIO_DB_NAME = "kiiszik-profile-media";
    const AUDIO_STORE_NAME = "profile-media";
    const AUDIO_STORE_KEY = "penalty-audio";

    audio.volume = Number(musicVolume.value) / 100;
    volumeLabel.textContent = `${musicVolume.value}%`;

    function showToast(message) {
        toast.textContent = message;
        toast.classList.add("k-toast--visible");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove("k-toast--visible"), 4000);
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach((track) => track.stop());
            cameraStream = null;
        }
        cameraVideo.srcObject = null;
        cameraPanel.hidden = true;
    }

    function revokeAvatarUrl() {
        if (selectedAvatarUrl) URL.revokeObjectURL(selectedAvatarUrl);
        selectedAvatarUrl = null;
    }

    function openView(viewName) {
        if (["age", "name", "avatar", "penalty-audio"].includes(viewName)) currentProfileStep = viewName;
        if (modal.hidden) previousFocus = document.activeElement;
        let activeView = null;
        modal.querySelectorAll("[data-view]").forEach((view) => {
            const active = view.dataset.view === viewName;
            view.hidden = !active;
            if (active) activeView = view;
        });
        if (!activeView) {
            console.error("[Kiiszik] Ismeretlen ablaknézet:", viewName);
            showToast("Nem sikerült megnyitni ezt az ablakot.");
            return;
        }
        const heading = activeView.querySelector("h2");
        if (heading) modalBox.setAttribute("aria-labelledby", heading.id);
        modal.hidden = false;
        document.body.style.overflow = "hidden";
        settingsButton.setAttribute("aria-expanded", String(viewName === "settings"));
        const focusTargets = { age: ageYes, name: nameInput, avatar: avatarUpload, "penalty-audio": audioRecordStart, settings: musicToggle };
        if (focusTargets[viewName]) focusTargets[viewName].focus();
    }

    function closeModal() {
        if (modal.hidden) return;
        stopCamera();
        if (audioRecorder && audioRecorder.state !== "inactive") stopAudioRecording();
        modal.hidden = true;
        document.body.style.overflow = "";
        settingsButton.setAttribute("aria-expanded", "false");
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }

    modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !modal.hidden) closeModal();
    });

    // This click handler is deliberately registered immediately after validating the page elements.
    playButton.addEventListener("click", () => {
        console.info("[Kiiszik] JÁTÉK gomb megnyomva.");
        if (!ageConfirmed) return openView("age");
        if (!playerName) return openView("name");
        if (!profileFinished) {
            if (currentProfileStep === "penalty-audio") return showPenaltyAudioStep();
            return openView("avatar");
        }
        window.dispatchEvent(new CustomEvent("kiiszik:open-lobby", {
            detail: { playerName, avatarUrl: avatarSelected ? (selectedAvatarDataUrl || selectedAvatarUrl) : null, penaltyAudioDataUrl }
        }));
    });

    ageYes.addEventListener("click", () => {
        ageConfirmed = true;
        openView("name");
    });
    ageNo.addEventListener("click", () => {
        closeModal();
        showToast("A Kiiszik 18+ játék.");
    });

    nameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const cleaned = nameInput.value.replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ");
        const length = [...cleaned].length;
        if (length < 2 || length > 16) {
            showToast("A becenév 2–16 karakter hosszú legyen.");
            nameInput.focus();
            return;
        }
        playerName = cleaned;
        openView("avatar");
    });

    function setAvatarFromBlob(blob) {
        if (!blob || !blob.type.startsWith("image/")) {
            avatarStatus.textContent = "Ez a fájl nem tűnik képnek.";
            return;
        }
        if (blob.size > 8 * 1024 * 1024) {
            avatarStatus.textContent = "A kép legfeljebb 8 MB lehet.";
            showToast("Válassz egy 8 MB-nál kisebb képet.");
            return;
        }
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            revokeAvatarUrl();
            selectedAvatarUrl = url;
            avatarSelected = true;
            avatarPreview.src = url;
            avatarPreview.hidden = false;
            avatarPlaceholder.hidden = true;
            avatarUse.disabled = false;
            avatarStatus.textContent = "A kép sikeresen kiválasztva.";
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            avatarStatus.textContent = "A kép nem nyitható meg. Próbálj másikat.";
        };
        image.src = url;
    }

    avatarUpload.addEventListener("click", () => avatarFile.click());
    avatarFile.addEventListener("change", () => {
        const file = avatarFile.files && avatarFile.files[0];
        if (!file) return;
        stopCamera();
        setAvatarFromBlob(file);
        avatarFile.value = "";
    });

    async function openCamera() {
        stopCamera();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            avatarStatus.textContent = "A kamera ezen a címen nem érhető el. Próbáld a képkiválasztást.";
            showToast("A kamerához localhost vagy HTTPS szükséges.");
            return;
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
            cameraVideo.srcObject = cameraStream;
            cameraPanel.hidden = false;
            avatarStatus.textContent = "Nézz a kamerába, majd készíts képet.";
            await cameraVideo.play();
        } catch (error) {
            console.warn("[Kiiszik] Kamera hiba:", error);
            stopCamera();
            avatarStatus.textContent = error.name === "NotAllowedError"
                ? "A kameraengedélyt megtagadtad. Engedélyezd, vagy válassz képet."
                : "A kamera nem indítható el. Próbálj képet kiválasztani.";
        }
    }
    cameraOpen.addEventListener("click", openCamera);
    cameraCancel.addEventListener("click", () => {
        stopCamera();
        avatarStatus.textContent = avatarSelected ? "A kiválasztott képed megmaradt." : "A kamera bezárva.";
    });

    cameraCapture.addEventListener("click", () => {
        if (!cameraStream || !cameraVideo.videoWidth || !cameraVideo.videoHeight) {
            avatarStatus.textContent = "A kamera még nem áll készen.";
            return;
        }
        const maxSide = 900;
        const scale = Math.min(1, maxSide / Math.max(cameraVideo.videoWidth, cameraVideo.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(cameraVideo.videoWidth * scale);
        canvas.height = Math.round(cameraVideo.videoHeight * scale);
        const context = canvas.getContext("2d");
        if (!context) {
            avatarStatus.textContent = "Nem sikerült elkészíteni a képet.";
            return;
        }
        context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
            if (!blob) {
                avatarStatus.textContent = "Nem sikerült elkészíteni a képet.";
                return;
            }
            setAvatarFromBlob(blob);
            stopCamera();
        }, "image/jpeg", 0.88);
    });

    function setAudioStatus(message, type = "") {
        audioStatus.textContent = message;
        audioStatus.classList.toggle("k-audio-status-error", type === "error");
        audioStatus.classList.toggle("k-audio-status-success", type === "success");
    }

    function openAudioDatabase() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error("A böngésző nem támogatja a tartós hangmentést."));
                return;
            }
            const request = indexedDB.open(AUDIO_DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(AUDIO_STORE_NAME)) db.createObjectStore(AUDIO_STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Nem sikerült megnyitni a hangok tárhelyét."));
        });
    }

    async function storePenaltyAudio(blob) {
        const db = await openAudioDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(AUDIO_STORE_NAME, "readwrite");
            transaction.objectStore(AUDIO_STORE_NAME).put(blob, AUDIO_STORE_KEY);
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => { const error = transaction.error; db.close(); reject(error || new Error("A hang mentése nem sikerült.")); };
            transaction.onabort = () => { const error = transaction.error; db.close(); reject(error || new Error("A hang mentése megszakadt.")); };
        });
    }

    async function readPenaltyAudio() {
        const db = await openAudioDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(AUDIO_STORE_NAME, "readonly");
            const request = transaction.objectStore(AUDIO_STORE_NAME).get(AUDIO_STORE_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("A mentett hang betöltése nem sikerült."));
            transaction.oncomplete = () => db.close();
            transaction.onerror = () => { const error = transaction.error; db.close(); reject(error || new Error("A mentett hang betöltése nem sikerült.")); };
        });
    }

    async function deleteStoredPenaltyAudio() {
        const db = await openAudioDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(AUDIO_STORE_NAME, "readwrite");
            transaction.objectStore(AUDIO_STORE_NAME).delete(AUDIO_STORE_KEY);
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => { const error = transaction.error; db.close(); reject(error || new Error("A hang törlése nem sikerült.")); };
        });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("Nem sikerült előkészíteni a hangfelvételt."));
            reader.readAsDataURL(blob);
        });
    }

    function setAudioPlayerBlob(blob) {
        if (penaltyAudioUrl) URL.revokeObjectURL(penaltyAudioUrl);
        penaltyAudioUrl = URL.createObjectURL(blob);
        audioPlayer.pause();
        audioPlayer.src = penaltyAudioUrl;
        audioPlayer.hidden = false;
        audioPlayer.load();
        audioPlayback.disabled = false;
        audioDelete.disabled = false;
        audioContinue.disabled = !penaltyAudioPersisted;
    }

    function resetAudioMeter() {
        audioMeterBars.replaceChildren();
        for (let index = 0; index < 28; index += 1) {
            const bar = document.createElement("span");
            bar.style.height = `${4 + (index % 4)}px`;
            audioMeterBars.append(bar);
        }
        audioMeter.setAttribute("aria-valuenow", "0");
    }

    function paintAudioMeter(level) {
        const bars = [...audioMeterBars.children];
        const normalized = Math.max(0, Math.min(1, level));
        const peak = Math.round(normalized * 100);
        audioMeter.setAttribute("aria-valuenow", String(peak));
        bars.forEach((bar, index) => {
            const curve = Math.sin(((index + 1) / (bars.length + 1)) * Math.PI);
            const ripple = 0.65 + (Math.sin(performance.now() / 105 + index * 0.9) + 1) * 0.17;
            const height = 4 + normalized * curve * ripple * 38;
            bar.style.height = `${height}px`;
            bar.classList.toggle("is-active", normalized > 0.035 && index < Math.max(2, Math.round(normalized * bars.length * 1.6)));
        });
    }

    function stopAudioMeter() {
        if (audioMeterFrame) cancelAnimationFrame(audioMeterFrame);
        audioMeterFrame = 0;
        audioAnalyser = null;
        audioMeterSource = null;
        if (audioContext) {
            const context = audioContext;
            audioContext = null;
            context.close().catch(() => {});
        }
        paintAudioMeter(0);
    }

    function startAudioMeter(stream) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            audioContext = new AudioContextClass();
            audioContext.resume().catch(() => {});
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 256;
            audioMeterSource = audioContext.createMediaStreamSource(stream);
            audioMeterSource.connect(audioAnalyser);
            const values = new Uint8Array(audioAnalyser.fftSize);
            const draw = () => {
                if (!audioAnalyser) return;
                audioAnalyser.getByteTimeDomainData(values);
                let sum = 0;
                for (const value of values) {
                    const centered = (value - 128) / 128;
                    sum += centered * centered;
                }
                paintAudioMeter(Math.sqrt(sum / values.length) * 3.4);
                audioMeterFrame = requestAnimationFrame(draw);
            };
            draw();
        } catch (error) {
            console.warn("[Kiiszik] Hangszintmérő hiba:", error);
        }
    }

    function resetAudioButtons(isRecording = false) {
        audioRecordStart.disabled = isRecording;
        audioRecordStop.hidden = !isRecording;
        audioPlayback.disabled = isRecording || !penaltyAudioBlob;
        audioDelete.disabled = isRecording || !penaltyAudioBlob;
        audioSkip.disabled = isRecording || finishingProfile;
        audioContinue.disabled = isRecording || !penaltyAudioBlob || !penaltyAudioPersisted;
    }

    async function loadSavedPenaltyAudio() {
        const generation = ++audioLoadGeneration;
        setAudioStatus("Korábbi felvétel keresése…");
        audioRecordStart.disabled = true;
        audioContinue.disabled = true;
        try {
            const savedBlob = await readPenaltyAudio();
            if (generation !== audioLoadGeneration) return;
            if (savedBlob instanceof Blob && savedBlob.size > 0) {
                penaltyAudioBlob = savedBlob;
                penaltyAudioPersisted = true;
                penaltyAudioDataUrl = await blobToDataUrl(savedBlob);
                if (generation !== audioLoadGeneration) return;
                setAudioPlayerBlob(savedBlob);
                resetAudioButtons(false);
                setAudioStatus("A korábbi felvétel betöltve és elmentve. Kattints a Meghallgatás gombra, ellenőrizd, majd lépj tovább.", "success");
            } else {
                penaltyAudioBlob = null;
                penaltyAudioDataUrl = null;
                penaltyAudioPersisted = false;
                audioPlayer.pause();
                audioPlayer.removeAttribute("src");
                audioPlayer.load();
                audioPlayer.hidden = true;
                audioPlayback.disabled = true;
                audioDelete.disabled = true;
                audioContinue.disabled = true;
                audioRecordStart.disabled = false;
                audioSkip.disabled = false;
                setAudioStatus("Még nincs hangfelvétel. Készíts felvételt, majd hallgasd vissza.");
            }
        } catch (error) {
            if (generation !== audioLoadGeneration) return;
            console.warn("[Kiiszik] Hangbetöltési hiba:", error);
            penaltyAudioPersisted = false;
            audioRecordStart.disabled = false;
            audioSkip.disabled = false;
            setAudioStatus("Nem sikerült a korábbi felvételt betölteni. Készíthetsz újat, vagy kihagyhatod ezt a lépést.", "error");
            audioContinue.disabled = true;
        }
    }

    function showPenaltyAudioStep() {
        stopCamera();
        openView("penalty-audio");
        loadSavedPenaltyAudio();
    }

    function stopAudioRecording() {
        if (audioRecordingTimeout) {
            clearTimeout(audioRecordingTimeout);
            audioRecordingTimeout = null;
        }
        if (audioRecorder && audioRecorder.state !== "inactive") {
            audioRecorder.stop();
        }
    }

    async function startAudioRecording() {
        if (audioRecorder && audioRecorder.state !== "inactive") return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
            setAudioStatus("A hangfelvétel ezen a címen nem támogatott. Használd a localhost vagy HTTPS címet, vagy hagyd ki ezt a lépést.", "error");
            return;
        }
        try {
            audioRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
            audioRecordingChunks = [];
            const mimeChoices = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
            const preferredMime = mimeChoices.find((mime) => MediaRecorder.isTypeSupported(mime));
            audioRecorder = preferredMime
                ? new MediaRecorder(audioRecordingStream, { mimeType: preferredMime, audioBitsPerSecond: 32000 })
                : new MediaRecorder(audioRecordingStream, { audioBitsPerSecond: 32000 });
            const recorder = audioRecorder;
            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size) audioRecordingChunks.push(event.data);
            };
            recorder.onerror = () => setAudioStatus("Hiba történt a felvétel alatt. Próbáld meg újra.", "error");
            recorder.onstop = async () => {
                if (audioRecordingTimeout) {
                    clearTimeout(audioRecordingTimeout);
                    audioRecordingTimeout = null;
                }
                stopAudioMeter();
                if (audioRecordingStream) audioRecordingStream.getTracks().forEach((track) => track.stop());
                audioRecordingStream = null;
                audioRecorder = null;
                const blob = new Blob(audioRecordingChunks, { type: recorder.mimeType || "audio/webm" });
                audioRecordingChunks = [];
                resetAudioButtons(false);
                if (!blob.size) {
                    setAudioStatus("Üres lett a felvétel. Beszélj a mikrofonba, és próbáld újra.", "error");
                    return;
                }
                // 5 másodperces, alacsony bitrátájú hang; a szobaszerver 240 kB-os adatURL-korlátján belül kell maradnia.
                if (blob.size > 170000) {
                    setAudioStatus("A felvétel túl nagy lett. Készíts rövidebb hangot, vagy próbáld újra.", "error");
                    return;
                }
                penaltyAudioBlob = blob;
                penaltyAudioPersisted = false;
                try {
                    await storePenaltyAudio(blob);
                    penaltyAudioPersisted = true;
                } catch (error) {
                    console.warn("[Kiiszik] A hang tartós mentése sikertelen:", error);
                }
                try {
                    penaltyAudioDataUrl = await blobToDataUrl(blob);
                    setAudioPlayerBlob(blob);
                    resetAudioButtons(false);
                    if (penaltyAudioPersisted) {
                        audioContinue.disabled = false;
                        setAudioStatus("A felvétel elmentve! Hallgasd vissza a Meghallgatás gombbal, vagy az alsó lejátszóval.", "success");
                    } else {
                        audioContinue.disabled = true;
                        setAudioStatus("A felvétel elkészült és visszahallgatható, de a böngésző nem tudta tartósan elmenteni. Próbáld újra, vagy hagyd ki.", "error");
                    }
                } catch (error) {
                    setAudioStatus(error.message || "A felvétel feldolgozása nem sikerült.", "error");
                }
            };
            recorder.start(150);
            resetAudioButtons(true);
            audioContinue.disabled = true;
            setAudioStatus("Felvétel folyamatban… beszélj a mikrofonba. 5 másodperc után automatikusan leáll.");
            startAudioMeter(audioRecordingStream);
            audioRecordingTimeout = window.setTimeout(() => stopAudioRecording(), 5000);
        } catch (error) {
            if (audioRecordingStream) audioRecordingStream.getTracks().forEach((track) => track.stop());
            audioRecordingStream = null;
            stopAudioMeter();
            const denied = error && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
            setAudioStatus(denied
                ? "A mikrofonengedélyt nem kaptuk meg. Engedélyezd a mikrofont a böngészőben, majd próbáld újra."
                : "Nem sikerült elindítani a mikrofont. Ellenőrizd, hogy más program nem használja-e.", "error");
            resetAudioButtons(false);
        }
    }

    async function makeSmallAvatarDataUrl(sourceUrl) {
        if (!sourceUrl) return null;
        const image = new Image();
        image.decoding = "async";
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("A profilkép nem olvasható."));
            image.src = sourceUrl;
        });
        const size = 112;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("A profilkép nem tömöríthető.");
        const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.fillStyle = "#f6edd8";
        context.fillRect(0, 0, size, size);
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        return canvas.toDataURL("image/jpeg", 0.72);
    }

    async function finishProfile() {
        if (finishingProfile || (audioRecorder && audioRecorder.state !== "inactive")) return;
        finishingProfile = true;
        audioSkip.disabled = true;
        audioContinue.disabled = true;
        stopCamera();
        try {
            if (penaltyAudioBlob && !penaltyAudioDataUrl) penaltyAudioDataUrl = await blobToDataUrl(penaltyAudioBlob);
        } catch (error) {
            console.warn("[Kiiszik] A hang nem készíthető elő online használatra:", error);
            penaltyAudioDataUrl = null;
        }
        try {
            selectedAvatarDataUrl = avatarSelected && selectedAvatarUrl ? await makeSmallAvatarDataUrl(selectedAvatarUrl) : null;
        } catch (error) {
            console.warn("[Kiiszik] A profilkép nem tömöríthető az online bábuhoz:", error);
            selectedAvatarDataUrl = null;
        }
        playerBadgeName.textContent = playerName || "Játékos";
        playerBadge.hidden = false;
        if (avatarSelected && selectedAvatarUrl) {
            playerAvatarImg.src = selectedAvatarUrl;
            playerAvatarImg.hidden = false;
            playerAvatarFallback.hidden = true;
        } else {
            playerAvatarImg.hidden = true;
            playerAvatarImg.removeAttribute("src");
            playerAvatarFallback.textContent = "🙂";
            playerAvatarFallback.hidden = false;
        }
        profileFinished = true;
        closeModal();
        const profileDetail = {
            playerName,
            avatarUrl: avatarSelected ? (selectedAvatarDataUrl || selectedAvatarUrl) : null,
            penaltyAudioDataUrl: penaltyAudioDataUrl || null
        };
        window.dispatchEvent(new CustomEvent("kiiszik:profile-ready", { detail: profileDetail }));
        showToast(`Szia, ${playerName}! Válassz játékmódot.`);
        finishingProfile = false;
    }

    avatarUse.addEventListener("click", () => {
        if (!avatarSelected || !selectedAvatarUrl) {
            showToast("Előbb válassz képet, vagy nyomd meg a Kihagyás gombot.");
            return;
        }
        showPenaltyAudioStep();
    });
    avatarSkip.addEventListener("click", () => {
        avatarSelected = false;
        selectedAvatarDataUrl = null;
        revokeAvatarUrl();
        avatarPreview.hidden = true;
        avatarPreview.removeAttribute("src");
        avatarPlaceholder.hidden = false;
        avatarUse.disabled = true;
        showPenaltyAudioStep();
    });

    audioRecordStart.addEventListener("click", startAudioRecording);
    audioRecordStop.addEventListener("click", stopAudioRecording);
    audioPlayback.addEventListener("click", async () => {
        if (!penaltyAudioBlob || !penaltyAudioUrl) return;
        try {
            audioPlayer.currentTime = 0;
            await audioPlayer.play();
            setAudioStatus("Lejátszás folyamatban. A hangerőt a lejátszóban állíthatod.", "success");
        } catch (error) {
            setAudioStatus("A böngésző nem indította el a hangot. Használd az alsó lejátszó ▶ gombját, és ellenőrizd a hangerőt.", "error");
        }
    });
    audioDelete.addEventListener("click", async () => {
        if (audioRecorder && audioRecorder.state !== "inactive") return;
        try {
            await deleteStoredPenaltyAudio();
            penaltyAudioBlob = null;
            penaltyAudioDataUrl = null;
            penaltyAudioPersisted = false;
            audioPlayer.pause();
            audioPlayer.removeAttribute("src");
            audioPlayer.load();
            audioPlayer.hidden = true;
            if (penaltyAudioUrl) URL.revokeObjectURL(penaltyAudioUrl);
            penaltyAudioUrl = null;
            audioPlayback.disabled = true;
            audioDelete.disabled = true;
            audioContinue.disabled = true;
            resetAudioMeter();
            setAudioStatus("A mentett hangfelvétel törölve.", "success");
        } catch (error) {
            setAudioStatus("Nem sikerült törölni a felvételt. Próbáld újra.", "error");
        }
    });
    audioSkip.addEventListener("click", () => finishProfile());
    audioContinue.addEventListener("click", () => {
        if (!penaltyAudioBlob || !penaltyAudioPersisted) {
            setAudioStatus("Előbb készíts és ments el egy felvételt, vagy válaszd a Kihagyás gombot.", "error");
            return;
        }
        finishProfile();
    });
    audioPlayer.addEventListener("error", () => {
        if (penaltyAudioBlob) setAudioStatus("A böngésző nem tudta lejátszani ezt a hangfájlt. Készíts egy új felvételt.", "error");
    });

    resetAudioMeter();

    settingsButton.addEventListener("click", () => openView("settings"));
    $("k-settings-done").addEventListener("click", closeModal);
    motionToggle.addEventListener("change", () => scene.classList.toggle("k-motion-off", !motionToggle.checked));
    dizzyToggle.addEventListener("change", () => scene.classList.toggle("k-dizzy-off", !dizzyToggle.checked));

    function updateVolume() {
        const value = Number(musicVolume.value);
        audio.volume = value / 100;
        volumeLabel.textContent = `${value}%`;
    }
    function loadMusic() {
        const path = musicFiles[musicTrack.value];
        if (!path) {
            showToast("Nem található a kiválasztott zenefájl.");
            return false;
        }
        const target = new URL(path, window.location.href).href;
        if (audio.src !== target) {
            audio.pause();
            audio.src = path;
            audio.load();
        }
        return true;
    }
    async function updateMusic() {
        updateVolume();
        if (!musicToggle.checked) {
            audio.pause();
            return;
        }
        if (!loadMusic()) return;
        try {
            await audio.play();
        } catch (error) {
            console.warn("[Kiiszik] Zene hiba:", error);
            showToast("Nem sikerült lejátszani a zenét. Ellenőrizd a public/music mappát.");
        }
    }
    musicToggle.addEventListener("change", updateMusic);
    musicTrack.addEventListener("change", () => {
        if (musicToggle.checked) updateMusic();
        else loadMusic();
    });
    musicVolume.addEventListener("input", updateVolume);

    scene.classList.toggle("k-motion-off", !motionToggle.checked);
    scene.classList.toggle("k-dizzy-off", !dizzyToggle.checked);
    updateVolume();
    window.addEventListener("beforeunload", () => {
        stopCamera();
        if (audioRecorder && audioRecorder.state !== "inactive") {
            try { audioRecorder.stop(); } catch {}
        }
        if (audioRecordingStream) audioRecordingStream.getTracks().forEach((track) => track.stop());
        stopAudioMeter();
        if (penaltyAudioUrl) URL.revokeObjectURL(penaltyAudioUrl);
        revokeAvatarUrl();
    });
    console.info("[Kiiszik] A menü eseményei beállítva.");
})();
