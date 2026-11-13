// Debug helper: run a capture in-page, keep the rebuild iframe, and diff ALL computed properties
// for the given element indices (pre-order index, as shown in patch logs).
//   node test/debug-diff.mjs <url> "<root selector>" 18,19,20
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [url, sel, idx] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(1500);
for (const f of ['extension/shared/base.js', 'extension/content/extract.js']) await p.evaluate(await fs.readFile(f, 'utf8'));
console.log(await p.evaluate(async ({ sel, idx }) => {
  await globalThis.__snagExtract.capture(document.querySelector(sel), { fetchCss: async (u) => (await fetch(u)).text(), debugKeep: true });
  const { env, recs } = globalThis.__snagDebug;
  const out = [];
  for (const i of idx.split(',').map(Number)) {
    const rec = recs[i];
    const o = getComputedStyle(rec.el), c = env.W.getComputedStyle(rec.clone);
    const ro = rec.el.getBoundingClientRect(), rc = rec.clone.getBoundingClientRect();
    out.push(`#${i} <${rec.tag}> orig ${ro.width.toFixed(2)}x${ro.height.toFixed(2)}  clone ${rc.width.toFixed(2)}x${rc.height.toFixed(2)}`);
    for (let k = 0; k < o.length; k++) {
      const prop = o[k];
      if (prop.startsWith('--')) continue;
      const a = o.getPropertyValue(prop), bb = c.getPropertyValue(prop);
      if (a !== bb) out.push(`    ${prop}: ${a.slice(0, 70)}  ≠  ${bb.slice(0, 70)}`);
    }
  }
  return out.join('\n');
}, { sel, idx }));
await b.close();
