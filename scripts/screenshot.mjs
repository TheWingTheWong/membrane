// Takes the README screenshot (docs/screenshot.png) with Playwright: `node scripts/screenshot.mjs`
import { createRequire } from "node:module";
import { startServer } from "../serve.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const out = new URL("../docs/screenshot.png", import.meta.url).pathname;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.waitForFunction(() => window.__membrane?.freqs?.length > 0, null, { timeout: 30000 });
  await page.getByRole("button", { name: "Square", exact: true }).click();
  await page.waitForFunction(() => window.__membrane.solves >= 2, null, { timeout: 30000 });
  await page.locator(".mode").nth(7).click();
  await page.waitForTimeout(12000); // sand settles on the nodal lines
  await page.screenshot({ path: out });
  console.log("wrote", out);
} finally { await browser.close(); server.close(); }
