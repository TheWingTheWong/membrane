// Membrane — drum outlines: presets, freehand cleanup, rasterising, sharing.
// All coordinates live in the unit box [0,1]² (the drum's frame).

const circle = (cx, cy, r, n = 96) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);

function star(points = 5, ro = 0.44, ri = 0.2) {
  return Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 ? ri : ro, a = (Math.PI * i) / points - Math.PI / 2;
    return [0.5 + r * Math.cos(a), 0.52 + r * Math.sin(a)];
  });
}

function guitar() { // union of a small upper bout and a big lower bout, traced radially
  const inU = (x, y) => (x - 0.5) ** 2 + (y - 0.32) ** 2 < 0.205 ** 2 || (x - 0.5) ** 2 + (y - 0.64) ** 2 < 0.27 ** 2;
  return Array.from({ length: 160 }, (_, i) => {
    const a = (2 * Math.PI * i) / 160, dx = Math.cos(a), dy = Math.sin(a);
    let lo = 0, hi = 0.6;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (inU(0.5 + dx * m, 0.5 + dy * m)) lo = m; else hi = m; }
    return [0.5 + dx * lo, 0.5 + dy * lo];
  });
}

function heart() {
  return Array.from({ length: 120 }, (_, i) => {
    const t = (2 * Math.PI * i) / 120;
    const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [0.5 + x * 0.025, 0.47 - y * 0.025];
  });
}

export const PRESETS = {
  circle: { label: 'Circle', poly: circle(0.5, 0.5, 0.42) },
  square: { label: 'Square', poly: [[0.13, 0.13], [0.87, 0.13], [0.87, 0.87], [0.13, 0.87]] },
  guitar: { label: 'Guitar', poly: guitar() },
  star: { label: 'Star', poly: star() },
  heart: { label: 'Heart', poly: heart() },
  triangle: { label: 'Triangle', poly: [[0.5, 0.1], [0.92, 0.84], [0.08, 0.84]] },
};

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rasterise at cell centres, keeping only the largest connected piece. */
export function polygonToMask(poly, N) {
  const m = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (pointInPolygon((x + 0.5) / N, (y + 0.5) / N, poly)) m[y * N + x] = 1;
  // clear the frame's outer ring so every drum is clamped by a rim
  for (let i = 0; i < N; i++) m[i] = m[(N - 1) * N + i] = m[i * N] = m[i * N + N - 1] = 0;
  return largestComponent(m, N);
}

export function largestComponent(m, N) {
  const label = new Int32Array(N * N).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < N * N; s++) {
    if (!m[s] || label[s] >= 0) continue;
    const stack = [s]; label[s] = id; let size = 0;
    while (stack.length) {
      const g = stack.pop(); size++;
      const x = g % N;
      for (const nb of [x > 0 ? g - 1 : -1, x < N - 1 ? g + 1 : -1, g - N, g + N]) {
        if (nb >= 0 && nb < N * N && m[nb] && label[nb] < 0) { label[nb] = id; stack.push(nb); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  const out = new Uint8Array(N * N);
  for (let g = 0; g < N * N; g++) out[g] = label[g] === best ? 1 : 0;
  return out;
}

/** Ramer–Douglas–Peucker simplification of an open polyline. */
export function simplify(pts, eps = 0.004) {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  let far = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    // closed loops start and end at the same spot: fall back to distance from that point
    const d = len < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
    if (d > far) { far = d; idx = i; }
  }
  if (far <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

export function area(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}

// Share links: each vertex quantised to 12 bits per axis, base64url.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function encodePoly(poly) {
  let s = '';
  for (const [x, y] of poly) {
    const qx = Math.max(0, Math.min(4095, Math.round(x * 4095))), qy = Math.max(0, Math.min(4095, Math.round(y * 4095)));
    s += B64[qx >> 6] + B64[qx & 63] + B64[qy >> 6] + B64[qy & 63];
  }
  return s;
}
export function decodePoly(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 || s.length < 12) throw new Error('bad shape code');
  const v = (c) => B64.indexOf(c), out = [];
  for (let i = 0; i < s.length; i += 4) out.push([((v(s[i]) << 6) | v(s[i + 1])) / 4095, ((v(s[i + 2]) << 6) | v(s[i + 3])) / 4095]);
  return out;
}
