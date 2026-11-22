// Solves drum shapes off the main thread.
import { solveModes } from './solver.js';
import { polygonToMask } from './shapes.js';

self.onmessage = (e) => {
  const { id, poly, N, count } = e.data;
  try {
    const t0 = performance.now();
    const mask = polygonToMask(poly, N);
    const r = solveModes(mask, N, { count });
    self.postMessage({ id, ok: true, mask, lambdas: r.lambdas, modes: r.modes, residuals: r.residuals, n: r.n, ms: performance.now() - t0 },
      [r.modes.buffer, mask.buffer, r.lambdas.buffer, r.residuals.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
