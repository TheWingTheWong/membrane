import { PRESETS, simplify, area, encodePoly, decodePoly, pointInPolygon } from './shapes.js';
import { frequencies, strikeWeights, renderStrike, renderMode, noteName, sampleMode } from './synth.js';

const $ = (id) => document.getElementById(id);
const N = 64, COUNT = 24, SHOWN = 16;
const C = { bg: '#12110e', plate0: '#2b2720', plate1: '#191713', brass: '#c9a35a', brass2: '#e2c07a', cream: '#efe2c2', teal: '#4f9c90', muted: '#9b917c', faint: '#6b6353', line: '#2e2a23' };
const SERIF = '"Instrument Serif", Georgia, serif', MONO = '"Plex Mono", ui-monospace, monospace';

const plate = $('plate'), pctx = plate.getContext('2d');
const spec = $('spectrum'), sctx = spec.getContext('2d');

// ------------------------------------------------------------- solving ----
const worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error)); };
const cache = new Map();
function solve(poly, key) {
  if (key && cache.has(key)) return cache.get(key);
  const id = ++reqId;
  const pr = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  worker.postMessage({ id, poly, N, count: COUNT });
  const out = pr.then((r) => ({ ...r, N, count: COUNT, poly }));
  if (key) cache.set(key, out);
  return out;
}

// --------------------------------------------------------------- state ----
let drum = null;            // { poly, mask, lambdas, modes, ... , name }
let freqs = [];
let active = 3;             // mode shown by the sand
let lastWeights = null, lastStrikeAt = 0;
let mode = 'strike';        // or 'draw'
let drawing = null;
const settings = { size: 0.5, hardness: 0.55, sustain: 1 };
let solves = 0, strikes = 0;

async function setDrum(poly, name, key) {
  $('busy').classList.add('show');
  try {
    const r = await solve(poly, key);
    solves++;
    drum = { ...r, name, poly };
    freqs = frequencies(drum.lambdas, { size: settings.size });
    active = Math.min(3, COUNT - 1);
    lastWeights = null;
    buildField(); scatterSand(); renderModes(); renderSpectrum();
    $('solveInfo').innerHTML = `<b>${COUNT}</b> modes · <b>${r.n.toLocaleString('en')}</b> unknowns · solved in <b>${(r.ms / 1000).toFixed(2)} s</b>`;
    $('fund').textContent = fundLabel();
    for (const b of document.querySelectorAll('[data-preset]')) b.classList.toggle('on', b.dataset.preset === name);
    $('drawBtn').classList.toggle('on', name === 'custom');
    history.replaceState(null, '', '#' + (name === 'custom' ? `s=${encodePoly(poly)}` : `p=${name}`) + `&f=${settings.size}`);
  } catch (err) {
    toast(err.message.includes('small') ? 'That drum is too small. Draw a bigger loop.' : 'Could not solve that shape');
  } finally { $('busy').classList.remove('show'); }
}
const fundLabel = () => { const n = noteName(freqs[0]); return `fundamental ${freqs[0].toFixed(1)} Hz · ${n.name}${n.cents >= 0 ? '+' : ''}${n.cents}¢`; };

// --------------------------------------------------------------- audio ----
let actx = null, master = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    master = actx.createDynamicsCompressor();
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function play(samples) {
  const ctx = audio();
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(master); src.start();
}
const sr = () => (actx ? actx.sampleRate : 44100);

function strike(x, y) {
  if (!drum) return;
  const w = strikeWeights(drum, freqs, x, y, settings.hardness);
  const samples = renderStrike(freqs, w, { sampleRate: sr(), duration: 1 + 2 * settings.sustain, sustain: settings.sustain });
  play(samples);
  strikes++;
  lastWeights = w.map(Math.abs); lastStrikeAt = performance.now();
  // the sand shows the loudest overtone you excited
  let best = 1; for (let k = 1; k < COUNT; k++) if (lastWeights[k] > lastWeights[best]) best = k;
  setActive(best, false);
  ripples.push({ x, y, t: performance.now() });
  kick = 1;
  window.__membrane.lastStrike = { x, y, weights: w, peak: samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0), length: samples.length };
}

// ---------------------------------------------------------------- sand ----
const GRAINS = 12000;
const gx = new Float32Array(GRAINS), gy = new Float32Array(GRAINS);
let field = new Float32Array(N * N), kick = 0, ripples = [];
let rng = 12345;
const rand = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
const inside = (x, y) => { const cx = Math.floor(x * N), cy = Math.floor(y * N); return cx >= 0 && cy >= 0 && cx < N && cy < N && drum.mask[cy * N + cx] === 1; };

