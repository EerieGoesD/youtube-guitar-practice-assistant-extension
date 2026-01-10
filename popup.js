const el = (id) => document.getElementById(id);

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

function setUIFromState(s) {
  el("speed").value = s.speedPct;
  el("speedN").value = s.speedPct;
  el("speedLabel").textContent = `${s.speedPct}%`;

  const semitones = s.transposeSemitones || 0;
  el("transpose").value = semitones;
  el("transposeN").value = semitones;
  el("transposeLabel").textContent = semitones > 0 ? `+${semitones}` : String(semitones);

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

async function refresh() {
  try {
    const s = await send({ type: "GPA_GET_STATE" });
    if (!s) return;
    setUIFromState(s);
  } catch (_e) {
    el("status").textContent = "This page does not allow extensions (or no content script).";
  }
}

async function setPartial(patch) {
  await send({ type: "GPA_SET", patch });
  await refresh();
}

function on(id, evt, fn) {
  const node = el(id);
  if (!node) return;
  node.addEventListener(evt, fn);
}

function bind() {
  if (!el("speed") || !el("popout")) return;

  // Player
  on("restart", "click", () => send({ type: "GPA_ACTION", action: "restart" }).then(refresh));
  on("playPause", "click", () => send({ type: "GPA_ACTION", action: "playPause" }).then(refresh));
  on("ff10", "click", () => send({ type: "GPA_ACTION", action: "ff10" }).then(refresh));

  // Speed
  on("speed", "input", (e) => setPartial({ speedPct: parseInt(e.target.value, 10) }));
  on("speedN", "change", (e) => setPartial({ speedPct: parseInt(e.target.value || "100", 10) }));
  on("speedReset", "click", () => setPartial({ speedPct: 100 }));

  // Transpose
  on("transpose", "input", (e) => setPartial({ transposeSemitones: parseInt(e.target.value, 10) }));
  on("transposeN", "change", (e) => setPartial({ transposeSemitones: parseInt(e.target.value || "0", 10) }));
  on("transposeReset", "click", () => setPartial({ transposeSemitones: 0 }));

  // Loop
  on("setA", "click", () => send({ type: "GPA_ACTION", action: "setA" }).then(refresh));
  on("setB", "click", () => send({ type: "GPA_ACTION", action: "setB" }).then(refresh));
  on("toggleLoop", "click", () => send({ type: "GPA_ACTION", action: "toggleLoop" }).then(refresh));
  on("clearLoop", "click", () => send({ type: "GPA_ACTION", action: "clearLoop" }).then(refresh));
  on("goA", "click", () => send({ type: "GPA_ACTION", action: "goA" }).then(refresh));
  on("goB", "click", () => send({ type: "GPA_ACTION", action: "goB" }).then(refresh));

  // Ramp
  on("rampOn", "change", (e) => setPartial({ rampEnabled: !!e.target.checked }));
  on("rampEvery", "change", (e) => setPartial({ rampEveryLoops: parseInt(e.target.value || "3", 10) }));
  on("rampStep", "change", (e) => setPartial({ rampStepPct: parseInt(e.target.value || "5", 10) }));
  on("rampMax", "change", (e) => setPartial({ rampMaxPct: parseInt(e.target.value || "200", 10) }));
  on("rampReset", "click", () => send({ type: "GPA_ACTION", action: "resetRamp" }).then(refresh));

  // Pop-out
  on("popout", "change", (e) => setPartial({ popout: !!e.target.checked }));
}

document.addEventListener("DOMContentLoaded", async () => {
  bind();
  await refresh();
  refreshTimer = setInterval(refresh, 500);
});

window.addEventListener("unload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
