// Drives the real UI path: toolbar action → picker overlay → hover → click → result tab.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'extension');
const OUT = path.join(root, 'test/out/picker');
await fs.mkdir(OUT, { recursive: true });
const profile = path.join(root, 'test/.profile-picker');
await fs.rm(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
await page.goto(process.argv[2] || 'https://tailwindcss.com', { waitUntil: 'load' });
await page.waitForTimeout(1200);

// what clicking the toolbar icon does
await sw.evaluate(async (url) => { const [tab] = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url)); await chrome.tabs.update(tab.id, { active: true }); await startPicker(tab); }, page.url());
await page.waitForTimeout(300);
const [x, y] = (process.argv[3] || '640,520').split(',').map(Number);
await page.mouse.move(x - 40, y - 40);
await page.mouse.move(x, y, { steps: 5 });
await page.keyboard.press('ArrowUp');           // walk up one level
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(OUT, 'hover.png') });
const hasOverlay = await page.evaluate(() => !!document.querySelector('snag-ui-overlay'));
const resultPage = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('result.html'), timeout: 60000 });
await page.mouse.click(x, y);
const rp = await resultPage;
await rp.waitForSelector('body[data-ready]', { timeout: 30000 });
await rp.setViewportSize({ width: 1440, height: 1000 });
await rp.waitForTimeout(300);
await rp.screenshot({ path: path.join(OUT, 'result.png') });
const label = await rp.textContent('#label');
const overlayGone = await page.waitForFunction(() => !document.querySelector('snag-ui-overlay'), null, { timeout: 5000 }).then(() => true, () => false);
console.log({ hasOverlay, picked: label, overlayCleanedUp: overlayGone });
await ctx.close();
