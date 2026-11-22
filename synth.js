// Membrane — modal synthesis: a struck drum is a sum of its modes, each
// ringing at its own frequency, excited in proportion to how much that mode
// moves at the strike point, and dying away (high modes die faster).

/** Physical frequency (Hz) of each mode for a drum whose frame is `size` metres across. */
export function frequencies(lambdas, { size = 0.5, waveSpeed = 100 } = {}) {
  // λ is in box units: λ_phys = λ / size², f = c·√λ_phys / 2π
  return Array.from(lambdas, (l) => (waveSpeed * Math.sqrt(l)) / (2 * Math.PI * size));
}

/** Bilinear sample of mode k's shape at (x, y) in [0,1]² box coordinates. */
export function sampleMode(modes, N, k, x, y) {
  const gx = x * N - 0.5, gy = y * N - 0.5;
  const x0 = Math.max(0, Math.min(N - 2, Math.floor(gx))), y0 = Math.max(0, Math.min(N - 2, Math.floor(gy)));
  const fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
  const o = k * N * N, at = (xx, yy) => modes[o + yy * N + xx];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * How loudly each mode sounds for a strike at (x, y).
 * Mallet hardness 0..1: soft mallets can't excite high modes (Gaussian roll-off).
 */
export function strikeWeights({ modes, N, count }, freqs, x, y, hardness = 0.5) {
  const fc = 250 + hardness * hardness * 4000;
  return Array.from({ length: count }, (_, k) => sampleMode(modes, N, k, x, y) * Math.exp(-((freqs[k] / fc) ** 2)));
}

export function decayTimes(freqs, sustain = 1) {
  return freqs.map((f) => sustain * 1.1 * Math.pow(freqs[0] / f, 0.8));
}

/** Render a strike to a mono Float32Array, peak-normalised to 0.8. */
export function renderStrike(freqs, weights, { sampleRate = 44100, duration = 2.5, sustain = 1 } = {}) {
  const len = Math.round(sampleRate * duration), out = new Float32Array(len);
  const taus = decayTimes(freqs, sustain);
  for (let k = 0; k < freqs.length; k++) {
    const a = weights[k];
    if (!a || freqs[k] >= sampleRate / 2) continue;
    const w = (2 * Math.PI * freqs[k]) / sampleRate;
    const d = Math.exp(-1 / (taus[k] * sampleRate));
    // recursive oscillator: cheap and exact
    let s0 = 0, s1 = Math.sin(w) * a, env = 1;
    const c = 2 * Math.cos(w);
    out[0] += s0; if (len > 1) out[1] += s1 * d;
    for (let i = 2; i < len; i++) { const s2 = c * s1 - s0; s0 = s1; s1 = s2; env *= d; out[i] += s2 * env * d; }
  }
  const attack = Math.round(sampleRate * 0.002);
  for (let i = 0; i < attack && i < len; i++) out[i] *= i / attack;
  let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < len; i++) out[i] *= 0.8 / peak;
  return out;
}

/** One mode on its own, gently bowed (soft attack, long ring). */
export function renderMode(freq, { sampleRate = 44100, duration = 1.8 } = {}) {
  const len = Math.round(sampleRate * duration), out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate, env = Math.min(1, t / 0.08) * Math.exp(-t / 0.9);
    out[i] = 0.5 * env * Math.sin(2 * Math.PI * freq * t);
  }
  return out;
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(f) {
  const m = 69 + 12 * Math.log2(f / 440), r = Math.round(m), cents = Math.round((m - r) * 100);
  return { name: `${NOTES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents };
}

/** Magnitude spectrum (radix-2 FFT, Hann window). Used to verify synthesis. */
export function spectrum(signal, size = 1 << 15) {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size && i < signal.length; i++) re[i] = signal[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < size; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar; im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
