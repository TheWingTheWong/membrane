// Membrane — eigenmodes of a drum of any shape, from scratch.
//
// A drumhead fixed at its rim vibrates in modes u with  -∇²u = λu,  u = 0 on
// the boundary. Discretise the shape on an N×N grid (5-point Laplacian, cells
// outside the shape are clamped to zero), giving a sparse SPD matrix A.
// We need its *smallest* eigenpairs, which plain Krylov methods find slowly
// because they sit in a tight cluster at the bottom of a huge spectrum. So:
//
//   1. factor A = LLᵀ once with a banded Cholesky (the grid ordering keeps the
//      bandwidth ≈ one row of the shape, so this is cheap),
//   2. run block Krylov iteration on A⁻¹ (shift-invert): A's smallest
//      eigenvalues become A⁻¹'s largest and well separated, so they converge
//      in a handful of iterations; blocks catch repeated eigenvalues (a square
//      drum has many),
//   3. Rayleigh–Ritz: project A onto the Krylov basis and diagonalise the
//      small dense matrix with cyclic Jacobi rotations.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number the grid cells inside the shape (row-major). */
export function indexMask(mask, N) {
  const idx = new Int32Array(N * N).fill(-1);
  const cells = [];
  for (let g = 0; g < N * N; g++) if (mask[g]) { idx[g] = cells.length; cells.push(g); }
  return { idx, cells: Int32Array.from(cells), n: cells.length };
}

/** y = A x for the masked 5-point Laplacian with grid spacing h. */
export function laplacian(prob, x, y) {
  const { idx, cells, n, N, inv_h2 } = prob;
  for (let i = 0; i < n; i++) {
    const g = cells[i], gx = g % N;
    let s = 4 * x[i];
    if (gx > 0 && idx[g - 1] >= 0) s -= x[idx[g - 1]];
    if (gx < N - 1 && idx[g + 1] >= 0) s -= x[idx[g + 1]];
    if (g >= N && idx[g - N] >= 0) s -= x[idx[g - N]];
    if (g < N * N - N && idx[g + N] >= 0) s -= x[idx[g + N]];
    y[i] = s * inv_h2;
  }
  return y;
}

