// gpa-pitch-worklet.js
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fracDelayRead(buf, writeIndex, delaySamples) {
  const len = buf.length;
  let pos = writeIndex - delaySamples;
  while (pos < 0) pos += len;
  while (pos >= len) pos -= len;

  const i0 = pos | 0;
  const i1 = (i0 + 1) & (len - 1);
  const frac = pos - i0;

  return buf[i0] + (buf[i1] - buf[i0]) * frac;
}

function tri(x) {
  // triangle window: 0..1..0 over [0..1)
  const t = 1 - Math.abs(2 * x - 1);
  return t < 0 ? 0 : t;
}

function equalPower(w) {
  // map 0..1 to equal-power-ish crossfade weight
  return Math.sin(0.5 * Math.PI * w);
}

class GPAPitchWorklet extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "pitchSemitones",
        defaultValue: 0,
        minValue: -12,
        maxValue: 12,
        automationRate: "k-rate"
      }
    ];
  }

  constructor() {
    super();

    // Tune these for artifact/latency tradeoff.
    this.minDelaySec = 0.005;     // 5 ms
    this.delayRangeSec = 0.040;   // 40 ms sweep (max delay ~45 ms)

    this.minDelay = Math.max(1, Math.floor(this.minDelaySec * sampleRate));
    this.delayRange = Math.max(16, Math.floor(this.delayRangeSec * sampleRate));
    this.maxDelay = this.minDelay + this.delayRange;

    // Ring buffer size: power-of-two, comfortably > maxDelay + one render quantum
    const needed = this.maxDelay + 2048;
    let size = 1;
    while (size < needed) size <<= 1;

    this.bufSize = size;
    this.mask = size - 1;

    // Create buffers lazily per channel count we see
    this.ring = [];
    this.writeIndex = 0;

    // Phase 0..1 used to generate two delay taps 180 degrees apart
    this.phase = 0;

    // cached values
    this.lastSemi = 0;
    this.phaseInc = 0; // per-sample increment in phase units
  }

  ensureChannels(chCount) {
    while (this.ring.length < chCount) {
      this.ring.push(new Float32Array(this.bufSize));
    }
  }

  updateForSemitones(semi) {
    const s = clamp(semi, -12, 12);
    if (s === this.lastSemi) return;
    this.lastSemi = s;

    // pitch ratio
    const ratio = Math.pow(2, s / 12);

    // delay slope (samples/sample): d' = 1 - ratio
    const slope = 1 - ratio;

    // phase increment such that delay = minDelay + phase * delayRange
    // d' = delayRange * phaseInc  => phaseInc = slope / delayRange
    this.phaseInc = slope / this.delayRange;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!output || output.length === 0) return true;

    const outCh = output.length;
    const frames = output[0].length;

    if (!input || input.length === 0) {
      // no input: output silence
      for (let ch = 0; ch < outCh; ch++) output[ch].fill(0);
      return true;
    }

    this.ensureChannels(outCh);

    // k-rate param: single value for the block
    const semiArr = parameters.pitchSemitones;
    const semi = semiArr && semiArr.length ? semiArr[0] : 0;
    this.updateForSemitones(semi);

    const doShift = Math.abs(this.lastSemi) > 1e-6;

    for (let i = 0; i < frames; i++) {
      const p = this.phase;
      let p2 = p + 0.5;
      if (p2 >= 1) p2 -= 1;

      const d1 = this.minDelay + p * this.delayRange;
      const d2 = this.minDelay + p2 * this.delayRange;

      const w1 = equalPower(tri(p));
      const w2 = equalPower(tri(p2));
      const wsum = w1 + w2 + 1e-12;

      for (let ch = 0; ch < outCh; ch++) {
        const inCh = input[ch] || input[0];
        const x = (inCh && inCh[i] != null) ? inCh[i] : 0;

        // always keep ring filled
        this.ring[ch][this.writeIndex] = x;

        if (!doShift) {
          // bypass: no added latency when semitones = 0
          output[ch][i] = x;
        } else {
          const y1 = fracDelayRead(this.ring[ch], this.writeIndex, d1);
          const y2 = fracDelayRead(this.ring[ch], this.writeIndex, d2);
          output[ch][i] = (y1 * w1 + y2 * w2) / wsum;
        }
      }

      this.writeIndex = (this.writeIndex + 1) & this.mask;

      // advance phase, wrap into [0..1)
      let ph = this.phase + this.phaseInc;
      ph -= Math.floor(ph);
      if (ph < 0) ph += 1;
      this.phase = ph;
    }

    return true;
  }
}

registerProcessor("gpa-pitch-worklet", GPAPitchWorklet);