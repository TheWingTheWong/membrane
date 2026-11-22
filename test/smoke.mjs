// End-to-end: physics, sound, drawing, sharing and the ear test in headless Chromium.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const shotDir = process.env.SHOT_DIR;
const server = await startServer(0);
const root = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const M = (page, expr) => page.evaluate(expr);
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(root);
  await page.waitForFunction(() => window.__membrane?.drum, null, { timeout: 30000 });

  // physics: the default circle sounds at Bessel ratios
  const r = await M(page, () => window.__membrane.freqs.slice(0, 6).map((f, _, a) => f / a[0]));
  [1, 1.5933, 1.5933, 2.1355, 2.1355, 2.2954].forEach((want, i) => assert.ok(Math.abs(r[i] - want) / want < 0.015, `circle ratio ${i}: ${r[i]}`));
  console.log('✓ circle drum overtones match Bessel zeros (' + r.slice(1, 4).map((v) => v.toFixed(3)).join(', ') + ')');

  // strike → synthesis
  const box = await page.locator('#plate').boundingBox();
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.44);
  const st = await M(page, () => ({ n: window.__membrane.strikes, ...window.__membrane.lastStrike }));
  assert.equal(st.n, 1);
  assert.ok(Math.abs(st.peak - 0.8) < 1e-3 && st.weights.length === 24 && st.length > 40000);
  assert.equal(await M(page, () => window.__membrane.active > 0), true, 'sand switches to the loudest overtone');
  console.log('✓ clicking strikes the drum and synthesises 24 modes');

  // Chladni sand migrates to nodal lines
  await page.click('.mode[data-k="5"]');
  assert.equal(await M(page, () => window.__membrane.active), 5);
  const uniform = await M(page, () => window.__membrane.fieldMean());
  await page.waitForTimeout(3500);
  const settled = await M(page, () => window.__membrane.sandOnAntinodes);
  assert.ok(settled < uniform * 0.7, `sand settles on nodes: mean |u| under grains ${settled.toFixed(3)} vs ${uniform.toFixed(3)} uniform`);
  console.log(`✓ sand migrates to nodal lines (amplitude under grains ${settled.toFixed(2)} vs ${uniform.toFixed(2)} if spread evenly)`);
  if (shotDir) await page.screenshot({ path: `${shotDir}/membrane-desk.png` });

  // presets: square drum has the √(5/2) ratio
  await page.click('[data-preset="square"]');
  await page.waitForFunction(() => window.__membrane.drum.name === 'square');
  const sq = await M(page, () => window.__membrane.freqs[1] / window.__membrane.freqs[0]);
  assert.ok(Math.abs(sq - Math.sqrt(2.5)) < 0.01, `square ratio ${sq}`);
  assert.match(page.url(), /#p=square&f=0\.5/);
  console.log(`✓ square preset: second mode at ${sq.toFixed(4)}× (theory √(5/2) = 1.5811)`);

  // frame size: double the frame, halve the pitch
  const f0 = await M(page, () => window.__membrane.freqs[0]);
  await page.fill('#sizeIn', '1'); await page.dispatchEvent('#sizeIn', 'input');
  assert.ok(Math.abs((await M(page, () => window.__membrane.freqs[0])) - f0 / 2) < 1e-6);
  console.log('✓ doubling the frame halves the pitch');

  // freehand drawing → new drum → share link round-trip
  const before = await M(page, () => window.__membrane.solves);
  await page.click('#drawBtn');
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
  await page.mouse.move(cx + box.width * 0.3, cy);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2, rr = box.width * (0.3 + 0.08 * Math.sin(3 * a));
    await page.mouse.move(cx + rr * Math.cos(a), cy + rr * Math.sin(a) * 0.8);
  }
  await page.mouse.up();
  await page.waitForFunction((b) => window.__membrane.solves > b && window.__membrane.drum.name === 'custom', before, { timeout: 20000 });
  assert.match(page.url(), /#s=[A-Za-z0-9_-]+&f=1/);
  const mine = await M(page, () => Array.from(window.__membrane.drum.lambdas));
  const p2 = await browser.newPage();
  await p2.goto(page.url());
  await p2.waitForFunction(() => window.__membrane?.drum?.name === 'custom', null, { timeout: 30000 });
  const theirs = await p2.evaluate(() => Array.from(window.__membrane.drum.lambdas));
  theirs.forEach((l, i) => assert.ok(Math.abs(l - mine[i]) / mine[i] < 1e-3, 'shared drum has the same spectrum'));
  await p2.close();
  console.log('✓ freehand drawing becomes a drum, and its share link reproduces the spectrum');

  // ear test
  await page.waitForFunction(() => window.__membrane.ear.ready, null, { timeout: 30000 });
  await page.click('#earPlay');
  const ans = await M(page, () => window.__membrane.ear.answer);
  await page.click(`.opt[data-o="${ans}"]`);
  assert.equal(await page.textContent('#streak'), 'streak 1');
  await page.click('#earNext');
  await page.waitForFunction(() => window.__membrane.ear.ready);
  const wrong = ((await M(page, () => window.__membrane.ear.answer)) + 1) % 3;
  await page.click(`.opt[data-o="${wrong}"]`);
  assert.equal(await page.textContent('#streak'), 'streak 0');
  assert.equal(await page.locator('.opt.right').count(), 1);
  console.log('✓ ear test: right answer extends the streak, wrong one resets it');
  if (shotDir) {
    await page.locator('#ear').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shotDir}/membrane-ear.png` });
    const ph = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await ph.goto(root + '#p=guitar&f=0.5'); await ph.waitForFunction(() => window.__membrane?.drum);
    await ph.click('.mode[data-k="6"]'); await ph.waitForTimeout(3000);
    await ph.screenshot({ path: `${shotDir}/membrane-phone.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('✓ no console errors');
} catch (e) { failed = true; console.error(e); }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
