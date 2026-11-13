import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [a, b, out] = process.argv.slice(2);
const br = await chromium.launch({ channel: 'chromium' });
const p = await br.newPage();
const [da, db] = await Promise.all([a, b].map(async (f) => `data:image/png;base64,${(await fs.readFile(f)).toString('base64')}`));
const png = await p.evaluate(async ([da, db]) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const [ia, ib] = await Promise.all([load(da), load(db)]);
  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
  const c = document.createElement('canvas'); c.width = w * 3; c.height = h; const g = c.getContext('2d');
  g.drawImage(ia, 0, 0); g.drawImage(ib, w, 0);
  const A = g.getImageData(0, 0, w, h), B = g.getImageData(w, 0, w, h), D = g.createImageData(w, h);
  const rows = new Array(Math.ceil(h / 50)).fill(0);
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
    const bad = d > 60; if (bad) rows[Math.floor((i / 4 / w) / 50)]++;
    D.data[i] = bad ? 255 : A.data[i] * 0.3 + 170; D.data[i + 1] = bad ? 0 : A.data[i + 1] * 0.3 + 170; D.data[i + 2] = bad ? 0 : A.data[i + 2] * 0.3 + 170; D.data[i + 3] = 255;
  }
  g.putImageData(D, w * 2, 0);
  console.log(rows.map((r, i) => `${i * 50}:${r}`).filter((x) => !x.endsWith(':0')).join(' '));
  return c.toDataURL();
}, [da, db]);
p.on('console', () => {});
await fs.writeFile(out, Buffer.from(png.split(',')[1], 'base64'));
await br.close();
