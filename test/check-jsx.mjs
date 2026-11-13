// Compiles every generated .jsx under test/out with esbuild (syntax + JSX validity).
import { transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'out');
let ok = 0, bad = 0;
for (const target of await fs.readdir(OUT)) {
  for (const kind of ['tailwind', 'module']) {
    const dir = path.join(OUT, target, kind);
    let files = [];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsx')); } catch { continue; }
    for (const f of files) {
      try { await transform(await fs.readFile(path.join(dir, f), 'utf8'), { loader: 'jsx', jsx: 'automatic' }); ok++; }
      catch (e) { bad++; console.log(`✗ ${target}/${kind}/${f}\n   ${e.errors?.[0]?.text} @ line ${e.errors?.[0]?.location?.line}: ${e.errors?.[0]?.location?.lineText?.slice(0, 160)}`); }
    }
  }
}
console.log(`${ok} JSX files compile, ${bad} failed`);
process.exit(bad ? 1 : 0);
