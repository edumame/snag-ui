// End-to-end harness: loads the unpacked extension in Chromium, snags elements, and writes
// the generated code + original/rebuilt screenshots to test/out/<name>/.
//
//   npm test                                   # fixture page (nav, cards, pricing)
//   npm test -- --url https://example.com --sel "main > div" --name example
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'extension');
const FIX = path.join(root, 'test/fixtures');
const OUT = path.join(root, 'test/out');
const PAGE_PORT = 4817, CSS_PORT = 4818;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const fixture = `http://127.0.0.1:${PAGE_PORT}/`;
const FIXTURE_TARGETS = [
  { name: 'nav', url: fixture, sel: '#nav' },
  { name: 'cards', url: fixture, sel: '#cards' },
  { name: 'pricing', url: fixture, sel: '#pricing' },
];
let targets = FIXTURE_TARGETS;
if (arg('url')) targets = [{ name: arg('name') || 'custom', url: arg('url'), sel: arg('sel') || 'body > *', wait: arg('wait') }];
// --suite test/sites.json  → fixture targets + every site in the file
if (arg('suite')) targets = [...FIXTURE_TARGETS, ...JSON.parse(await fs.readFile(arg('suite'), 'utf8'))];

const serve = (port, extraHeaders = {}) => new Promise((resolve) => {
  const s = http.createServer(async (req, res) => {
    const f = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1).split('?')[0]);
    try {
      let body = await fs.readFile(path.join(FIX, f));
      if (f.endsWith('.html')) body = body.toString().replaceAll('__CSS_PORT__', String(CSS_PORT));
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...extraHeaders });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  }).listen(port, '127.0.0.1', () => resolve(s));
});

const servers = [await serve(PAGE_PORT), await serve(CSS_PORT)];
const profile = path.join(root, 'test/.profile');
await fs.rm(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: arg('headed') == null,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

let failures = 0;
for (const t of targets) {
  try { await runTarget(t); } catch (err) { console.log(`✗ ${t.name}: ${err.message.split('\n')[0]}`); failures++; }
}

async function runTarget(t) {
  const dir = path.join(OUT, t.name);
  await fs.mkdir(dir, { recursive: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('[snag]')) console.log(`  [page] ${m.text().slice(0, 200)}`); });
  await page.goto(t.url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(Number(t.wait || arg('wait') || 800));
  const el = page.locator(t.sel).first();
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: path.join(dir, 'original.png') });

  const resultPage = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('result.html'), timeout: 120000 });
  const res = await sw.evaluate(async ({ url, sel }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((x) => x.url === url) || tabs.find((x) => x.url?.startsWith(url));
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared/base.js', 'content/extract.js', 'content/picker.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (s) => globalThis.__snagPicker.snagSelector(s), args: [sel] });
    return r.result;
  }, { url: page.url(), sel: t.sel });
  if (!res || res.error) throw new Error(res?.error || 'no result');

  const rp = await resultPage;
  await rp.waitForSelector('body[data-ready]', { timeout: 30000 });
  const { output, model } = await rp.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('id');
    const rec = (await chrome.storage.local.get(`snag:${id}`))[`snag:${id}`];
    return { output: window.__snagOutput, model: rec.model };
  });
  for (const [kind, files] of Object.entries({ tailwind: output.tailwind, module: output.module, html: output.html })) {
    await fs.mkdir(path.join(dir, kind), { recursive: true });
    for (const f of files) await fs.writeFile(path.join(dir, kind, f.name), f.code);
  }
  await fs.writeFile(path.join(dir, 'model.json'), JSON.stringify(model, null, 2));
  await fs.writeFile(path.join(dir, 'preview.html'), output.previewDoc);
  await rp.setViewportSize({ width: 1440, height: 1000 });
  await rp.screenshot({ path: path.join(dir, 'result-page.png') });

  // Render the generated HTML+CSS on its own and screenshot it for an apples-to-apples compare.
  const pv = await ctx.newPage();
  await pv.setContent(output.previewDoc, { waitUntil: 'load' });
  await pv.waitForTimeout(300);
  await pv.locator('.snag-wrap > *').first().screenshot({ path: path.join(dir, 'rebuilt.png') });
  await pv.close();

  // Same markup with the generated Tailwind classes, compiled by the real Tailwind v4 compiler.
  const tp = await ctx.newPage();
  const extra = [...(model.keyframes || []), ...(model.previewFontFaces || model.fontFaces || [])].join('\n');
  await tp.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${extra}\nhtml,body{margin:0;background:${model.background}}.snag-wrap{width:${model.width}px;display:flow-root}</style></head><body><div class="snag-wrap">${output.tailwindHtml}</div></body></html>`);
  await tp.addScriptTag({ path: path.join(root, 'node_modules/@tailwindcss/browser/dist/index.global.js') });
  await tp.waitForTimeout(700);
  await tp.locator('.snag-wrap > *').first().screenshot({ path: path.join(dir, 'rebuilt-tailwind.png') });
  await tp.close();
  const diff = await imageDiff(ctx, path.join(dir, 'rebuilt.png'), path.join(dir, 'rebuilt-tailwind.png'));
  const diffOrig = await imageDiff(ctx, path.join(dir, 'original.png'), path.join(dir, 'rebuilt.png'));

  const s = model.stats;
  const twBytes = output.tailwind.reduce((a, f) => a + f.code.length, 0);
  console.log(`✓ ${t.name}: ${s.elements} els · rules ${s.rulesMatched}/${s.rulesOnPage} · patched ${s.patched} · pruned ${s.pruned} · pinned ${s.pinned} · layout ${s.fidelity}% · ${s.ms}ms · ${s.origBytes}B → ${twBytes}B tailwind`);
  console.log(`    pixels: original vs rebuilt ${diffOrig} · css vs tailwind ${diff}`);
  for (const w of s.warnings) console.log(`    ! ${w}`);
  await page.close();
  await rp.close();
}

await ctx.close();
servers.forEach((s) => s.close());
process.exit(failures ? 1 : 0);

/** Share of pixels that differ noticeably between two PNGs (or a size note). */
async function imageDiff(context, a, b) {
  const page = await context.newPage();
  const [da, db] = await Promise.all([a, b].map(async (f) => `data:image/png;base64,${(await fs.readFile(f)).toString('base64')}`));
  const res = await page.evaluate(async ([da, db]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(da), load(db)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(ia), pb = px(ib);
    let bad = 0;
    for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 60) bad++;
    const size = ia.width === ib.width && ia.height === ib.height ? '' : ` (sizes ${ia.width}x${ia.height} vs ${ib.width}x${ib.height})`;
    return `${((bad / (w * h)) * 100).toFixed(2)}%${size}`;
  }, [da, db]);
  await page.close();
  return res;
}