/** Banded Cholesky of A. Returns a solver for A x = b. */
export function choleskySolver(prob) {
  const { idx, cells, n, N, inv_h2 } = prob;
  // bandwidth: largest index gap between grid neighbours
  let w = 1;
  for (let i = 0; i < n; i++) {
    const g = cells[i];
    if (g >= N && idx[g - N] >= 0) w = Math.max(w, i - idx[g - N]);
  }
  const W = w + 1;
  const L = new Float64Array(n * W); // L[i][i-d] at i*W + d
  for (let i = 0; i < n; i++) {
    const g = cells[i];
    L[i * W] = 4 * inv_h2;
    if (g % N > 0 && idx[g - 1] >= 0) L[i * W + (i - idx[g - 1])] = -inv_h2;
    if (g >= N && idx[g - N] >= 0) L[i * W + (i - idx[g - N])] = -inv_h2;
  }
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - w);
    for (let j = j0; j <= i; j++) {
      let s = L[i * W + (i - j)];
      const k0 = Math.max(j0, j - w);
      for (let k = k0; k < j; k++) s -= L[i * W + (i - k)] * L[j * W + (j - k)];
      if (j === i) {
        if (s <= 0) throw new Error('matrix not positive definite');
        L[i * W] = Math.sqrt(s);
      } else L[i * W + (i - j)] = s / L[j * W];
    }
  }
  return {
    bandwidth: w,
    solve(b, x) {
      for (let i = 0; i < n; i++) { // L y = b
        let s = b[i];
        for (let k = Math.max(0, i - w); k < i; k++) s -= L[i * W + (i - k)] * x[k];
        x[i] = s / L[i * W];
      }
      for (let i = n - 1; i >= 0; i--) { // Lᵀ x = y
        let s = x[i];
        for (let k = i + 1; k <= Math.min(n - 1, i + w); k++) s -= L[k * W + (k - i)] * x[k];
        x[i] = s / L[i * W];
      }
      return x;
    },
  };
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Eigen-decomposition of a small dense symmetric matrix (cyclic Jacobi). */
export function jacobiEigen(Ain, m) {
  const A = Float64Array.from(Ain), V = new Float64Array(m * m);
  for (let i = 0; i < m; i++) V[i * m + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) off += A[p * m + q] ** 2;
    if (off < 1e-22 * (1 + Math.abs(A[0]))) break;
    for (let p = 0; p < m - 1; p++) for (let q = p + 1; q < m; q++) {
      const apq = A[p * m + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (A[q * m + q] - A[p * m + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < m; k++) { // rotate rows/cols p,q
        const akp = A[k * m + p], akq = A[k * m + q];
        A[k * m + p] = c * akp - s * akq; A[k * m + q] = s * akp + c * akq;
      }
      for (let k = 0; k < m; k++) {
        const apk = A[p * m + k], aqk = A[q * m + k];
        A[p * m + k] = c * apk - s * aqk; A[q * m + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < m; k++) {
        const vkp = V[k * m + p], vkq = V[k * m + q];
        V[k * m + p] = c * vkp - s * vkq; V[k * m + q] = s * vkp + c * vkq;
      }
    }
  }
  const values = Array.from({ length: m }, (_, i) => A[i * m + i]);
  return { values, vectors: V }; // column j of V is the eigenvector of values[j]
}

/**
 * Lowest `count` drum modes of the shape given by `mask` (Uint8Array N×N).
 * The grid covers a unit box, so h = 1/N and eigenvalues are in box units.
 * Returns { lambdas, modes (Float32Array count×N×N, zero outside), residuals, n, bandwidth }.
 */
export function solveModes(mask, N, { count = 24, block = 6, seed = 7 } = {}) {
  const base = indexMask(mask, N);
  const n = base.n;
  if (n < count + 2) throw new Error('shape too small to resolve');
  const h = 1 / N;
  const prob = { ...base, N, inv_h2: 1 / (h * h) };
  const chol = choleskySolver(prob);
  const rng = mulberry32(seed);
  const M = Math.min(n, Math.max(5 * count, 100)); // extra room so the top requested modes converge too
  const Q = [];
  const orthoNormalize = (v) => {
    for (let pass = 0; pass < 2; pass++) for (const q of Q) { const c = dot(q, v); for (let i = 0; i < n; i++) v[i] -= c * q[i]; }
    const nv = Math.sqrt(dot(v, v));
    if (nv < 1e-10) return false;
    for (let i = 0; i < n; i++) v[i] /= nv;
    Q.push(v);
    return true;
  };
  let last = [];
  for (let b = 0; b < block; b++) {
    const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = rng() - 0.5;
    if (orthoNormalize(v)) last.push(v);
  }
  while (Q.length < M && last.length) {
    const next = [];
    for (const q of last) {
      if (Q.length >= M) break;
      const v = chol.solve(q, new Float64Array(n));
      if (orthoNormalize(v)) next.push(v);
    }
    last = next;
  }
  // Rayleigh–Ritz with A on span(Q)
  const m = Q.length;
  const AQ = Q.map((q) => laplacian(prob, q, new Float64Array(n)));
  const T = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = i; j < m; j++) T[i * m + j] = T[j * m + i] = dot(Q[i], AQ[j]);
  const { values, vectors } = jacobiEigen(T, m);
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]).slice(0, count);

  const lambdas = new Float64Array(count), residuals = new Float64Array(count);
  const modes = new Float32Array(count * N * N);
  const u = new Float64Array(n), Au = new Float64Array(n);
  order.forEach((col, k) => {
    u.fill(0);
    for (let j = 0; j < m; j++) { const c = vectors[j * m + col]; if (c) { const q = Q[j]; for (let i = 0; i < n; i++) u[i] += c * q[i]; } }
    const nu = Math.sqrt(dot(u, u));
    let big = 0; for (let i = 0; i < n; i++) if (Math.abs(u[i]) > Math.abs(big)) big = u[i];
    const sgn = (big < 0 ? -1 : 1) / nu; // deterministic sign, unit norm
    for (let i = 0; i < n; i++) u[i] *= sgn;
    const lam = values[col];
    laplacian(prob, u, Au);
    let r = 0; for (let i = 0; i < n; i++) r += (Au[i] - lam * u[i]) ** 2;
    lambdas[k] = lam; residuals[k] = Math.sqrt(r) / lam;
    const off = k * N * N;
    for (let i = 0; i < n; i++) modes[off + base.cells[i]] = u[i];
  });
  return { lambdas, modes, residuals, n, N, count, bandwidth: chol.bandwidth };
}

/** Exact eigenvalues of the discrete Laplacian on a full p×p block of cells. */
export function discreteSquareEigs(p, N, count) {
  const h = 1 / N, out = [];
  for (let a = 1; a <= p; a++) for (let b = 1; b <= p; b++) {
    out.push((4 / (h * h)) * (Math.sin((a * Math.PI) / (2 * (p + 1))) ** 2 + Math.sin((b * Math.PI) / (2 * (p + 1))) ** 2));
  }
  return out.sort((x, y) => x - y).slice(0, count);
}