function buildField() {
  let max = 0;
  for (let g = 0; g < N * N; g++) max = Math.max(max, Math.abs(drum.modes[active * N * N + g]));
  for (let g = 0; g < N * N; g++) field[g] = Math.abs(drum.modes[active * N * N + g]) / (max || 1);
}
function scatterSand() {
  for (let i = 0; i < GRAINS; i++) {
    let x, y, tries = 0;
    do { x = rand(); y = rand(); } while (!inside(x, y) && ++tries < 200);
    gx[i] = x; gy[i] = y;
  }
}
const fieldAt = (x, y) => {
  const fx = x * N - 0.5, fy = y * N - 0.5;
  const x0 = Math.max(0, Math.min(N - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(N - 2, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
  return (field[y0 * N + x0] * (1 - tx) + field[y0 * N + x0 + 1] * tx) * (1 - ty) + (field[(y0 + 1) * N + x0] * (1 - tx) + field[(y0 + 1) * N + x0 + 1] * tx) * ty;
};
function stepSand() {
  const hop = 0.022 + kick * 0.03;
  for (let i = 0; i < GRAINS; i++) {
    // grains on a vibrating antinode get bounced; grains on a nodal line stay put
    const a = fieldAt(gx[i], gy[i]);
    const s = hop * Math.pow(a, 1.25) + 0.00025 + kick * 0.01;
    const ang = rand() * Math.PI * 2;
    const nx = gx[i] + Math.cos(ang) * s, ny = gy[i] + Math.sin(ang) * s;
    if (inside(nx, ny)) { gx[i] = nx; gy[i] = ny; }
  }
  kick *= 0.93;
}

function setActive(k, sound = true) {
  active = k;
  buildField();
  kick = Math.max(kick, 0.35);
  document.querySelectorAll('.mode').forEach((el) => el.classList.toggle('on', +el.dataset.k === k));
  if (sound) { play(renderMode(freqs[k], { sampleRate: sr() })); lastWeights = freqs.map((_, i) => (i === k ? 1 : 0)); lastStrikeAt = performance.now(); }
}

// --------------------------------------------------------------- plate ----
function fitCanvas(c) {
  const dpr = Math.min(2, devicePixelRatio || 1), r = c.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
}
function polyPath(ctx, poly, s, ox, oy) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * s, oy + y * s) : ctx.moveTo(ox + x * s, oy + y * s)));
  ctx.closePath();
}

function drawPlate(now) {
  fitCanvas(plate);
  const W = plate.width, s = W, u = W / 800;
  pctx.fillStyle = C.bg; pctx.fillRect(0, 0, W, W);
  // frame: an engraved square with corner ticks
  pctx.strokeStyle = C.line; pctx.lineWidth = 1.5 * u;
  pctx.strokeRect(1, 1, W - 2, W - 2);
  pctx.strokeStyle = C.faint; pctx.lineWidth = 1 * u; pctx.beginPath();
  for (const [x, y, dx, dy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, W, 1, -1], [W, W, -1, -1]]) {
    pctx.moveTo(x + dx * 10 * u, y + dy * 30 * u); pctx.lineTo(x + dx * 10 * u, y + dy * 10 * u); pctx.lineTo(x + dx * 30 * u, y + dy * 10 * u);
  }
  pctx.stroke();
  if (!drum) return;

  // drumhead: dark burnished membrane
  const g = pctx.createRadialGradient(W * 0.42, W * 0.38, W * 0.05, W * 0.5, W * 0.5, W * 0.7);
  g.addColorStop(0, C.plate0); g.addColorStop(1, C.plate1);
  pctx.save();
  polyPath(pctx, drum.poly, s, 0, 0);
  pctx.fillStyle = g; pctx.fill();
  pctx.clip();
  // ripples from strikes
  ripples = ripples.filter((r) => now - r.t < 900);
  for (const r of ripples) {
    const t = (now - r.t) / 900;
    pctx.strokeStyle = `rgba(226, 192, 122, ${0.5 * (1 - t)})`; pctx.lineWidth = (3 - 2 * t) * u;
    for (const k of [0, 0.18]) { pctx.beginPath(); pctx.arc(r.x * s, r.y * s, Math.max(0, t - k) * W * 0.5, 0, Math.PI * 2); pctx.stroke(); }
  }
  // sand
  pctx.fillStyle = C.cream;
  const d = Math.max(1.2, 1.6 * u);
  for (let i = 0; i < GRAINS; i++) pctx.fillRect(gx[i] * s - d / 2, gy[i] * s - d / 2, d, d);
  pctx.restore();
  // brass rim
  polyPath(pctx, drum.poly, s, 0, 0);
  pctx.strokeStyle = '#00000080'; pctx.lineWidth = 7 * u; pctx.stroke();
  pctx.strokeStyle = C.brass; pctx.lineWidth = 2.5 * u; pctx.stroke();

  // mode caption
  pctx.font = `italic ${22 * u}px ${SERIF}`; pctx.fillStyle = C.muted; pctx.textBaseline = 'bottom'; pctx.textAlign = 'left';
  const n = noteName(freqs[active]);
  pctx.fillText(`mode ${active + 1} · ${freqs[active].toFixed(0)} Hz · ${n.name}`, 22 * u, W - 18 * u);

  // freehand drawing in progress
  if (drawing && drawing.length > 1) {
    pctx.strokeStyle = C.brass2; pctx.lineWidth = 2.5 * u; pctx.setLineDash([8 * u, 6 * u]);
    pctx.beginPath(); drawing.forEach(([x, y], i) => (i ? pctx.lineTo(x * s, y * s) : pctx.moveTo(x * s, y * s))); pctx.stroke();
    pctx.setLineDash([]);
  }
  if (mode === 'draw' && !drawing) {
    pctx.fillStyle = '#12110ebb'; pctx.fillRect(0, 0, W, W);
    pctx.font = `italic ${34 * u}px ${SERIF}`; pctx.fillStyle = C.cream; pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
    pctx.fillText('Draw one closed outline', W / 2, W / 2 - 14 * u);
    pctx.font = `${13 * u}px ${MONO}`; pctx.fillStyle = C.muted;
    pctx.fillText('press, drag around, and let go. The loop closes itself.', W / 2, W / 2 + 22 * u);
  }
}

