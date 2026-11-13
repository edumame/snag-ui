import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
const out = await p.evaluate(() => {
  const res = [];
  const pick = (el, depth) => {
    if (depth > 4) return;
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      if (r.height < 30 || r.width < 100) continue;
      const path = []; let e = c; while (e && e !== document.body) { let s = e.localName; const i = [...e.parentElement.children].filter(x => x.localName === e.localName).indexOf(e); if (e.parentElement.children.length > 1) s += `:nth-of-type(${i+1})`; path.unshift(s); e = e.parentElement; }
      res.push(`${'  '.repeat(depth)}${Math.round(r.top)}px ${Math.round(r.width)}x${Math.round(r.height)} n=${c.querySelectorAll('*').length} body > ${path.join(' > ')}  ${(c.className?.baseVal ?? c.className ?? '').toString().slice(0,50)}`);
      pick(c, depth + 1);
    }
  };
  pick(document.body, 0);
  return res.slice(0, 70).join('\n');
});
console.log(out);
await b.close();
