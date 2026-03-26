const el = (id) => document.getElementById(id);
const SAVED_LOOPS_KEY = "gpa_saved_loops";

function fmtTime(t) {
  if (t == null || !isFinite(t)) return "--:--.--";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return fn(tab.id);
}

async function send(msg) {
  return withActiveTab((tabId) =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(resp);
      });
    })
  );
}

function setPlayIcon(isPlaying) {
  const btn = el("playPause");
  if (!btn) return;
  btn.textContent = isPlaying ? "⏸" : "▶";
}

// Full UI update — sets everything including inputs
function setUIFromState(s) {
  el("speed").value = s.speedPct;
  el("speedN").value = s.speedPct;
  el("speedLabel").textContent = `${s.speedPct}%`;

  const semitones = s.transposeSemitones || 0;
  el("transpose").value = semitones;
  el("transposeN").value = semitones;
  el("transposeLabel").textContent = semitones > 0 ? `+${semitones}` : String(semitones);

  const vol = s.volumeBoost != null ? s.volumeBoost : 100;
  el("volume").value = vol;
  el("volumeN").value = vol;
  el("volumeLabel").textContent = `${vol}%`;

  updateStatusFromState(s);
}

// Light refresh — only labels, status, buttons. Never touches inputs.
function updateStatusFromState(s) {
  el("speedLabel").textContent = `${s.speedPct}%`;
  const semitones = s.transposeSemitones || 0;
  el("transposeLabel").textContent = semitones > 0 ? `+${semitones}` : String(semitones);
  const vol = s.volumeBoost != null ? s.volumeBoost : 100;
  el("volumeLabel").textContent = `${vol}%`;

  el("toggleLoop").textContent = s.loopEnabled ? "Loop: On" : "Loop: Off";
  el("loopLabel").textContent = s.loopEnabled ? "On" : "Off";
  el("abTimes").textContent = `A=${fmtTime(s.loopA)}  B=${fmtTime(s.loopB)}`;

  el("rampOn").checked = !!s.rampEnabled;
  el("rampEvery").value = s.rampEveryLoops;
  el("rampStep").value = s.rampStepPct;
  el("rampMax").value = s.rampMaxPct;

  el("popout").checked = !!s.popout;

  setPlayIcon(!!s.isPlaying);
  el("playerLabel").textContent = s.hasVideo ? (s.isPlaying ? "Playing" : "Paused") : "--";

  const parts = [];
  parts.push(s.hasVideo ? "Video: detected" : "Video: not found");
  if (s.hasVideo) parts.push(`Time: ${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`);
  el("status").textContent = parts.join("\n");
}

let refreshTimer = null;

// Full refresh — used on initial load and after setPartial
async function fullRefresh() {
  try {
    const s = await send({ type: "GPA_GET_STATE" });
    if (!s) return;
    setUIFromState(s);
  } catch (_e) {
    el("status").textContent = "This page does not allow extensions (or no content script).";
  }
}

// Timer refresh — only updates labels/status, never touches inputs
async function timerRefresh() {
  try {
    const s = await send({ type: "GPA_GET_STATE" });
    if (!s) return;
    updateStatusFromState(s);
  } catch (_) {}
}

// Send patch to content script, then do a full refresh to sync inputs
async function setPartial(patch) {
  await send({ type: "GPA_SET", patch });
  await fullRefresh();
}

function on(id, evt, fn) {
  const node = el(id);
  if (!node) return;
  node.addEventListener(evt, fn);
}

function bind() {
  if (!el("speed") || !el("popout")) return;

  // Player
  on("restart", "click", () => send({ type: "GPA_ACTION", action: "restart" }).then(fullRefresh));
  on("playPause", "click", () => send({ type: "GPA_ACTION", action: "playPause" }).then(fullRefresh));
  on("ff10", "click", () => send({ type: "GPA_ACTION", action: "ff10" }).then(fullRefresh));

  // Speed — slider and number sync each other locally, then send
  on("speed", "input", (e) => {
    const v = parseInt(e.target.value, 10);
    el("speedN").value = v;
    setPartial({ speedPct: v });
  });
  on("speedN", "input", (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) { el("speed").value = v; setPartial({ speedPct: v }); }
  });
  on("speedReset", "click", () => setPartial({ speedPct: 100 }));

  // Transpose — slider and number sync each other locally, then send
  on("transpose", "input", (e) => {
    const v = parseInt(e.target.value, 10);
    el("transposeN").value = v;
    setPartial({ transposeSemitones: v });
  });
  on("transposeN", "input", (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) { el("transpose").value = v; setPartial({ transposeSemitones: v }); }
  });
  on("transposeReset", "click", () => setPartial({ transposeSemitones: 0 }));

  // Volume — slider and number sync each other locally, then send
  on("volume", "input", (e) => {
    const v = parseInt(e.target.value, 10);
    el("volumeN").value = v;
    setPartial({ volumeBoost: v });
  });
  on("volumeN", "change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) { el("volume").value = v; setPartial({ volumeBoost: v }); }
  });
  on("volumeReset", "click", () => setPartial({ volumeBoost: 100 }));

  // Loop
  on("setA", "click", () => send({ type: "GPA_ACTION", action: "setA" }).then(fullRefresh));
  on("setB", "click", () => send({ type: "GPA_ACTION", action: "setB" }).then(fullRefresh));
  on("toggleLoop", "click", () => send({ type: "GPA_ACTION", action: "toggleLoop" }).then(fullRefresh));
  on("clearLoop", "click", () => send({ type: "GPA_ACTION", action: "clearLoop" }).then(fullRefresh));
  on("goA", "click", () => send({ type: "GPA_ACTION", action: "goA" }).then(fullRefresh));
  on("goB", "click", () => send({ type: "GPA_ACTION", action: "goB" }).then(fullRefresh));

  // Save Loop
  on("saveLoop", "click", () => saveCurrentLoop());

  // Ramp
  on("rampOn", "change", (e) => setPartial({ rampEnabled: !!e.target.checked }));
  on("rampEvery", "change", (e) => setPartial({ rampEveryLoops: parseInt(e.target.value || "3", 10) }));
  on("rampStep", "change", (e) => setPartial({ rampStepPct: parseInt(e.target.value || "5", 10) }));
  on("rampMax", "change", (e) => setPartial({ rampMaxPct: parseInt(e.target.value || "200", 10) }));
  on("rampReset", "click", () => send({ type: "GPA_ACTION", action: "resetRamp" }).then(fullRefresh));

  // Pop-out
  on("popout", "change", (e) => setPartial({ popout: !!e.target.checked }));

  // Debug
  on("debugToggle", "change", async (e) => {
    const panel = el("debugPanel");
    if (panel) panel.style.display = e.target.checked ? "block" : "none";
    if (e.target.checked && !debugTimer) {
      debugTimer = setInterval(fetchDebugLogs, 1000);
    } else if (!e.target.checked && debugTimer) {
      clearInterval(debugTimer); debugTimer = null;
    }
    if (e.target.checked) {
      debugLog("Debug panel active (popup is up to date)");
      try {
        const r = await send({ type: "GPA_GET_DEBUG" });
        if (r?.logs) {
          debugLog("Content script: NEW version (has debug support)");
          r.logs.forEach(l => debugLog("[cs] " + l));
        } else {
          debugLog("Content script: OLD version (no debug). REFRESH THE YOUTUBE TAB (F5).");
        }
      } catch (err) {
        debugLog("Content script: UNREACHABLE — " + err.message);
        debugLog("You MUST refresh the YouTube tab (F5) after reloading the extension.");
      }
    }
  });
  on("debugCopy", "click", () => {
    const log = el("debugLog");
    if (log) navigator.clipboard.writeText(log.textContent).catch(() => {});
  });
  on("debugClear", "click", () => {
    const log = el("debugLog");
    if (log) log.textContent = "";
  });
}

