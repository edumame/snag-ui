// Renders extension/icons/{16,32,48,128}.png from an inline SVG using Playwright's Chromium.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/icons');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f70ff"/><stop offset="1" stop-color="#5730ec"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#g)"/>
  <rect x="24" y="24" width="62" height="62" rx="10" fill="none" stroke="#fff" stroke-width="8" stroke-dasharray="14 10" stroke-linecap="round"/>
  <path d="M60 56 L104 73 L85 80 L96 102 L86 107 L75 85 L60 98 Z" fill="#fff" stroke="#2b1480" stroke-width="4" stroke-linejoin="round"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(dir, `${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons written to', dir);
