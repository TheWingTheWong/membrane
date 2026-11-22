import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveModes, discreteSquareEigs, jacobiEigen, choleskySolver, indexMask, laplacian, mulberry32 } from '../solver.js';
import { frequencies, strikeWeights, renderStrike, renderMode, noteName, spectrum, sampleMode } from '../synth.js';
import { PRESETS, polygonToMask, simplify, area, encodePoly, decodePoly, pointInPolygon, largestComponent } from '../shapes.js';

const N = 56;
const squareMask = (p, off = 4) => { const m = new Uint8Array(N * N); for (let y = off; y < off + p; y++) for (let x = off; x < off + p; x++) m[y * N + x] = 1; return m; };

test('Jacobi diagonalises a symmetric matrix', () => {
  const A = [4, 1, 2, 1, 3, 0, 2, 0, 5], { values, vectors } = jacobiEigen(A, 3);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    let Av = 0; for (let k = 0; k < 3; k++) Av += A[i * 3 + k] * vectors[k * 3 + j];
    assert.ok(Math.abs(Av - values[j] * vectors[i * 3 + j]) < 1e-10);
  }
  assert.ok(Math.abs(values.reduce((a, b) => a + b) - 12) < 1e-10, 'trace preserved');
});

test('banded Cholesky solves the drum matrix exactly', () => {
  const mask = polygonToMask(PRESETS.star.poly, N), base = indexMask(mask, N);
  const prob = { ...base, N, inv_h2: N * N }, chol = choleskySolver(prob);
  const rng = mulberry32(2), b = Float64Array.from({ length: base.n }, () => rng() - 0.5);
  const x = chol.solve(b, new Float64Array(base.n)), Ax = laplacian(prob, x, new Float64Array(base.n));
  let err = 0; for (let i = 0; i < base.n; i++) err = Math.max(err, Math.abs(Ax[i] - b[i]));
  assert.ok(err < 1e-9, `residual ${err}`);
});

test('square drum: matches the exact discrete spectrum, including repeated eigenvalues', () => {
  const p = N - 8, r = solveModes(squareMask(p), N, { count: 20 }), ex = discreteSquareEigs(p, N, 20);
  r.lambdas.forEach((l, i) => assert.ok(Math.abs(l - ex[i]) / ex[i] < 1e-5, `mode ${i}: ${l} vs ${ex[i]}`));
  assert.ok(Math.abs(r.lambdas[1] - r.lambdas[2]) / r.lambdas[1] < 1e-6, '(1,2) and (2,1) are degenerate');
  // continuum limit: λ ≈ π²(m²+n²)/L² within discretisation error
  const L = (p + 1) / N;
  assert.ok(Math.abs(r.lambdas[0] - (2 * Math.PI ** 2) / L ** 2) / r.lambdas[0] < 0.01);
});

test('modes are orthonormal, accurate and deterministic', () => {
  const r = solveModes(polygonToMask(PRESETS.guitar.poly, N), N, { count: 12 });
  for (let a = 0; a < 12; a++) for (let b = a; b < 12; b++) {
    let d = 0; for (let g = 0; g < N * N; g++) d += r.modes[a * N * N + g] * r.modes[b * N * N + g];
    assert.ok(Math.abs(d - (a === b ? 1 : 0)) < 2e-4, `<${a},${b}> = ${d}`);
  }
  r.residuals.forEach((res, k) => assert.ok(res < 0.02, `mode ${k} residual ${res}`));
  const again = solveModes(polygonToMask(PRESETS.guitar.poly, N), N, { count: 12 });
  assert.deepEqual(again.modes, r.modes, 'deterministic, including signs');
  // fundamental of a drum never changes sign
  for (let g = 0; g < N * N; g++) assert.ok(r.modes[g] >= -1e-6);
});

test('circular drum: overtone ratios match Bessel zeros (1 : 1.593 : 2.136 : 2.295)', () => {
  const r = solveModes(polygonToMask(PRESETS.circle.poly, 72), 72, { count: 8 });
  const ratio = (k) => Math.sqrt(r.lambdas[k] / r.lambdas[0]);
  for (const [k, want] of [[1, 1.5933], [2, 1.5933], [3, 2.1355], [4, 2.1355], [5, 2.2954]]) {
    assert.ok(Math.abs(ratio(k) - want) / want < 0.01, `mode ${k}: ${ratio(k)} vs ${want}`);
  }
});

