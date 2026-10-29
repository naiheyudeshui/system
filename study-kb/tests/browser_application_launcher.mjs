// Optional real-browser regression. Use an isolated Study server and database.
// Install Playwright in a separate tools directory, then set NODE_PATH to its
// node_modules before running this script. No changes to production dependencies.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.WB_DOCK_TEST_URL || "http://127.0.0.1:18034";
if (new URL(base).port !== "18034") throw new Error("Use isolated Dock test server on 18034, never the user's 8033 database");
const directory = process.env.WB_DOCK_ARTIFACTS || join(tmpdir(), "workbench-dock-browser");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const failures = [], errors = [], measurements = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("favicon.ico")) failures.push(`${response.status()} ${response.url()}`); });
try {
  await page.goto(base);
  await page.locator("#load-state").waitFor({ state: "hidden" });
  const app = page.locator(".app-launcher-button");
  const menu = page.locator(".wb-launcher-panel");
  const originalCount = await page.locator(".wb-bsp-dock-item").count();
  assert.ok(originalCount > 0);
  assert.equal(await page.locator(".brand-block").count(), 0);
  await app.click();
  assert.equal(await page.locator(".wb-launcher-result").count(), originalCount);
  const firstId = await page.locator(".wb-launcher-result").first().getAttribute("data-plugin-id");
  await page.locator(`.wb-launcher-pin[data-application-id="${firstId}"]`).click();
  assert.equal(await page.locator(".wb-bsp-dock-item").count(), originalCount - 1);
  assert.equal(await page.locator(".wb-launcher-result").count(), originalCount);
  await page.locator(`.wb-launcher-pin[data-application-id="${firstId}"]`).click();
  await page.locator(".wb-launcher-panel-search").fill("番茄");
  assert.equal(await page.locator(".wb-launcher-result").count(), 1);
  assert.equal(await page.locator(".wb-launcher-result").getAttribute("data-plugin-id"), "study.pomodoro");
  await page.locator(".wb-launcher-panel-search").press("Escape");
  assert.equal(await menu.isVisible(), false);
  await page.locator(".wb-launcher-search").click();
  assert.equal(await page.locator(".wb-launcher-panel").count(), 1);
  await page.locator(".wb-launcher-search").fill("表格");
  assert.ok(await page.locator(".wb-launcher-result").count() >= 2);
  await page.locator(".wb-launcher-search").press("Escape");
  assert.equal(await menu.isVisible(), false);
  await page.reload();
  await page.locator("#load-state").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".wb-bsp-dock-item").count(), originalCount);
  const layoutBeforeFocus = await (await page.request.get(`${base}/api/plugin/layout`)).json();
  const paneCount = await page.locator(".wb-bsp-leaf").count();
  await page.locator('.wb-bsp-dock-item[data-plugin-id="study.pomodoro"]').click();
  await page.waitForFunction(() => document.activeElement?.matches('.wb-bsp-leaf[data-plugin-id="study.pomodoro"]'));
  assert.equal(await page.locator(".wb-bsp-leaf").count(), paneCount);
  const layoutAfterFocus = await (await page.request.get(`${base}/api/plugin/layout`)).json();
  assert.deepEqual(layoutAfterFocus, layoutBeforeFocus, "focusing a running app never writes the stored layout");
  // Test drag sorting, unpinning and repinning with the actual host gesture adapter.
  const pins = page.locator(".wb-bsp-dock-item");
  const firstPin = await pins.nth(0).getAttribute("data-plugin-id");
  const secondPin = await pins.nth(1).getAttribute("data-plugin-id");
  await pins.nth(1).dragTo(pins.nth(0));
  assert.equal(await pins.nth(0).getAttribute("data-plugin-id"), secondPin);
  await pins.nth(0).dragTo(app);
  assert.equal(await pins.count(), originalCount - 1);
  await app.click();
  await page.locator(`.wb-launcher-result[data-plugin-id="${secondPin}"]`).dragTo(page.locator(".wb-launcher-pins"));
  assert.equal(await pins.count(), originalCount);
  await app.click();
  if (await menu.isVisible()) await page.locator(".wb-launcher-panel-search").press("Escape");
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator(".wb-application-launcher").waitFor();
      const size = await page.evaluate(() => {
        const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
        return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, header: rect(".topbar"), launcher: rect(".wb-application-launcher"), tools: rect(".toolbar"), pins: rect(".wb-launcher-pins"), refresh: rect("#refresh"), app: rect(".app-launcher-button") };
      });
      measurements.push({ width, theme, ...size });
      assert.ok(size.scroll <= width, `body overflow at ${width}: ${size.scroll}`);
      assert.ok(size.refresh.right <= width, `refresh clipped at ${width}`);
      assert.ok(size.pins.width >= 28, `no shortcut area at ${width}`);
      assert.ok(Math.abs((size.launcher.top + size.launcher.bottom) / 2 - (size.tools.top + size.tools.bottom) / 2) <= 2, `header wraps at ${width}`);
      await page.screenshot({ path: join(directory, `dock-${width}-${theme}.png`) });
      await app.click();
      await page.locator(".wb-launcher-panel-search").fill("番茄");
      assert.equal(await page.locator(".wb-launcher-result").count(), 1);
      await page.screenshot({ path: join(directory, `search-${width}-${theme}.png`) });
      await page.locator(".wb-launcher-panel-search").press("Escape");
    }
  }
  // Locale changes update the shared component without removing the catalog.
  await page.locator(".language-button").click();
  await page.locator('.language-menu [data-locale="en"]').click();
  assert.equal(await app.getAttribute("aria-label"), "All apps");
  await page.locator(".wb-launcher-compact-search").click();
  assert.equal(await page.locator(".wb-launcher-panel-search").getAttribute("placeholder"), "Search apps…");
  assert.equal(await page.locator(".wb-launcher-result").count(), 1, "query survives locale change");
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, originalCount, firstPin, secondPin, directory, viewports: measurements.map(({width,theme,scroll}) => ({width,theme,scroll})), errors, failures }, null, 2));
} finally {
  await writeFile(join(directory, "measurements.json"), JSON.stringify({ measurements, errors, failures }, null, 2));
  await browser.close();
}