// ------------------------------------------------------------ spectrum ----
const FMIN = 40, FMAX = 3000;
const fx = (f, w) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;
function renderSpectrum(now = performance.now()) {
  fitCanvas(spec);
  const W = spec.width, H = spec.height, u = W / 420;
  sctx.clearRect(0, 0, W, H);
  const base = H - 22 * u;
  sctx.strokeStyle = C.line; sctx.lineWidth = 1; sctx.beginPath(); sctx.moveTo(0, base + 0.5); sctx.lineTo(W, base + 0.5); sctx.stroke();
  sctx.font = `${10 * u}px ${MONO}`; sctx.fillStyle = C.faint; sctx.textAlign = 'center'; sctx.textBaseline = 'top';
  for (let o = 1; o <= 7; o++) { const f = 32.703 * 2 ** (o - 1); if (f < FMIN || f > FMAX) continue; const x = fx(f, W); sctx.fillRect(x, base, 1, 4 * u); sctx.fillText(`C${o}`, x, base + 6 * u); }
  if (!drum) return;
  // a string's harmonic series on the same fundamental, for comparison
  sctx.strokeStyle = C.faint; sctx.setLineDash([2 * u, 4 * u]); sctx.lineWidth = 1 * u;
  for (let h = 2; h <= 12; h++) { const f = freqs[0] * h; if (f > FMAX) break; const x = fx(f, W); sctx.beginPath(); sctx.moveTo(x, base); sctx.lineTo(x, 12 * u); sctx.stroke(); }
  sctx.setLineDash([]);
  const age = lastWeights ? Math.min(1, (now - lastStrikeAt) / 2500) : 1;
  const wmax = lastWeights ? Math.max(...lastWeights) || 1 : 1;
  for (let k = 0; k < COUNT; k++) {
    if (freqs[k] > FMAX) break;
    const x = fx(freqs[k], W);
    const live = lastWeights ? (lastWeights[k] / wmax) * (1 - age) : 0;
    const h = (0.22 + 0.7 * live) * (base - 14 * u);
    sctx.strokeStyle = k === active ? C.brass2 : live > 0.05 ? C.cream : C.muted;
    sctx.lineWidth = (k === active ? 2.5 : 1.5) * u;
    sctx.beginPath(); sctx.moveTo(x, base); sctx.lineTo(x, base - h); sctx.stroke();
  }
}

