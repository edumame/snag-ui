// Debug helper: which page rules match an element, as seen by the extractor.
//   node test/debug-match.mjs <url> "<css selector>"
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [url, sel] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(1200);
for (const f of ['extension/shared/base.js', 'extension/content/extract.js']) await p.evaluate(await fs.readFile(f, 'utf8'));
console.log(await p.evaluate(async (sel) => {
  const el = document.querySelector(sel);
  const { buildDb, matchEntries } = globalThis.__snagExtract._internals;
  const db = await buildDb(async (u) => (await fetch(u)).text());
  const m = matchEntries(el, db);
  const lines = [`class="${el.getAttribute('class')}"`, `matched ${m.length}`];
  for (const e of m) lines.push(`  ${e.state || e.pe || 'base'} L${e.layer} [${e.spec}] ${e.sel.slice(0, 90)} { ${e.rule.decls.map(d => d.prop + ':' + d.raw).join('; ').slice(0, 120)} }`);
  return lines.join('\n');
}, sel));
await b.close();