test('a struck circular drum sounds at its Bessel partials (FFT of the synthesised audio)', () => {
  const r = solveModes(polygonToMask(PRESETS.circle.poly, 64), 64, { count: 6 });
  const f = frequencies(r.lambdas, { size: 0.5 });
  const w = strikeWeights(r, f, 0.37, 0.43, 0.9);
  const audio = renderStrike(f, w, { sampleRate: 32768, duration: 1 });
  const mag = spectrum(audio, 32768); // 1 Hz bins
  const peakNear = (hz) => { let best = 0, at = 0; for (let b = Math.round(hz * 0.97); b <= hz * 1.03; b++) if (mag[b] > best) { best = mag[b]; at = b; } return at; };
  assert.ok(Math.abs(peakNear(f[0]) - f[0]) <= 2, 'fundamental present');
  assert.ok(Math.abs(peakNear(f[3]) - f[3]) <= 2, 'overtone present');
  const offPeak = mag[Math.round(f[0] * 1.3)];
  assert.ok(mag[Math.round(f[0])] > 20 * offPeak, 'energy is concentrated at the modes, not between them');
});

test('striking a nodal line silences that mode', () => {
  const r = solveModes(squareMask(N - 8), N, { count: 4 });
  const f = frequencies(r.lambdas);
  // mode 1 or 2 of a square has a nodal line through the centre; the fundamental doesn't
  const w = strikeWeights(r, f, 0.5, 0.5, 1);
  assert.ok(Math.abs(w[0]) > 0.01);
  assert.ok(Math.abs(w[1]) + Math.abs(w[2]) < Math.abs(w[0]) * 0.05);
  assert.ok(Math.abs(sampleMode(r.modes, N, 0, 0.5, 0.5)) > 0);
});

test('bigger frame = lower pitch; note names and mode tones', () => {
  const [small] = frequencies([20], { size: 0.3 }), [big] = frequencies([20], { size: 0.6 });
  assert.ok(Math.abs(small / big - 2) < 1e-12);
  assert.deepEqual(noteName(440), { name: 'A4', cents: 0 });
  assert.deepEqual(noteName(261.63), { name: 'C4', cents: 0 });
  assert.equal(noteName(452).cents, 47);
  const tone = renderMode(220, { duration: 0.5 });
  assert.ok(tone.length === 22050 && Math.max(...tone) <= 0.5);
});

test('shapes: masks, simplification, area, share codes', () => {
  assert.ok(pointInPolygon(0.5, 0.5, PRESETS.square.poly) && !pointInPolygon(0.05, 0.5, PRESETS.square.poly));
  const m = polygonToMask(PRESETS.heart.poly, 40);
  assert.ok(m.reduce((a, b) => a + b) > 300);
  const two = new Uint8Array(100); two[11] = two[12] = two[22] = 1; two[77] = 1; // 3-cell blob + 1 stray cell
  assert.equal(largestComponent(two, 10).reduce((a, b) => a + b), 3);
  const wiggly = Array.from({ length: 200 }, (_, i) => [i / 199, 0.5 + 0.0005 * Math.sin(i)]);
  assert.equal(simplify(wiggly).length, 2);
  const loop = Array.from({ length: 101 }, (_, i) => [0.5 + 0.3 * Math.cos((i / 100) * 2 * Math.PI), 0.5 + 0.3 * Math.sin((i / 100) * 2 * Math.PI)]);
  const closed = simplify(loop);
  assert.ok(closed.length > 12 && area(closed) > 0.25, 'a closed loop (start == end) survives simplification');
  assert.ok(Math.abs(area(PRESETS.square.poly) - 0.74 ** 2) < 1e-12);
  const code = encodePoly(PRESETS.star.poly), back = decodePoly(code);
  back.forEach(([x, y], i) => assert.ok(Math.abs(x - PRESETS.star.poly[i][0]) < 1 / 4000 && Math.abs(y - PRESETS.star.poly[i][1]) < 1 / 4000));
  assert.throws(() => decodePoly('!!!!'));
});