// --------------------------------------------------------------- modes ----
function paintMode(canvas, k, d = drum) {
  const c = canvas.getContext('2d'), img = c.createImageData(N, N);
  let max = 0; for (let g = 0; g < N * N; g++) max = Math.max(max, Math.abs(d.modes[k * N * N + g]));
  const bg = [26, 24, 20], pos = [239, 226, 194], neg = [79, 156, 144];
  for (let g = 0; g < N * N; g++) {
    const v = d.modes[k * N * N + g] / (max || 1), a = Math.pow(Math.abs(v), 0.65), col = v >= 0 ? pos : neg;
    const o = g * 4, isIn = d.mask[g];
    img.data[o] = isIn ? bg[0] + (col[0] - bg[0]) * a : 18; img.data[o + 1] = isIn ? bg[1] + (col[1] - bg[1]) * a : 17;
    img.data[o + 2] = isIn ? bg[2] + (col[2] - bg[2]) * a : 14; img.data[o + 3] = 255;
  }
  canvas.width = canvas.height = N;
  c.putImageData(img, 0, 0);
}
function renderModes() {
  $('modes').innerHTML = Array.from({ length: SHOWN }, (_, k) => {
    const n = noteName(freqs[k]);
    return `<button class="mode ${k === active ? 'on' : ''}" data-k="${k}" title="mode ${k + 1}: ${freqs[k].toFixed(1)} Hz (${n.name} ${n.cents >= 0 ? '+' : ''}${n.cents} cents)"><canvas></canvas><span>${k + 1}<i>${n.name}</i></span></button>`;
  }).join('');
  document.querySelectorAll('.mode').forEach((b) => { paintMode(b.querySelector('canvas'), +b.dataset.k); b.onclick = () => setActive(+b.dataset.k); });
}