function debugLog(msg) {
  const log = el("debugLog");
  if (!log) return;
  const t = new Date().toLocaleTimeString();
  log.textContent += `[${t}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

// ---------- Saved Loops ----------
async function getSavedLoops() {
  try { const r = await chrome.storage.local.get(SAVED_LOOPS_KEY); return r?.[SAVED_LOOPS_KEY] || []; } catch (_) { return []; }
}
async function setSavedLoops(loops) { await chrome.storage.local.set({ [SAVED_LOOPS_KEY]: loops }); }

function renderSavedLoops(loops) {
  const c = el("savedLoopsList"); if (!c) return;
  if (!loops.length) { c.innerHTML = '<div class="mini" style="opacity:0.5">No saved loops yet</div>'; return; }
  c.innerHTML = "";
  loops.forEach((loop, i) => {
    const row = document.createElement("div"); row.className = "savedLoop";
    const name = document.createElement("span"); name.className = "slName"; name.textContent = loop.name; name.title = "Click to load";
    const times = document.createElement("span"); times.className = "slTimes"; times.textContent = `${fmtTime(loop.a)}-${fmtTime(loop.b)}`;
    const renameBtn = document.createElement("button"); renameBtn.className = "slBtn"; renameBtn.textContent = "\u270e"; renameBtn.title = "Rename";
    const delBtn = document.createElement("button"); delBtn.className = "slBtn"; delBtn.textContent = "\u00d7"; delBtn.title = "Delete";
    name.addEventListener("click", async () => {
      debugLog(`Load loop: a=${loop.a}, b=${loop.b}`);
      try {
        await send({ type: "GPA_ACTION", action: "loadLoop", loopA: loop.a, loopB: loop.b });
        debugLog("loadLoop sent OK");
        await fullRefresh();
      } catch (err) {
        debugLog(`loadLoop FAILED: ${err.message}`);
      }
    });
    renameBtn.addEventListener("click", async () => {
      const n = prompt("Rename loop:", loop.name);
      if (n != null && n.trim()) { const all = await getSavedLoops(); if (all[i]) { all[i].name = n.trim(); await setSavedLoops(all); renderSavedLoops(all); } }
    });
    delBtn.addEventListener("click", async () => { const all = await getSavedLoops(); all.splice(i, 1); await setSavedLoops(all); renderSavedLoops(all); });
    row.append(name, times, renameBtn, delBtn); c.appendChild(row);
  });
}

async function saveCurrentLoop() {
  try {
    const s = await send({ type: "GPA_GET_STATE" });
    if (!s || s.loopA == null || s.loopB == null) return;
    const def = `Loop ${fmtTime(s.loopA)} - ${fmtTime(s.loopB)}`;
    const name = prompt("Name this loop:", def);
    if (name == null) return;
    const loops = await getSavedLoops();
    loops.push({ name: name.trim() || def, a: s.loopA, b: s.loopB });
    await setSavedLoops(loops); renderSavedLoops(loops);
  } catch (_) {}
}

let debugTimer = null;
async function fetchDebugLogs() {
  try {
    const r = await send({ type: "GPA_GET_DEBUG" });
    if (r?.logs?.length) {
      const log = el("debugLog");
      if (log) {
        log.textContent = r.logs.join("\n");
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async () => {
  bind();
  await fullRefresh();
  getSavedLoops().then(renderSavedLoops);
  // Timer only updates labels/status — never touches sliders or number inputs
  refreshTimer = setInterval(timerRefresh, 500);
});

window.addEventListener("unload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
