(() => {
  const STORAGE_KEY = "gpa_state_with_transpose_v1";
  const WORKLET_FILE = "gpa-pitch-worklet.js";

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const fmtTime = (t) => {
    if (t == null || !isFinite(t)) return "--:--.--";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
  };

  const state = {
    speedPct: 100,
    transposeSemitones: 0,
    loopEnabled: false,
    loopA: null,
    loopB: null,

    rampEnabled: false,
    rampEveryLoops: 3,
    rampStepPct: 5,
    rampMaxPct: 200,
    rampLoopCount: 0,
    rampBasePct: 100,

    popout: false,
    widgetPos: null
  };

  let videoEl = null;
  let timeUpdateHandler = null;
  let watcherTimer = null;
  let widgetTimer = null;
  let suppressLoopUntil = 0;

  // ---------- Audio processing for transpose (independent of speed) ----------
  let audioContext = null;
  let sourceNode = null;
  let gainNode = null;
  let pitchNode = null;
  let audioConnected = false;
  let workletLoaded = false;

  const mediaSourceByVideo = new WeakMap();

  // ---------- Storage ----------
  async function loadState() {
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      if (res?.[STORAGE_KEY]) Object.assign(state, res[STORAGE_KEY]);
    } catch (_) {}
  }

  async function saveState() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch (_) {}
  }

  async function ensureAudioContextRunning() {
    if (!audioContext) return;
    if (audioContext.state === "running") return;
    try {
      await audioContext.resume();
    } catch (_) {}
  }

  async function loadWorkletIfNeeded() {
    if (!audioContext?.audioWorklet) throw new Error("AudioWorklet not supported");
    if (workletLoaded) return;

    const url = chrome.runtime.getURL(WORKLET_FILE);

    // Try direct URL first
    try {
      await audioContext.audioWorklet.addModule(url);
      workletLoaded = true;
      return;
    } catch (_) {}

    // Fallback: fetch -> blob URL
    const js = await (await fetch(url)).text();
    const blobUrl = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
    await audioContext.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    workletLoaded = true;
  }

  function cleanupAudio() {
    try {
      if (pitchNode) {
        pitchNode.disconnect();
        pitchNode = null;
      }
      if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
      }
      if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
      }
      audioConnected = false;
    } catch (_) {}
  }

  async function initAudioProcessing() {
    if (audioConnected || !videoEl) return;

    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      await ensureAudioContextRunning();
      await loadWorkletIfNeeded();

      // MediaElementSource: only 1 per <video>. Reuse if we already created it earlier.
      const cached = mediaSourceByVideo.get(videoEl);
      if (cached?.sourceNode) {
        sourceNode = cached.sourceNode;
      } else {
        sourceNode = audioContext.createMediaElementSource(videoEl);
        mediaSourceByVideo.set(videoEl, { sourceNode });
      }

      // Build graph: source -> gain -> pitchWorklet -> destination
      gainNode = audioContext.createGain();
      pitchNode = new AudioWorkletNode(audioContext, "gpa-pitch-worklet");

      sourceNode.connect(gainNode);
      gainNode.connect(pitchNode);
      pitchNode.connect(audioContext.destination);

      audioConnected = true;

      applyTranspose(); // set initial semitones
    } catch (_) {
      // If audio graph can't be created on this page/video, transpose will be a no-op.
      cleanupAudio();
    }
  }

  function applyTranspose() {
    if (!videoEl) return;

    const semitones = clamp(parseInt(state.transposeSemitones, 10) || 0, -12, 12);

    if (pitchNode?.parameters?.get("pitchSemitones")) {
      pitchNode.parameters.get("pitchSemitones").value = semitones;
    }
  }

  async function setTranspose(semitones) {
    state.transposeSemitones = clamp(parseInt(semitones, 10) || 0, -12, 12);

    if (state.transposeSemitones !== 0 && !audioConnected) {
      await initAudioProcessing();
    }

    applyTranspose();
    await saveState();
    syncWidgetUI();
  }

  // ---------- Video selection ----------
  function findBestVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;

    let best = null;
    let bestScore = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const visible =
        r.width > 50 &&
        r.height > 50 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth;
      const score = area * (visible ? 2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function ensureVideoAttached() {
    const v = findBestVideo();
    if (v) attachToVideo(v);
    else detachFromVideo();
  }

  function applyPlaybackRate() {
    if (!videoEl) return;

    const speed = clamp(state.speedPct, 0, 200) / 100;

    // Keep speed changes from affecting pitch (browser time-stretch).
    videoEl.preservesPitch = true;
    videoEl.mozPreservesPitch = true;
    videoEl.webkitPreservesPitch = true;

    try {
      videoEl.playbackRate = speed;
    } catch (_) {}
  }

  // ---------- Speed ramp ----------
  function resetRampIfNeeded(onManualSpeedChange) {
    if (!state.rampEnabled) return;
    if (onManualSpeedChange) {
      state.rampBasePct = clamp(state.speedPct, 0, 200);
      state.rampLoopCount = 0;
    }
  }

  async function setSpeedPct(pct, { isRampChange = false } = {}) {
    state.speedPct = clamp(parseInt(pct, 10) || 0, 0, 200);
    if (!isRampChange) resetRampIfNeeded(true);
    applyPlaybackRate();
    await saveState();
    syncWidgetUI();
  }

  async function onLoopCompleted() {
    if (!state.rampEnabled) return;
    if (state.loopA == null || state.loopB == null) return;

    state.rampLoopCount = (state.rampLoopCount || 0) + 1;

    const every = Math.max(1, parseInt(state.rampEveryLoops, 10) || 1);
    if (state.rampLoopCount % every !== 0) {
      await saveState();
      syncWidgetUI();
      return;
    }

    const step = Math.max(1, parseInt(state.rampStepPct, 10) || 1);
    const maxPct = clamp(parseInt(state.rampMaxPct, 10) || 200, 0, 200);

    const next = clamp(state.speedPct + step, 0, maxPct);
    if (next !== state.speedPct) await setSpeedPct(next, { isRampChange: true });
    else {
      await saveState();
      syncWidgetUI();
    }
  }

  async function setRampEnabled(on) {
    state.rampEnabled = !!on;
    if (state.rampEnabled) {
      state.rampBasePct = clamp(state.speedPct, 0, 200);
      state.rampLoopCount = 0;
    }
    await saveState();
    syncWidgetUI();
  }

  async function setRampParams({ every, step, max }) {
    if (every != null) state.rampEveryLoops = clamp(parseInt(every, 10) || 1, 1, 100);
    if (step != null) state.rampStepPct = clamp(parseInt(step, 10) || 1, 1, 50);
    if (max != null) state.rampMaxPct = clamp(parseInt(max, 10) || 200, 0, 200);
    await saveState();
    syncWidgetUI();
  }

  async function resetRamp() {
    state.rampLoopCount = 0;
    const base = clamp(parseInt(state.rampBasePct, 10) || 100, 0, 200);
    await setSpeedPct(base);
  }

  // ---------- Looping ----------
  function detachFromVideo() {
    cleanupAudio();
    if (videoEl && timeUpdateHandler) videoEl.removeEventListener("timeupdate", timeUpdateHandler);
    timeUpdateHandler = null;
    videoEl = null;
    syncWidgetUI();
  }

  async function attachToVideo(v) {
    if (!v || v === videoEl) return;

    detachFromVideo();
    videoEl = v;

    applyPlaybackRate();

    // If transpose is active, route audio through the worklet (speed stays independent)
    if (state.transposeSemitones !== 0) {
      await initAudioProcessing();
    }

    timeUpdateHandler = async () => {
      if (performance.now() < suppressLoopUntil) return;

      if (!state.loopEnabled) return;
      if (state.loopA == null || state.loopB == null) return;
      if (!isFinite(videoEl.currentTime)) return;

      const a = Math.min(state.loopA, state.loopB);
      const b = Math.max(state.loopA, state.loopB);

      if (videoEl.currentTime < a - 0.05) {
        videoEl.currentTime = a;
        return;
      }

      if (videoEl.currentTime >= b - 0.02) {
        await onLoopCompleted();
        videoEl.currentTime = a;
      }
    };

    videoEl.addEventListener("timeupdate", timeUpdateHandler);
    syncWidgetUI();
  }

  async function setLoopPoint(which) {
    ensureVideoAttached();
    if (!videoEl) return;

    const t = videoEl.currentTime;
    if (!isFinite(t)) return;

    if (which === "A") state.loopA = t;
    if (which === "B") state.loopB = t;

    if (state.loopA != null && state.loopB != null) state.loopEnabled = true;

    state.rampLoopCount = 0;
    await saveState();
    syncWidgetUI();
  }

  async function toggleLoop() {
    state.loopEnabled = !state.loopEnabled;
    await saveState();
    syncWidgetUI();
  }

  async function clearLoop() {
    state.loopEnabled = false;
    state.loopA = null;
    state.loopB = null;
    state.rampLoopCount = 0;
    await saveState();
    syncWidgetUI();
  }

  function goToPoint(which) {
    ensureVideoAttached();
    if (!videoEl) return;

    const raw = which === "A" ? state.loopA : state.loopB;
    if (raw == null || !isFinite(raw)) return;

    const t = which === "B" ? Math.max(0, raw - 0.08) : raw;
    suppressLoopUntil = performance.now() + 800;

    try {
      videoEl.currentTime = t;
    } catch (_) {}
  }

  // ---------- Player controls ----------
  async function playPause() {
    ensureVideoAttached();
    if (!videoEl) return;

    // if user gesture happens here, try resuming audio context
    if (audioContext) await ensureAudioContextRunning();

    try {
      if (videoEl.paused) await videoEl.play();
      else videoEl.pause();
    } catch (_) {}
    syncWidgetUI();
  }

  function seekForward10() {
    ensureVideoAttached();
    if (!videoEl) return;
    try {
      videoEl.currentTime = Math.min((videoEl.duration || Infinity), videoEl.currentTime + 10);
    } catch (_) {}
    syncWidgetUI();
  }

  function restart() {
    ensureVideoAttached();
    if (!videoEl) return;
    try {
      videoEl.currentTime = 0;
    } catch (_) {}
    syncWidgetUI();
  }

  // ---------- Pop-out widget ----------
  let widgetEl = null;
  let dragging = false;
  let dragStart = null;

  function ensureWidget() {
    if (!state.popout) {
      removeWidget();
      return;
    }

    if (widgetEl) {
      syncWidgetUI();
      return;
    }

    widgetEl = document.createElement("div");
    widgetEl.id = "gpa-widget";
    widgetEl.innerHTML = `
      <div class="hdr">
        <div>GPA <span class="muted">Pop-out</span></div>
        <div class="muted" id="gpa-w-ab">A=--:--.-- B=--:--.--</div>
      </div>
      <div class="pad">
        <div class="row">
          <div class="label"><span>Player</span><span id="gpa-w-playState">--</span></div>
          <div class="btns playerBtns">
            <button id="gpa-w-restart" title="Restart">⏮</button>
            <button id="gpa-w-playPause" title="Play/Pause">▶</button>
            <button id="gpa-w-ff10" title="Forward 10s">+10</button>
          </div>
        </div>

        <div class="row">
          <div class="label"><span>Speed</span><span id="gpa-w-speed">100%</span></div>
          <input id="gpa-w-speedR" type="range" min="0" max="200" step="1" />
        </div>

        <div class="row">
          <div class="label"><span>Transpose</span><span id="gpa-w-transpose">0</span></div>
          <input id="gpa-w-transposeR" type="range" min="-12" max="12" step="1" />
        </div>

        <div class="row">
          <div class="btns">
            <button id="gpa-w-setA">Set A</button>
            <button id="gpa-w-setB">Set B</button>
            <button id="gpa-w-loop">Loop</button>
          </div>
          <div class="btns" style="margin-top:6px;">
            <button id="gpa-w-goA">Go A</button>
            <button id="gpa-w-goB">Go B</button>
            <button id="gpa-w-clear">Clear</button>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <span>Ramp</span>
            <span class="muted" id="gpa-w-rampOn">Off</span>
          </div>
          <div class="grid3">
            <input id="gpa-w-every" type="number" min="1" max="100" step="1" title="Every (loops)" />
            <input id="gpa-w-step" type="number" min="1" max="50" step="1" title="Step (%)" />
            <input id="gpa-w-max" type="number" min="0" max="200" step="1" title="Max (%)" />
          </div>
          <div class="btns" style="margin-top:6px;">
            <button id="gpa-w-rampToggle">Ramp</button>
            <button id="gpa-w-rampReset">Reset</button>
          </div>
          <div class="tiny">+Step% every Every loops, up to Max%.</div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(widgetEl);

    if (state.widgetPos?.top != null && state.widgetPos?.left != null) {
      widgetEl.style.top = `${state.widgetPos.top}px`;
      widgetEl.style.left = `${state.widgetPos.left}px`;
      widgetEl.style.right = "auto";
      widgetEl.style.bottom = "auto";
    }

    bindWidget();
    bindWidgetDragAnywhere();
    syncWidgetUI();
  }

  function removeWidget() {
    if (!widgetEl) return;
    widgetEl.remove();
    widgetEl = null;
    dragging = false;
    dragStart = null;
  }

  function isInteractiveTarget(t) {
    return !!t?.closest?.("button, input, textarea, select, a, label");
  }

  function bindWidgetDragAnywhere() {
    if (!widgetEl) return;

    widgetEl.addEventListener(
      "pointerdown",
      (e) => {
        if (isInteractiveTarget(e.target)) return;

        dragging = true;
        widgetEl.setPointerCapture(e.pointerId);

        const rect = widgetEl.getBoundingClientRect();
        dragStart = {
          x: e.clientX,
          y: e.clientY,
          left: rect.left,
          top: rect.top,
          pointerId: e.pointerId
        };

        widgetEl.style.left = `${rect.left}px`;
        widgetEl.style.top = `${rect.top}px`;
        widgetEl.style.right = "auto";
        widgetEl.style.bottom = "auto";

        e.preventDefault();
      },
      { passive: false }
    );

    widgetEl.addEventListener("pointermove", (e) => {
      if (!dragging || !dragStart) return;
      if (e.pointerId !== dragStart.pointerId) return;

      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      const newLeft = clamp(dragStart.left + dx, 0, window.innerWidth - 50);
      const newTop = clamp(dragStart.top + dy, 0, window.innerHeight - 50);

      widgetEl.style.left = `${newLeft}px`;
      widgetEl.style.top = `${newTop}px`;
    });

    widgetEl.addEventListener("pointerup", async (e) => {
      if (!dragging || !dragStart) return;
      if (e.pointerId !== dragStart.pointerId) return;

      dragging = false;
      widgetEl.releasePointerCapture(e.pointerId);

      const rect = widgetEl.getBoundingClientRect();
      state.widgetPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      await saveState();
      dragStart = null;
    });
  }

  function bindWidget() {
    const q = (sel) => widgetEl.querySelector(sel);

    q("#gpa-w-speedR").addEventListener("input", (e) => setSpeedPct(e.target.value));
    q("#gpa-w-transposeR").addEventListener("input", (e) => setTranspose(e.target.value));

    q("#gpa-w-setA").addEventListener("click", () => setLoopPoint("A"));
    q("#gpa-w-setB").addEventListener("click", () => setLoopPoint("B"));
    q("#gpa-w-loop").addEventListener("click", () => toggleLoop());
    q("#gpa-w-clear").addEventListener("click", () => clearLoop());
    q("#gpa-w-goA").addEventListener("click", () => goToPoint("A"));
    q("#gpa-w-goB").addEventListener("click", () => goToPoint("B"));

    q("#gpa-w-rampToggle").addEventListener("click", () => setRampEnabled(!state.rampEnabled));
    q("#gpa-w-rampReset").addEventListener("click", () => resetRamp());

    q("#gpa-w-every").addEventListener("change", (e) => setRampParams({ every: e.target.value }));
    q("#gpa-w-step").addEventListener("change", (e) => setRampParams({ step: e.target.value }));
    q("#gpa-w-max").addEventListener("change", (e) => setRampParams({ max: e.target.value }));

    q("#gpa-w-restart").addEventListener("click", () => restart());
    q("#gpa-w-playPause").addEventListener("click", () => playPause());
    q("#gpa-w-ff10").addEventListener("click", () => seekForward10());
  }

  function syncWidgetUI() {
    if (!widgetEl) return;
    const q = (sel) => widgetEl.querySelector(sel);

    q("#gpa-w-speed").textContent = `${state.speedPct}%`;
    q("#gpa-w-speedR").value = String(state.speedPct);

    const semitones = state.transposeSemitones || 0;
    q("#gpa-w-transpose").textContent = semitones > 0 ? `+${semitones}` : String(semitones);
    q("#gpa-w-transposeR").value = String(semitones);

    q("#gpa-w-ab").textContent = `A=${fmtTime(state.loopA)} B=${fmtTime(state.loopB)}`;
    q("#gpa-w-loop").textContent = state.loopEnabled ? "Loop: On" : "Loop: Off";

    q("#gpa-w-rampOn").textContent = state.rampEnabled ? `On (${state.rampLoopCount})` : "Off";
    q("#gpa-w-every").value = String(state.rampEveryLoops);
    q("#gpa-w-step").value = String(state.rampStepPct);
    q("#gpa-w-max").value = String(state.rampMaxPct);
    q("#gpa-w-rampToggle").textContent = state.rampEnabled ? "Ramp: On" : "Ramp: Off";

    const playing = !!videoEl && !videoEl.paused;
    q("#gpa-w-playState").textContent = playing ? "Playing" : "Paused";
    q("#gpa-w-playPause").textContent = playing ? "⏸" : "▶";
  }

  // ---------- Messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!msg?.type) return;

      if (msg.type === "GPA_GET_STATE") {
        ensureVideoAttached();
        sendResponse({
          hasVideo: !!videoEl,
          speedPct: state.speedPct,
          transposeSemitones: state.transposeSemitones,
          loopEnabled: state.loopEnabled,
          loopA: state.loopA,
          loopB: state.loopB,
          rampEnabled: state.rampEnabled,
          rampEveryLoops: state.rampEveryLoops,
          rampStepPct: state.rampStepPct,
          rampMaxPct: state.rampMaxPct,
          rampLoopCount: state.rampLoopCount,
          popout: state.popout,
          isPlaying: !!videoEl && !videoEl.paused,
          currentTime: videoEl ? videoEl.currentTime : null,
          duration: videoEl ? videoEl.duration : null
        });
        return true;
      }

      if (msg.type === "GPA_SET") {
        const p = msg.patch || {};

        if (p.speedPct != null) await setSpeedPct(p.speedPct);
        if (p.transposeSemitones != null) await setTranspose(p.transposeSemitones);

        if (p.rampEnabled != null) await setRampEnabled(p.rampEnabled);
        if (p.rampEveryLoops != null || p.rampStepPct != null || p.rampMaxPct != null) {
          await setRampParams({
            every: p.rampEveryLoops,
            step: p.rampStepPct,
            max: p.rampMaxPct
          });
        }

        if (p.popout != null) {
          state.popout = !!p.popout;
          await saveState();
          ensureWidget();
        }

        ensureVideoAttached();
        applyPlaybackRate();
        applyTranspose();
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === "GPA_ACTION") {
        ensureVideoAttached();
        const a = msg.action;

        if (a === "setA") await setLoopPoint("A");
        if (a === "setB") await setLoopPoint("B");
        if (a === "toggleLoop") await toggleLoop();
        if (a === "clearLoop") await clearLoop();
        if (a === "goA") goToPoint("A");
        if (a === "goB") goToPoint("B");
        if (a === "resetRamp") await resetRamp();

        if (a === "playPause") await playPause();
        if (a === "ff10") seekForward10();
        if (a === "restart") restart();

        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === "GPA_COMMAND") {
        ensureVideoAttached();
        const c = msg.command;
        if (c === "set-loop-a") await setLoopPoint("A");
        if (c === "set-loop-b") await setLoopPoint("B");
        if (c === "toggle-loop") await toggleLoop();
        sendResponse({ ok: true });
        return true;
      }
    })();

    return true;
  });

  // ---------- Watcher ----------
  function startWatcher() {
    if (watcherTimer) clearInterval(watcherTimer);
    watcherTimer = setInterval(() => {
      const v = findBestVideo();
      if (v) {
        if (v !== videoEl) attachToVideo(v);

        const speed = clamp(state.speedPct, 0, 200) / 100;
        if (videoEl && Math.abs(videoEl.playbackRate - speed) > 0.001) applyPlaybackRate();

        // keep pitch param in sync (in case node exists)
        applyTranspose();
      } else {
        detachFromVideo();
      }
    }, 500);
  }

  function startWidgetTimer() {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = setInterval(() => {
      if (!widgetEl) return;
      syncWidgetUI();
    }, 500);
  }

  // ---------- Init ----------
  (async () => {
    await loadState();
    ensureWidget();
    ensureVideoAttached();
    applyPlaybackRate();

    // If transpose was saved non-zero, try to init audio processing.
    // If the page blocks AudioContext until a gesture, it will succeed after the first user interaction.
    if (state.transposeSemitones !== 0) {
      await initAudioProcessing();
    }

    startWatcher();
    startWidgetTimer();
  })();
})();