// --------------------------------------------------------------- input ----
const toBox = (e) => { const r = plate.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
plate.addEventListener('pointerdown', (e) => {
  const [x, y] = toBox(e);
  if (mode === 'draw') { plate.setPointerCapture(e.pointerId); drawing = [[x, y]]; return; }
  if (drum && pointInPolygon(x, y, drum.poly)) strike(x, y);
});
plate.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const [x, y] = toBox(e), [lx, ly] = drawing[drawing.length - 1];
  if (Math.hypot(x - lx, y - ly) > 0.004) drawing.push([Math.min(0.97, Math.max(0.03, x)), Math.min(0.97, Math.max(0.03, y))]);
});
plate.addEventListener('pointerup', () => {
  if (!drawing) return;
  const pts = simplify(drawing, 0.003);
  drawing = null;
  setMode('strike');
  if (pts.length < 4 || area(pts) < 0.03) { toast('Draw a bigger closed loop'); return; }
  setDrum(pts, 'custom');
});
function setMode(m) {
  mode = m;
  $('drawBtn').classList.toggle('on', m === 'draw' || drum?.name === 'custom');
  $('hint').textContent = m === 'draw' ? 'Draw a closed outline on the plate.' : 'Click anywhere on the drumhead to strike it.';
}
$('drawBtn').onclick = () => setMode(mode === 'draw' ? 'strike' : 'draw');
$('presets').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button class="chip" data-preset="${k}">${p.label}</button>`).join('');
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { setMode('strike'); setDrum(PRESETS[b.dataset.preset].poly, b.dataset.preset, b.dataset.preset); }));

for (const [id, key, fmt] of [['sizeIn', 'size', (v) => `${Math.round(v * 100)} cm`], ['hardIn', 'hardness', (v) => (v < 0.3 ? 'felt' : v < 0.7 ? 'wood' : 'metal')], ['susIn', 'sustain', (v) => `${v.toFixed(1)}×`]]) {
  const el = $(id), out = $(id.replace('In', 'Out'));
  const sync = () => {
    settings[key] = +el.value; out.textContent = fmt(+el.value);
    if (key === 'size' && drum) { freqs = frequencies(drum.lambdas, { size: settings.size }); renderModes(); $('fund').textContent = fundLabel(); history.replaceState(null, '', location.hash.replace(/f=[\d.]+/, `f=${settings.size}`)); }
  };
  el.addEventListener('input', sync); sync();
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ' && drum) { e.preventDefault(); const c = centroidInside(drum); strike(c[0], c[1]); }
  else if (e.key >= '1' && e.key <= '9' && drum) setActive(+e.key - 1);
  else if (e.key === 'd') setMode(mode === 'draw' ? 'strike' : 'draw');
});
$('shareBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Link copied. It opens this exact drum.'); } catch { toast('The address bar holds the link'); }
};
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

/** A point inside the drum, slightly off-centre so most modes are excited. */
function centroidInside(d) {
  let sx = 0, sy = 0, c = 0;
  for (let g = 0; g < N * N; g++) if (d.mask[g]) { sx += (g % N) + 0.5; sy += Math.floor(g / N) + 0.5; c++; }
  const cx = sx / c / N + 0.07, cy = sy / c / N + 0.05;
  if (inside(cx, cy)) return [cx, cy];
  for (let g = 0; g < N * N; g++) if (d.mask[g]) return [((g % N) + 0.5) / N, (Math.floor(g / N) + 0.5) / N];
  return [0.5, 0.5];
}

// ------------------------------------------------------------ ear test ----
const ear = { options: [], answer: -1, point: null, streak: 0, done: false, ready: false };
async function newRound() {
  ear.done = false; ear.ready = false;
  const keys = Object.keys(PRESETS);
  const pick = [];
  while (pick.length < 3) { const k = keys[Math.floor(Math.random() * keys.length)]; if (!pick.includes(k)) pick.push(k); }
  ear.options = pick;
  ear.answer = Math.floor(Math.random() * 3);
  $('earMsg').textContent = 'tuning the drums…';
  $('options').innerHTML = pick.map((k, i) => `<button class="opt" data-o="${i}"><canvas width="160" height="160"></canvas>${PRESETS[k].label}</button>`).join('');
  const solved = await Promise.all(pick.map((k) => solve(PRESETS[k].poly, k)));
  ear.solved = solved;
  document.querySelectorAll('.opt').forEach((b, i) => {
    const c = b.querySelector('canvas').getContext('2d');
    c.fillStyle = C.bg; c.fillRect(0, 0, 160, 160);
    polyPath(c, PRESETS[pick[i]].poly, 160, 0, 0); c.fillStyle = '#26221c'; c.fill(); c.strokeStyle = C.brass; c.lineWidth = 2; c.stroke();
    b.onclick = () => guess(i);
  });
  // strike the mystery drum at a random point well inside it
  const d = solved[ear.answer], cells = [];
  for (let g = 0; g < N * N; g++) if (d.mask[g]) cells.push(g);
  const g = cells[Math.floor(Math.random() * cells.length)];
  ear.point = [((g % N) + 0.5) / N, (Math.floor(g / N) + 0.5) / N];
  ear.ready = true;
  $('earMsg').textContent = 'Press play, then pick a shape.';
}
function playMystery() {
  if (!ear.ready) return;
  const d = ear.solved[ear.answer], f = frequencies(d.lambdas, { size: 0.5 });
  play(renderStrike(f, strikeWeights(d, f, ear.point[0], ear.point[1], 0.6), { sampleRate: sr(), duration: 2.5 }));
  ear.played = true;
}
function guess(i) {
  if (ear.done || !ear.ready) return;
  ear.done = true;
  const ok = i === ear.answer;
  ear.streak = ok ? ear.streak + 1 : 0;
  document.querySelectorAll('.opt').forEach((b, j) => { if (j === ear.answer) b.classList.add('right'); else if (j === i) b.classList.add('wrong'); });
  $('streak').textContent = `streak ${ear.streak}`;
  $('earMsg').textContent = ok ? 'Right. You heard the shape.' : `It was the ${PRESETS[ear.options[ear.answer]].label.toLowerCase()}.`;
  window.__membrane.ear.lastResult = ok;
}
$('earPlay').onclick = playMystery;
$('earNext').onclick = newRound;

// ---------------------------------------------------------------- loop ----
function frame(now) {
  requestAnimationFrame(frame);
  if (drum) stepSand();
  drawPlate(now);
  if (lastWeights && now - lastStrikeAt < 2700) renderSpectrum(now);
}

// ---------------------------------------------------------------- boot ----
window.__membrane = {
  get drum() { return drum; }, get freqs() { return freqs; }, get active() { return active; },
  get solves() { return solves; }, get strikes() { return strikes; }, ear, lastStrike: null, solve: (poly) => solve(poly),
  get sandOnAntinodes() { let t = 0; for (let i = 0; i < GRAINS; i += 3) t += fieldAt(gx[i], gy[i]); return t / Math.ceil(GRAINS / 3); },
  fieldMean() { let t = 0, c = 0; for (let g = 0; g < N * N; g++) if (drum.mask[g]) { t += field[g]; c++; } return t / c; },
};
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('f')) { const f = Math.min(1, Math.max(0.25, +hash.get('f') || 0.5)); $('sizeIn').value = f; $('sizeIn').dispatchEvent(new Event('input')); }
let start = ['circle', PRESETS.circle.poly];
try {
  if (hash.has('s')) start = ['custom', decodePoly(hash.get('s'))];
  else if (PRESETS[hash.get('p')]) start = [hash.get('p'), PRESETS[hash.get('p')].poly];
} catch { /* bad link: fall back to the circle */ }
setDrum(start[1], start[0], start[0] === 'custom' ? null : start[0]).then(() => renderSpectrum());
addEventListener('resize', () => renderSpectrum());
requestAnimationFrame(frame);
newRound();
