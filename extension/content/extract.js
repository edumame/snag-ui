/*
 * Snag UI — style extraction. Runs in the page's isolated (content-script) world.
 *
 * Pipeline for a picked element:
 *   1. Index every CSS rule on the page (cross-origin sheets are fetched via the
 *      service worker) by the key of its rightmost compound selector.
 *   2. For each element, run a real cascade (layers, specificity, !important,
 *      inline styles) over the matching rules to get the *authored* declarations
 *      (keeps intent like `width: 100%`, `repeat(3, 1fr)`, hover/::before rules).
 *   3. Rebuild the subtree in a hidden same-origin iframe that contains only a
 *      Tailwind-preflight baseline, apply those declarations, and diff computed
 *      styles against the original:
 *        - verify: patch anything that renders differently (missed rules,
 *          container queries, inherited context like the page font)
 *        - prune:  drop declarations that change nothing (resets, defaults)
 *        - geometry: pin sizes of boxes that still don't match.
 *   4. Emit a plain JSON model; the result page turns it into JSX/Tailwind/CSS.
 */
(() => {
  if (globalThis.__snagExtract) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const COMPUTED = '\u0000computed';
  const MAX_ELEMENTS = 6000;
  const STATES = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active']);
  const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'base', 'title', 'head']);

  // Properties that never make it into the output (noise / browser-specific / context-only).
  const DROP_PROP = /^(will-change|transition-behavior|-webkit-tap-highlight-color|-webkit-text-size-adjust|text-size-adjust|tab-size|-webkit-locale|unicode-bidi|zoom|content-visibility|contain-intrinsic-.*|scroll-.*|overscroll-.*|touch-action|caret-color|print-color-adjust|-webkit-print-color-adjust|color-scheme|forced-color-adjust|interpolate-size|anchor-name|anchor-scope|position-anchor|position-try.*|position-area|position-visibility|view-transition-.*|container-name|font-synthesis.*|font-kerning|font-optical-sizing|text-rendering|-webkit-user-drag|-webkit-rtl-ordering|speak|field-sizing|timeline-scope|animation-timeline|animation-range.*|animation-composition|scroll-timeline.*|view-timeline.*|-webkit-highlight|-webkit-user-modify|-webkit-text-security|text-autospace|text-spacing-trim|reading-flow|reading-order|dynamic-range-limit|font-palette|font-size-adjust|math-.*|ruby-.*|shape-.*|offset-.*|-webkit-mask-box-image.*|-webkit-box-reflect|-webkit-border-.*|-webkit-hyphenate-character|-webkit-column-.*|-webkit-perspective-origin-.*|-webkit-transform-origin-.*|-internal-.*)$/;

  // Properties compared between original and rebuild (computed values).
  const COMPARE = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'box-sizing',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'min-width', 'min-height', 'max-width', 'max-height',
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items',
    'align-self', 'align-content', 'justify-items', 'justify-self', 'order', 'row-gap', 'column-gap',
    'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns',
    'grid-auto-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
    'overflow-x', 'overflow-y', 'visibility', 'opacity',
    'color', 'background-color', 'background-image', 'background-size', 'background-position-x',
    'background-position-y', 'background-repeat', 'background-clip', 'background-origin', 'background-attachment',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'outline-style', 'outline-width', 'outline-color', 'outline-offset',
    'box-shadow', 'filter', 'backdrop-filter', 'mix-blend-mode', 'isolation', 'transform', 'translate', 'rotate',
    'scale', 'clip-path', 'mask-image',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'line-height', 'letter-spacing',
    'word-spacing', 'text-align', 'text-transform', 'text-indent', 'text-shadow',
    'text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness',
    'text-underline-offset', 'white-space-collapse', 'text-wrap-mode', 'text-wrap-style', 'text-overflow',
    'word-break', 'overflow-wrap', 'hyphens', 'vertical-align', 'font-variant-numeric', 'font-variant-caps',
    'font-feature-settings', 'font-variation-settings', '-webkit-font-smoothing', '-webkit-text-fill-color',
    '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-line-clamp', '-webkit-box-orient',
    'list-style-type', 'list-style-position', 'list-style-image',
    'cursor', 'pointer-events', 'user-select', 'object-fit', 'object-position', 'aspect-ratio',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
    'border-collapse', 'border-spacing', 'table-layout', 'appearance', 'column-count', 'column-width',
    'resize', 'accent-color', 'direction', 'writing-mode', 'contain', 'container-type',
  ];
  const SNAP = [...COMPARE, 'width', 'height', 'transition-duration', 'transition-delay', 'animation-name', 'animation-timeline'];
  const PE_COMPARE = [...COMPARE, 'content', 'width', 'height'];

  const INHERITED = new Set([
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'line-height', 'letter-spacing',
    'word-spacing', 'text-align', 'text-transform', 'text-indent', 'text-shadow', 'white-space-collapse',
    'text-wrap-mode', 'text-wrap-style', 'white-space', 'word-break', 'overflow-wrap', 'hyphens',
    'font-variant-numeric', 'font-variant-caps', 'font-feature-settings', 'font-variation-settings',
    '-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
    'list-style-type', 'list-style-position', 'list-style-image', 'cursor', 'pointer-events', 'visibility',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'border-collapse',
    'border-spacing', 'caption-side', 'direction', 'writing-mode', 'accent-color', 'quotes',
  ]);
  // Properties whose getComputedStyle() value depends on layout (testing them forces a reflow).
  const GEOM = new Set([
    'width', 'height', 'top', 'right', 'bottom', 'left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'transform-origin', 'perspective-origin',
    'grid-template-columns', 'grid-template-rows',
  ]);
  const NEUTRAL = /^(auto|0|0px|0%|0em|0rem|none|normal|initial|unset|inherit|100%|fit-content|max-content|min-content)$/;
  const MOTION = /^(transition|animation)-/;
  const ZERO = /^-?0(\.0+)?(px|em|rem|%|vh|vw)?$/;

  // ---------------------------------------------------------------- string helpers

  function matchParen(s, open) {
    let depth = 0, q = null;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i;
    }
    return -1;
  }

  function splitTop(s, sep) {
    const out = [];
    let depth = 0, q = null, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out.map((x) => x.trim()).filter(Boolean);
  }

  function readIdent(s, i) {
    let name = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const hex = /^[0-9a-fA-F]{1,6}[ \t\n]?/.exec(s.slice(i + 1, i + 9));
        if (hex) { name += String.fromCodePoint(parseInt(hex[0], 16)); i += 1 + hex[0].length; }
        else { name += s[i + 1] ?? ''; i += 2; }
        continue;
      }
      if (/[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) > 127) { name += c; i++; continue; }
      break;
    }
    return [name, i];
  }

  function skipBracket(s, i) {
    let q = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ']') return i + 1;
    }
    return s.length;
  }

  const cmp3 = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  function maxSpec(list) {
    let best = [0, 0, 0];
    for (const s of splitTop(list || '', ',')) {
      const sp = specificity(s);
      if (cmp3(sp, best) > 0) best = sp;
    }
    return best;
  }

  function specificity(sel) {
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < sel.length;) {
      const ch = sel[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '#') { a++; i = readIdent(sel, i + 1)[1]; continue; }
      if (ch === '.') { b++; i = readIdent(sel, i + 1)[1]; continue; }
      if (ch === '[') { b++; i = skipBracket(sel, i); continue; }
      if (ch === ':') {
        if (sel[i + 1] === ':') {
          c++;
          let j = readIdent(sel, i + 2)[1];
          if (sel[j] === '(') j = matchParen(sel, j) + 1;
          i = j; continue;
        }
        let [n, j] = readIdent(sel, i + 1);
        n = n.toLowerCase();
        let args = null;
        if (sel[j] === '(') { const e = matchParen(sel, j); args = sel.slice(j + 1, e); j = e + 1; }
        if (n === 'where') { /* zero */ }
        else if (n === 'is' || n === 'not' || n === 'has' || n === 'matches' || n === '-webkit-any') {
          const m = maxSpec(args); a += m[0]; b += m[1]; c += m[2];
        } else if ((n === 'nth-child' || n === 'nth-last-child') && args && /\sof\s/i.test(args)) {
          b++; const m = maxSpec(args.split(/\sof\s/i)[1]); a += m[0]; b += m[1]; c += m[2];
        } else if (n === 'before' || n === 'after' || n === 'first-line' || n === 'first-letter') c++;
        else b++;
        i = j; continue;
      }
      if (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127) { c++; i = readIdent(sel, i)[1]; continue; }
      i++;
    }
    return [a, b, c];
  }

  /** Index where the rightmost compound selector starts. */
  function lastCompoundStart(s) {
    let depth = 0, q = null, start = 0, inComb = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      const comb = depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~' || c === '\n' || c === '\t');
      if (comb) { inComb = true; continue; }
      if (inComb) { start = i; inComb = false; }
      if (c === '\\') { i++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
    }
    return start;
  }

  /** Remove top-level `:name` pseudo-classes from a compound for which pred(name) is true. */
  function stripPseudo(comp, pred) {
    let out = '', depth = 0;
    for (let i = 0; i < comp.length; i++) {
      const c = comp[i];
      if (c === '\\') { out += c + (comp[i + 1] ?? ''); i++; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (depth === 0 && c === ':' && comp[i + 1] !== ':' && comp[i - 1] !== ':') {
        const [n, j] = readIdent(comp, i + 1);
        if (comp[j] !== '(' && pred(n.toLowerCase())) { i = j - 1; continue; }
      }
      out += c;
    }
    return out;
  }

  function topLevelOnly(comp) {
    let out = '', depth = 0;
    for (let i = 0; i < comp.length; i++) {
      const c = comp[i];
      if (c === '\\') { i++; continue; }
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if (depth === 0) out += c;
    }
    return out;
  }

  function compoundKey(comp) {
    let depth = 0, cls = null, id = null;
    for (let i = 0; i < comp.length; i++) {
      const c = comp[i];
      if (c === '\\') { i++; continue; }
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if (depth === 0 && (c === '.' || c === '#')) {
        const [name, j] = readIdent(comp, i + 1);
        if (name) { if (c === '#' && !id) id = name; if (c === '.' && !cls) cls = name; }
        i = j - 1;
      }
    }
    if (id) return ['id', id];
    if (cls) return ['class', cls];
    const m = /^([A-Za-z][\w-]*)/.exec(comp);
    return m ? ['tag', m[1].toLowerCase()] : ['*'];
  }

  /** Split a complex selector into {sel to match now, pseudo-element, interactive state, index key}. */
  function analyzeSelector(s) {
    const ls = lastCompoundStart(s);
    const head = s.slice(0, ls);
    let last = s.slice(ls);
    let pe = null;
    const m = /::?(before|after)$/i.exec(last);
    if (m) { pe = m[1].toLowerCase(); last = last.slice(0, m.index); }
    else if (/::|:(first-line|first-letter)\b/i.test(topLevelOnly(last))) return null;
    let state = null, bad = false;
    last = stripPseudo(last, (n) => {
      if (!STATES.has(n)) return false;
      if (state && state !== n) bad = true;
      state = n; return true;
    });
    if (bad || (pe && state)) return null;
    if (state && /:(hover|focus|focus-visible|focus-within|active)(?![\w-])/.test(topLevelOnly(head))) return null;
    if (!last.trim() || /[\s>+~]$/.test(last)) last += '*';
    return { sel: head + last, pe, state, key: compoundKey(last) };
  }

  function nestSelector(child, parent) {
    const single = !/[,\s>+~]/.test(topLevelOnly(parent).trim());
    const P = single ? parent : `:is(${parent})`;
    return splitTop(child, ',').map((c) => (c.includes('&') ? c.replace(/&/g, P) : `${P} ${c}`)).join(', ');
  }

  function absolutizeCssUrls(text, base) {
    if (!base || !/url\(/i.test(text)) return text;
    return text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, q, u) => {
      if (!u || /^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(u)) return all;
      try { return `url("${new URL(u, base).href}")`; } catch { return all; }
    });
  }

  function resolveVars(value, lookup, depth = 0) {
    if (depth > 24) return null;
    let out = '', i = 0;
    for (;;) {
      const k = value.toLowerCase().indexOf('var(', i);
      if (k < 0) { out += value.slice(i); break; }
      out += value.slice(i, k);
      const end = matchParen(value, k + 3);
      if (end < 0) return null;
      const inner = value.slice(k + 4, end);
      const comma = inner.indexOf(',');
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      let v = (lookup(name) || '').trim();
      if (v && /var\(/i.test(v)) v = resolveVars(v, lookup, depth + 1) ?? '';
      if (!v) {
        if (comma < 0) return null;
        v = resolveVars(inner.slice(comma + 1).trim(), lookup, depth + 1);
        if (v == null) return null;
      }
      out += v;
      i = end + 1;
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ---------------------------------------------------------------- rule database

  const scratch = document.createElement('div');
  const validCache = new Map();
  function validSelector(sel) {
    let v = validCache.get(sel);
    if (v === undefined) {
      try { scratch.matches(sel); v = true; } catch { v = false; }
      validCache.set(sel, v);
    }
    return v;
  }

  function parseRawDecls(text) {
    const out = [];
    for (const part of splitTop(text, ';')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      let prop = part.slice(0, i).trim();
      let raw = part.slice(i + 1).trim();
      const custom = prop.startsWith('--');
      if (!custom) prop = prop.toLowerCase();
      let imp = false;
      const m = /!\s*important\s*$/i.exec(raw);
      if (m) { imp = true; raw = raw.slice(0, m.index).trim(); }
      out.push({
        prop, raw, imp, custom,
        hasVar: /var\(/i.test(raw),
        hasUrl: /url\(/i.test(raw),
        computed: !custom && (/^(revert|revert-layer)$/i.test(raw) || /\b(env|attr|anchor|anchor-size)\(/i.test(raw)),
      });
    }
    return out;
  }

  async function buildDb(fetchCss) {
    const db = {
      byId: new Map(), byClass: new Map(), byTag: new Map(), universal: [],
      fontFaces: [], keyframes: new Map(), layers: new Map(), ruleCount: 0, errors: [],
    };
    let order = 0;
    const layerIdx = (name) => {
      if (!db.layers.has(name)) db.layers.set(name, db.layers.size);
      return db.layers.get(name);
    };
    const join = (a, b) => (a ? `${a}.${b}` : b);
    const has = (name) => typeof globalThis[name] === 'function';

    const push = (map, k, e) => { const a = map.get(k); if (a) a.push(e); else map.set(k, [e]); };

    function addStyle(selText, style, ctx) {
      const text = style.cssText;
      if (!text) return;
      const rule = { decls: parseRawDecls(text), base: ctx.base, len: text.length + selText.length };
      const ord = order++;
      db.ruleCount++;
      const layer = ctx.layer ? layerIdx(ctx.layer) : -1;
      for (const s of splitTop(selText, ',')) {
        const an = analyzeSelector(s);
        if (!an || !validSelector(an.sel)) continue;
        const e = { sel: an.sel, spec: specificity(s), order: ord, layer, rule, pe: an.pe, state: an.state };
        const [kind, key] = an.key;
        if (kind === 'id') push(db.byId, key, e);
        else if (kind === 'class') push(db.byClass, key, e);
        else if (kind === 'tag') push(db.byTag, key, e);
        else db.universal.push(e);
      }
    }

    async function rulesOf(sheet) {
      try { return sheet.cssRules; } catch { /* cross-origin */ }
      if (!sheet.href || !fetchCss) return null;
      try {
        let text = await fetchCss(sheet.href);
        text = await inlineImports(absolutizeCssUrls(text, sheet.href), sheet.href, 0);
        const s = new CSSStyleSheet();
        s.replaceSync(text);
        return s.cssRules;
      } catch (err) {
        db.errors.push(`${sheet.href}: ${err?.message || err}`);
        return null;
      }
    }

    async function inlineImports(text, href, depth) {
      if (depth > 3 || !/@import/i.test(text)) return text;
      const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;
      let out = '', last = 0, m;
      while ((m = re.exec(text))) {
        out += text.slice(last, m.index);
        last = re.lastIndex;
        try {
          const url = new URL(m[2], href).href;
          let sub = await fetchCss(url);
          sub = await inlineImports(absolutizeCssUrls(sub, url), url, depth + 1);
          const cond = m[3].replace(/layer(\([^)]*\))?|supports\([^)]*\)/gi, '').trim();
          out += cond ? `@media ${cond} {\n${sub}\n}` : sub;
        } catch { /* skip */ }
      }
      return out + text.slice(last);
    }

    async function walkSheet(sheet, ctx) {
      if (!sheet || sheet.disabled) return;
      const media = sheet.media?.mediaText;
      if (media && !matchMedia(media).matches) return;
      const rules = await rulesOf(sheet);
      if (rules) await walk(rules, { ...ctx, base: sheet.href || document.baseURI, parent: null });
    }

    async function walk(rules, ctx) {
      for (const r of rules) {
        const T = r.constructor.name;
        if (r instanceof CSSStyleRule) {
          const sel = ctx.parent ? nestSelector(r.selectorText, ctx.parent) : r.selectorText;
          addStyle(sel, r.style, ctx);
          if (r.cssRules && r.cssRules.length) await walk(r.cssRules, { ...ctx, parent: sel });
        } else if (T === 'CSSNestedDeclarations') {
          if (ctx.parent) addStyle(ctx.parent, r.style, ctx);
        } else if (r instanceof CSSMediaRule) {
          if (matchMedia(r.media.mediaText).matches) await walk(r.cssRules, ctx);
        } else if (r instanceof CSSSupportsRule) {
          let ok = true;
          try { ok = CSS.supports(r.conditionText); } catch { /* ignore */ }
          if (ok) await walk(r.cssRules, ctx);
        } else if (r instanceof CSSImportRule) {
          if (r.media?.mediaText && !matchMedia(r.media.mediaText).matches) continue;
          const L = r.layerName != null ? join(ctx.layer, r.layerName || `anon${order}`) : ctx.layer;
          if (L) layerIdx(L);
          if (r.styleSheet) await walkSheet(r.styleSheet, { ...ctx, layer: L });
        } else if (has('CSSLayerBlockRule') && r instanceof CSSLayerBlockRule) {
          const L = join(ctx.layer, r.name || `anon${order++}`);
          layerIdx(L);
          await walk(r.cssRules, { ...ctx, layer: L });
        } else if (has('CSSLayerStatementRule') && r instanceof CSSLayerStatementRule) {
          for (const n of r.nameList) layerIdx(join(ctx.layer, n));
        } else if (r instanceof CSSFontFaceRule) {
          const fam = r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
          db.fontFaces.push({ family: fam, css: absolutizeCssUrls(r.cssText, ctx.base) });
        } else if (r instanceof CSSKeyframesRule) {
          db.keyframes.set(r.name, absolutizeCssUrls(r.cssText, ctx.base));
        } else if (T === 'CSSStartingStyleRule') {
          // entry-animation start values: not the resting style
        } else if (r.cssRules) {
          // @container, @scope, @document… — included; the verify pass corrects mismatches
          await walk(r.cssRules, ctx);
        }
      }
    }

    const sheets = [...document.styleSheets];
    for (const sheet of sheets) await walkSheet(sheet, { layer: '' });
    try {
      for (const sheet of document.adoptedStyleSheets || []) await walkSheet(sheet, { layer: '' });
    } catch { /* ignore */ }
    return db;
  }

  // ---------------------------------------------------------------- cascade

  const expandCache = new Map();
  function expand(prop, v) {
    const key = prop + '\u0000' + v;
    let r = expandCache.get(key);
    if (r) return r;
    scratch.style.cssText = '';
    try { scratch.style.setProperty(prop, v); } catch { /* ignore */ }
    r = [];
    for (let i = 0; i < scratch.style.length; i++) {
      const lp = scratch.style[i];
      r.push([lp, scratch.style.getPropertyValue(lp)]);
    }
    expandCache.set(key, r);
    return r;
  }
  const expandComputed = (prop) => expand(prop, 'inherit').map(([lp]) => [lp, COMPUTED]);

  function resolveDecl(d, base, lookup) {
    if (d.computed) return expandComputed(d.prop);
    let v = d.raw;
    if (d.hasVar) {
      v = resolveVars(v, lookup);
      if (v == null) return expandComputed(d.prop);
    }
    if (d.hasUrl) v = absolutizeCssUrls(v, base);
    const r = expand(d.prop, v);
    return r.length ? r : (d.hasVar ? expandComputed(d.prop) : r);
  }

  function prioOf(e, imp) {
    const k = imp ? 'pI' : 'pN';
    if (e[k]) return e[k];
    let lk;
    if (e.inline) lk = 3e9;
    else if (imp) lk = e.layer < 0 ? 0 : 2e9 - e.layer;
    else lk = e.layer < 0 ? 2e9 : e.layer;
    return (e[k] = [imp ? 1 : 0, lk, e.spec[0], e.spec[1], e.spec[2], e.order]);
  }
  function cmpPrio(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  // Logical → physical (horizontal writing mode). Logical and physical longhands share one
  // computed value, so they must compete in the same cascade slot.
  const LOGICAL = (() => {
    const m = {}, ltr = { 'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right' };
    const rtl = { ...ltr, 'inline-start': 'right', 'inline-end': 'left' };
    for (const [dir, map] of [['ltr', ltr], ['rtl', rtl]]) {
      const t = (m[dir] = {});
      for (const [lg, ph] of Object.entries(map)) {
        t[`margin-${lg}`] = `margin-${ph}`;
        t[`padding-${lg}`] = `padding-${ph}`;
        t[`inset-${lg}`] = ph;
        for (const x of ['width', 'style', 'color']) t[`border-${lg}-${x}`] = `border-${ph}-${x}`;
      }
      const [s, e] = dir === 'ltr' ? ['left', 'right'] : ['right', 'left'];
      Object.assign(t, {
        'border-start-start-radius': `border-top-${s}-radius`, 'border-start-end-radius': `border-top-${e}-radius`,
        'border-end-start-radius': `border-bottom-${s}-radius`, 'border-end-end-radius': `border-bottom-${e}-radius`,
        'inline-size': 'width', 'block-size': 'height', 'min-inline-size': 'min-width', 'max-inline-size': 'max-width',
        'min-block-size': 'min-height', 'max-block-size': 'max-height', 'overflow-inline': 'overflow-x', 'overflow-block': 'overflow-y',
        'contain-intrinsic-inline-size': 'contain-intrinsic-width', 'contain-intrinsic-block-size': 'contain-intrinsic-height',
      });
    }
    return m;
  })();

  function cascade(entries, lookup, rtl = false) {
    const win = new Map();
    const phys = LOGICAL[rtl ? 'rtl' : 'ltr'];
    for (const e of entries) {
      for (const d of e.rule.decls) {
        if (d.custom) continue;
        const prio = prioOf(e, d.imp);
        for (const [lp, v] of resolveDecl(d, e.rule.base, lookup)) {
          const p = phys[lp] || lp;
          const cur = win.get(p);
          if (!cur || cmpPrio(prio, cur.prio) >= 0) win.set(p, { v, prio, e });
        }
      }
    }
    return win;
  }

  function customOverrides(list) {
    const vals = new Map(), prios = new Map();
    for (const e of list) {
      for (const d of e.rule.decls) {
        if (!d.custom) continue;
        const prio = prioOf(e, d.imp);
        if (!prios.has(d.prop) || cmpPrio(prio, prios.get(d.prop)) >= 0) { vals.set(d.prop, d.raw); prios.set(d.prop, prio); }
      }
    }
    return vals;
  }

  function matchEntries(el, db) {
    const list = [];
    const add = (arr) => { if (arr) for (const e of arr) list.push(e); };
    if (el.id) add(db.byId.get(el.id));
    for (const c of el.classList) add(db.byClass.get(c));
    add(db.byTag.get(el.localName.toLowerCase()));
    add(db.universal);
    const out = [];
    for (const e of list) {
      try { if (el.matches(e.sel)) out.push(e); } catch { /* ignore */ }
    }
    return out;
  }

  function cascadeRec(rec, db, used) {
    const el = rec.el;
    const matched = matchEntries(el, db);
    const base = [], states = new Map(), pes = { before: [], after: [] };
    for (const e of matched) {
      used.add(e.rule);
      if (e.pe) pes[e.pe].push(e);
      else if (e.state) { const a = states.get(e.state); if (a) a.push(e); else states.set(e.state, [e]); }
      else base.push(e);
    }
    const inlineText = rec.inlineText;
    if (inlineText) {
      base.push({ inline: true, spec: [1, 0, 0], order: Infinity, layer: -1, rule: { decls: parseRawDecls(inlineText), base: document.baseURI } });
    }
    const lookup = (n) => rec.cs.getPropertyValue(n);
    const rtl = rec.o.direction === 'rtl';
    const baseWin = cascade(base, lookup, rtl);
    rec.decls = new Map();
    for (const [p, w] of baseWin) {
      if (DROP_PROP.test(p)) continue;
      const v = w.v === COMPUTED ? rec.cs.getPropertyValue(p) : w.v;
      if (v) rec.decls.set(p, v);
    }

    rec.states = {};
    for (const [st, list] of states) {
      const ov = customOverrides(list);
      const lk = ov.size ? (n) => (ov.has(n) ? ov.get(n) : lookup(n)) : lookup;
      const win = cascade(base.concat(list), lk, rtl);
      const diff = {};
      for (const [p, w] of win) {
        if (DROP_PROP.test(p) || MOTION.test(p) || w.v === COMPUTED || !w.v) continue;
        const b = baseWin.get(p);
        const bv = b ? (b.v === COMPUTED ? rec.cs.getPropertyValue(p) : b.v) : undefined;
        if (w.v !== bv) diff[p] = w.v;
      }
      if (Object.keys(diff).length) rec.states[st] = diff;
    }

    for (const pe of Object.keys(rec.pe)) {
      const P = rec.pe[pe];
      const win = cascade(pes[pe], (n) => P.cs.getPropertyValue(n), rtl);
      const d = new Map();
      for (const [p, w] of win) {
        if (DROP_PROP.test(p) || p === 'content') continue;
        const v = w.v === COMPUTED ? P.cs.getPropertyValue(p) : w.v;
        if (v) d.set(p, v);
      }
      d.set('content', P.o.content);
      P.decls = d;
    }
  }

  // ---------------------------------------------------------------- DOM walk

  const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite', 'action', 'xlink:href']);
  const KEEP_ATTRS = new Set([
    'title', 'role', 'tabindex', 'dir', 'lang', 'alt', 'name', 'type', 'placeholder', 'disabled', 'readonly',
    'required', 'checked', 'selected', 'multiple', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern',
    'rows', 'cols', 'colspan', 'rowspan', 'scope', 'headers', 'target', 'rel', 'download', 'width', 'height',
    'loading', 'decoding', 'sizes', 'srcset', 'src', 'href', 'poster', 'controls', 'muted', 'loop',
    'playsinline', 'autoplay', 'start', 'reversed', 'datetime', 'cite', 'open', 'label', 'value', 'for', 'id',
    'allow', 'allowfullscreen', 'span', 'abbr', 'accept', 'autocomplete', 'inputmode', 'enterkeyhint', 'list',
    'media', 'crossorigin', 'referrerpolicy', 'spellcheck', 'wrap',
  ]);

  function absUrl(u) {
    if (u && /^\s*javascript:/i.test(u)) return '#';
    if (!u || /^(data:|blob:|#|mailto:|tel:)/i.test(u)) return u;
    try { return new URL(u, document.baseURI).href; } catch { return u; }
  }
  const absSrcset = (v) => v.split(',').map((part) => {
    const [u, ...rest] = part.trim().split(/\s+/);
    return [absUrl(u), ...rest].join(' ');
  }).join(', ');

  const IDREF_ARIA = new Set(['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);
  function attrsOf(el, svg, refIds, root) {
    const out = [];
    const tag = el.localName.toLowerCase();
    if (svg) {
      for (const a of el.attributes) {
        const n = a.name;
        if (n === 'class' || n === 'style' || n.startsWith('on') || n.startsWith('data-')) continue;
        let v = a.value;
        if (/var\(/i.test(v)) continue; // resolved values are already in the extracted styles
        if ((n === 'href' || n === 'xlink:href') && !v.startsWith('#')) v = absUrl(v);
        out.push([n, v]);
      }
      return out;
    }
    for (const a of el.attributes) {
      const n = a.name.toLowerCase();
      if (!(n.startsWith('aria-') || KEEP_ATTRS.has(n))) continue;
      let v = a.value;
      if (n === 'id' && !refIds.has(v)) continue;
      if (IDREF_ARIA.has(n)) {
        const ok = v.split(/\s+/).every((id) => {
          const t = document.getElementById(id);
          if (!t || !root.contains(t)) return false;
          const tcs = getComputedStyle(t);
          return tcs.display !== 'none' && tcs.visibility !== 'hidden';
        });
        if (!ok) continue;
      }
      if (n === 'for' && !refIds.has(`#${v}`)) continue;
      if (n === 'value' && (tag === 'input' || tag === 'textarea')) continue;
      if (n === 'checked' || n === 'selected') continue;
      if (n === 'srcset') v = absSrcset(v);
      else if (n === 'src' && (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio' || tag === 'iframe')) v = tag === 'img' ? (el.currentSrc || el.src) : absUrl(v);
      else if (n === 'href') v = absUrl(tag === 'a' || tag === 'area' ? el.href : v);
      else if (URL_ATTRS.has(n)) v = absUrl(v);
      out.push([n, v]);
    }
    if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) out.push(['checked', '']); }
      else if (el.value) out.push(['value', el.value]);
    }
    if (tag === 'option' && el.selected && el.parentElement?.localName === 'select') out.push(['selected', '']);
    return out;
  }

  const UTILITY_CLASS = /^(-?(m|p)[trblxyse]?-|w-|h-|size-|text-|bg-|from-|to-|via-|flex|grid|gap-|items-|justify-|content-|rounded|border|shadow|ring|font-|leading-|tracking-|space-|min-|max-|absolute|relative|fixed|sticky|static|block|inline|hidden|overflow|z-|top-|left-|right-|bottom-|inset|opacity|transition|duration|ease|delay|col-|row-|self-|place-|object-|cursor|select|pointer|sr-only|container|translate|rotate|scale|transform|uppercase|lowercase|capitalize|truncate|underline|italic|antialiased|whitespace|break-|order-|grow|shrink|basis|aspect|fill-|stroke-|outline|backdrop|blur|group|peer|dark|lg|md|sm|xl|2xl|is-|has-|js-)/;
  function hintOf(el) {
    for (const c of el.classList) {
      if (c.length < 3 || c.length > 32) continue;
      if (/[:[\]/!@.#()=]/.test(c)) continue;
      // CSS-module style `Name__hash`: keep the readable part
      const mod = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)_{2,3}([A-Za-z0-9_-]{5,8})$/.exec(c);
      if (mod && (/[A-Z0-9_-]/.test(mod[2]) || /[A-Z]/.test(mod[1])) && !UTILITY_CLASS.test(mod[1])) return mod[1];
      if (/^(css|sc|jsx|svelte|emotion|chakra|mui|Mui|tw|_|astro|ember|ng|v-|x-|framer)-?/i.test(c) && /\d/.test(c)) continue;
      // hashed names (CSS modules, styled-components…): a segment mixing letters and digits
      if (c.split(/[-_]+/).some((seg) => seg.length >= 4 && /\d/.test(seg) && /[a-zA-Z]/.test(seg))) continue;
      if (UTILITY_CLASS.test(c)) continue;
      if (/\d{3,}/.test(c)) continue;
      return c;
    }
    return null;
  }

  function collect(root, exclude, includeHidden) {
    const recs = [];
    const refIds = new Set();
    for (const el of [root, ...root.querySelectorAll('[for],[aria-labelledby],[aria-describedby],[aria-controls],[list],[headers]')]) {
      if (el.hasAttribute?.('for')) refIds.add(`#${el.getAttribute('for')}`);
      for (const a of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'list', 'headers']) {
        const v = el.getAttribute?.(a);
        if (v) for (const id of v.split(/\s+/)) refIds.add(id);
      }
    }
    for (const el of root.querySelectorAll('[id]')) if (refIds.has(`#${el.id}`)) refIds.add(el.id);
    let shadowHosts = 0, hiddenSkipped = 0;

    const visit = (el, parent, depth) => {
      const svg = el instanceof SVGElement;
      const rec = {
        el, i: recs.length, parent, depth, svg, tag: el.localName,
        kids: [], patched: new Set(), skip: new Set(), pe: {},
      };
      recs.push(rec);
      if (recs.length > MAX_ELEMENTS) throw new Error(`Selection is too large (over ${MAX_ELEMENTS} elements). Pick something smaller.`);
      rec.attrs = attrsOf(el, svg, refIds, root);
      if (el.shadowRoot) shadowHosts++;
      const tag = rec.tag.toLowerCase();
      if (tag === 'textarea') { rec.kids.push({ text: el.value }); return rec; }
      if (tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'canvas' || tag === 'select') {
        if (tag !== 'select') return rec;
      }
      for (const ch of el.childNodes) {
        if (ch.nodeType === 3) { rec.kids.push({ text: ch.data }); continue; }
        if (ch.nodeType !== 1 || ch === exclude) continue;
        const t = ch.localName.toLowerCase();
        if (!svg && SKIP_TAGS.has(t)) continue;
        if (!svg && !(ch instanceof SVGElement)) {
          const ccs = getComputedStyle(ch);
          if (ccs.display === 'none') continue;
          // closed menus / popovers: out of flow and invisible, so dropping them can't move anything
          if (!includeHidden && /^(absolute|fixed)$/.test(ccs.position) &&
            (ccs.visibility === 'hidden' || (ccs.opacity === '0' && ccs.pointerEvents === 'none'))) { hiddenSkipped++; continue; }
        }
        rec.kids.push({ rec: visit(ch, rec, depth + 1) });
      }
      if (tag === 'svg' && !(parent && parent.svg)) addSvgDefs(el, rec);
      return rec;
    };
    visit(root, null, 0);
    return { recs, shadowHosts, hiddenSkipped };
  }

  // <use href="#icon"> and url(#gradient) often point outside the picked <svg>: inline those targets.
  function addSvgDefs(svgEl, rec) {
    const ids = new Set();
    for (const u of svgEl.querySelectorAll('use')) {
      const h = u.getAttribute('href') || u.getAttributeNS(XLINK_NS, 'href');
      if (h && h.startsWith('#')) ids.add(h.slice(1));
    }
    for (const n of svgEl.querySelectorAll('*')) {
      for (const a of n.attributes) {
        const m = /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(a.value);
        if (m) ids.add(m[1]);
      }
    }
    const extra = [];
    for (const id of ids) {
      if (svgEl.querySelector(`#${CSS.escape(id)}`)) continue;
      const target = document.getElementById(id);
      if (target && target instanceof SVGElement) extra.push(target);
    }
    if (extra.length) rec.svgDefs = extra.map(staticSvg);
  }
  function staticSvg(el) {
    const node = { tag: el.localName, svg: 1, a: [] };
    for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style' && !a.name.startsWith('on')) node.a.push([a.name, a.value]);
    const k = [];
    for (const ch of el.childNodes) {
      if (ch.nodeType === 1) k.push(staticSvg(ch));
      else if (ch.nodeType === 3 && ch.data.trim()) k.push({ t: ch.data.trim() });
    }
    if (k.length) node.k = k;
    return node;
  }

  function snapshot(rec) {
    const cs = getComputedStyle(rec.el);
    rec.cs = cs;
    const o = {};
    for (const p of SNAP) o[p] = cs.getPropertyValue(p);
    rec.o = o;
    rec.rect = rec.el.getBoundingClientRect();
    if (rec.svg) return;
    for (const pe of ['before', 'after']) {
      const pcs = getComputedStyle(rec.el, `::${pe}`);
      const c = pcs.getPropertyValue('content');
      if (!c || c === 'none' || c === 'normal' || pcs.getPropertyValue('display') === 'none') continue;
      const po = {};
      for (const p of PE_COMPARE) po[p] = pcs.getPropertyValue(p);
      rec.pe[pe] = { o: po, cs: pcs, decls: null, rule: null };
    }
  }

  const isInlineLevel = (rec) => /^inline/.test(rec.o.display) || rec.o.display === 'contents';

  /** Collapse whitespace the way the browser renders it, so the output text is clean. */
  function processText(rec) {
    const o = rec.o;
    const pre = /^(preserve|break-spaces)/.test(o['white-space-collapse'] || '');
    const flexish = /flex|grid/.test(o.display);
    // adjacent text nodes (e.g. React's `v{version}`) render as one run
    const kids = [];
    for (const k of rec.kids) {
      const prev = kids[kids.length - 1];
      if (!k.rec && prev && !prev.rec) prev.text += k.text;
      else kids.push(k.rec ? k : { text: k.text });
    }
    const out = [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.rec) { out.push(k); continue; }
      let t = k.text;
      if (pre || rec.tag === 'textarea') { if (t) out.push({ text: t, pre: true }); continue; }
      t = t.replace(/[ \t\n\r\f]+/g, ' ');
      if (flexish || rec.svg) { t = t.trim(); if (t) out.push({ text: t }); continue; }
      out.push({ text: t });
    }
    // trim spaces next to block-level boundaries; inside a plain inline element (<span>, <a>…)
    // the edges are NOT boundaries: "2009<span>; 17 years</span>" keeps its space
    const parentInline = rec.o.display === 'inline' || rec.o.display === 'contents';
    const blockish = (k) => (k ? Boolean(k.rec && !isInlineLevel(k.rec)) : !parentInline);
    const final = [];
    for (let i = 0; i < out.length; i++) {
      const k = out[i];
      if (k.rec || k.pre) { final.push(k); continue; }
      let t = k.text;
      const prev = final[final.length - 1];
      const next = out[i + 1];
      if (blockish(prev) || (prev && !prev.rec && !prev.pre && prev.text.endsWith(' '))) t = t.replace(/^ /, '');
      if (blockish(next)) t = t.replace(/ $/, '');
      if (t) final.push({ text: t });
    }
    rec.kids = final;
  }

  function settleAnimations(root) {
    const animated = new Map();
    let list = [];
    try { list = root.getAnimations({ subtree: true }); } catch { /* ignore */ }
    for (const a of list) {
      const effect = a.effect;
      // scroll-/view-driven animations reflect the current scroll position: leave them alone
      if (a.timeline && a.timeline !== document.timeline) continue;
      const timing = effect?.getTiming?.();
      if (timing && Number.isFinite(timing.iterations) && a.playState === 'running') {
        try { a.finish(); continue; } catch { /* infinite */ }
      }
      const target = effect?.target;
      if (!target || effect.pseudoElement) continue;
      let set = animated.get(target);
      if (!set) animated.set(target, (set = new Set()));
      try {
        for (const kf of effect.getKeyframes()) {
          for (const k of Object.keys(kf)) {
            if (k === 'offset' || k === 'easing' || k === 'composite' || k === 'computedOffset') continue;
            set.add(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
          }
        }
      } catch { /* ignore */ }
      if (a instanceof CSSTransition) set.add(a.transitionProperty);
    }
    return animated;
  }

  // ---------------------------------------------------------------- rebuild + diff

  function makeSheet(W, doc, css) {
    try {
      const s = new W.CSSStyleSheet();
      s.replaceSync(css);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, s];
      return s;
    } catch {
      const st = doc.createElement('style');
      st.textContent = css;
      doc.head.appendChild(st);
      return st.sheet;
    }
  }

  async function buildClone(recs, wrapW, fontCss) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    const fs = frame.style;
    for (const [p, v] of [['position', 'fixed'], ['left', '-300vw'], ['top', '0'], ['width', `${innerWidth}px`],
      ['height', `${innerHeight}px`], ['border', '0'], ['opacity', '0'], ['pointer-events', 'none'], ['z-index', '-1']]) {
      fs.setProperty(p, v, 'important');
    }
    document.documentElement.appendChild(frame);
    let doc = frame.contentDocument;
    try {
      doc.open();
      doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
      doc.close();
      doc = frame.contentDocument;
    } catch { /* Trusted Types may block document.write; quirks-mode drift is caught by verify */ }
    const W = frame.contentWindow;
    doc.documentElement.style.setProperty('background', 'transparent');
    doc.body.style.setProperty('margin', '0');
    makeSheet(W, doc, `${globalThis.SNAG_BASE_CSS}\n${fontCss}\n*, *::before, *::after { transition: none !important; animation: none !important; }`);
    const peSheet = makeSheet(W, doc, '');

    const wrap = doc.createElement('div');
    wrap.style.setProperty('width', `${wrapW}px`);
    wrap.style.setProperty('display', 'flow-root');
    doc.body.appendChild(wrap);

    const build = (rec, parent) => {
      const c = rec.svg ? doc.createElementNS(SVG_NS, rec.tag) : doc.createElement(rec.tag);
      for (const [n, v] of rec.attrs) {
        if (n === 'loading' || n === 'autoplay') continue;
        if ((n === 'src' || n === 'srcset') && /^(iframe|video|audio)$/i.test(rec.tag)) continue;
        try {
          if (n.startsWith('xlink:')) c.setAttributeNS(XLINK_NS, n, v);
          else c.setAttribute(n, v);
        } catch { /* ignore */ }
      }
      c.setAttribute('data-snag', String(rec.i));
      if (!rec.parent) c.classList.add('root');
      for (const [p, v] of rec.decls) c.style.setProperty(p, v);
      parent.appendChild(c);
      rec.clone = c;
      if (rec.svgDefs) appendStatic(doc, c, { tag: 'defs', svg: 1, a: [], k: rec.svgDefs });
      for (const k of rec.kids) {
        if (k.rec) build(k.rec, c);
        else c.appendChild(doc.createTextNode(k.text));
      }
      if (/^(input|textarea|select)$/i.test(rec.tag)) { try { c.value = rec.el.value; } catch { /* ignore */ } }
      for (const pe of Object.keys(rec.pe)) {
        const idx = peSheet.insertRule(`[data-snag="${rec.i}"]::${pe} {}`, peSheet.cssRules.length);
        const rule = peSheet.cssRules[idx];
        for (const [p, v] of rec.pe[pe].decls) rule.style.setProperty(p, v);
        rec.pe[pe].rule = rule;
      }
    };
    build(recs[0], wrap);

    void wrap.offsetHeight;
    await Promise.race([
      Promise.allSettled([...doc.images].map((img) => img.decode())),
      sleep(1500),
    ]);
    await Promise.race([doc.fonts.ready, sleep(2500)]);
    await raf();
    return { frame, doc, W, wrap };
  }

  function appendStatic(doc, parent, node) {
    if (node.t != null) { parent.appendChild(doc.createTextNode(node.t)); return; }
    const c = doc.createElementNS(SVG_NS, node.tag);
    for (const [n, v] of node.a || []) {
      try { if (n.startsWith('xlink:')) c.setAttributeNS(XLINK_NS, n, v); else c.setAttribute(n, v); } catch { /* ignore */ }
    }
    parent.appendChild(c);
    for (const k of node.k || []) appendStatic(doc, c, k);
  }

  const roundNums = (s) => s.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => String(Math.round(parseFloat(m) * 10) / 10));
  // values that differ as strings but render identically
  const canon = (s, p) => {
    if (s === 'button' || s === 'menulist-button') return 'auto';
    if ((p === 'min-width' || p === 'min-height') && s === 'auto') return '0px'; // auto only differs for flex/grid items
    return s;
  };
  const same = (a, b, p) => a === b || (a != null && b != null && (roundNums(a) === roundNums(b) || canon(a, p) === canon(b, p)));

  const SIDES4 = ['top', 'right', 'bottom', 'left'];
  /** True when a property cannot affect rendering given the element's original computed style. */
  function irrelevant(p, o, po, rec) {
    const d = o.display || '';
    let m;
    if ((m = /^border-(top|right|bottom|left)-(style|color)$/.exec(p))) return o[`border-${m[1]}-width`] === '0px';
    if (p === 'outline-color' || p === 'outline-offset' || p === 'outline-width') return o['outline-style'] === 'none';
    if (/^text-decoration-(style|color|thickness)$/.test(p) || p === 'text-underline-offset') return o['text-decoration-line'] === 'none';
    if (/^background-(size|position-x|position-y|repeat|origin|attachment)$/.test(p)) return o['background-image'] === 'none';
    if (p === 'flex-direction' || p === 'flex-wrap') return !/flex/.test(d);
    if (p === 'justify-content' || p === 'align-items' || p === 'align-content') return !/(flex|grid)/.test(d);
    if (p === 'row-gap' || p === 'column-gap') return !/(flex|grid)/.test(d) && o['column-count'] === 'auto';
    if (/^grid-(template|auto)/.test(p)) return !/grid/.test(d);
    if (p === 'justify-items') return !/grid/.test(d);
    if (/^(flex-grow|flex-shrink|flex-basis|order|align-self)$/.test(p)) return !po || !/(flex|grid)/.test(po.display);
    if (/^grid-(column|row)-(start|end)$/.test(p) || p === 'justify-self') return !po || !/grid/.test(po.display);
    if (p === 'top' || p === 'right' || p === 'bottom' || p === 'left') return o.position === 'static';
    if (p === 'z-index') return o.position === 'static' && !(po && /(flex|grid)/.test(po.display));
    if (p === 'vertical-align') return !rec.svg && !/^(inline|table-cell)/.test(d);
    if (p === 'object-fit' || p === 'object-position') return !/^(img|video|canvas|iframe|embed|object|input|image)$/i.test(rec.tag);
    if (p === 'text-overflow') return o['overflow-x'] === 'visible';
    if (p === '-webkit-box-orient' || p === '-webkit-line-clamp') return !/-webkit-box/.test(d);
    if (p === 'resize') return o['overflow-x'] === 'visible';
    if (p === 'table-layout') return !/table/.test(d);
    if (p === 'box-sizing') {
      // only changes anything for boxes with an explicit size *and* padding/border
      if (/^(img|video|canvas|iframe|input|select|textarea|button|progress|meter)$/i.test(rec.tag)) return false;
      const sized = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'flex-basis', 'aspect-ratio']
        .some((k) => { const v = rec.decls?.get(k); return v && !/^(auto|none|0|0px|normal|0%)$/.test(v); });
      const boxed = SIDES4.some((sd) => (o[`padding-${sd}`] && o[`padding-${sd}`] !== '0px') || (o[`border-${sd}-width`] && o[`border-${sd}-width`] !== '0px'));
      return !(sized && boxed);
    }
    if (MOTION.test(p)) return true;
    return false;
  }

  function staticDefault(p, v) {
    if (/^(margin|padding)-/.test(p) || /^border-(top|right|bottom|left)-width$/.test(p)) return ZERO.test(v);
    if (p === 'width' || p === 'height' || p === 'top' || p === 'right' || p === 'bottom' || p === 'left') return v === 'auto';
    if (p === 'box-sizing') return v === 'border-box';
    return false;
  }

  const TRACKS = ['grid-template-columns', 'grid-template-rows'];
  const COMPARE_STYLE = COMPARE.filter((p) => !GEOM.has(p));
  const COMPARE_GEOM = COMPARE.filter((p) => GEOM.has(p) && !TRACKS.includes(p));
  const PE_STYLE = PE_COMPARE.filter((p) => !GEOM.has(p));
  const PE_GEOM = PE_COMPARE.filter((p) => GEOM.has(p));

  /**
   * Two top-down passes: first everything whose computed value is layout-independent
   * (so inherited fixes like font-family land before anything is measured), then the
   * layout-resolved values (margins, paddings, offsets, grid tracks).
   */
  function verify(recs, env, stats) {
    verifyPass(recs, env, stats, COMPARE_STYLE, PE_STYLE);
    verifyPass(recs, env, stats, COMPARE_GEOM, PE_GEOM);
    // track sizes depend on the children, so settle them last and bottom-up
    verifyPass([...recs].reverse(), env, stats, TRACKS, []);
  }

  const OFFSETS = new Set(['top', 'right', 'bottom', 'left']);

  function verifyPass(recs, env, stats, props, peProps) {
    const W = env.W;
    const patch = (rec, p, cv, ov) => {
      rec.clone.style.setProperty(p, ov);
      rec.decls.set(p, ov);
      rec.patched.add(p);
      stats.patched++;
      if (stats.patches.length < 60) stats.patches.push(`${rec.tag}[${rec.i}] ${p}: ${cv} → ${ov}`);
    };
    for (const rec of recs) {
      const c = rec.clone;
      const ccs = W.getComputedStyle(c);
      const po = rec.parent ? rec.parent.o : rec.ctxParent;
      // Absolutely positioned boxes: resolved offsets are relative to a containing block that may
      // sit outside the snippet, so compare where the box actually lands relative to the root.
      let offsetsDone = false;
      if (props.includes('top') && /^(absolute|fixed)$/.test(rec.o.position) && rec.parent) {
        offsetsDone = true;
        const o0 = env.root.rect, c0 = env.root.clone.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const dx = (rec.rect.left - o0.left) - (cr.left - c0.left);
        const dy = (rec.rect.top - o0.top) - (cr.top - c0.top);
        if (Math.abs(dx) > 1) patch(rec, 'left', ccs.left, `${Math.round((parseFloat(ccs.left) + dx) * 100) / 100}px`);
        if (Math.abs(dy) > 1) patch(rec, 'top', ccs.top, `${Math.round((parseFloat(ccs.top) + dy) * 100) / 100}px`);
      }
      for (const p of props) {
        if (offsetsDone && OFFSETS.has(p)) continue;
        if (rec.skip.has(p) || rec.anim?.has(p) || irrelevant(p, rec.o, po, rec)) continue;
        const ov = rec.o[p];
        const cv = ccs.getPropertyValue(p);
        if (same(ov, cv, p)) continue;
        patch(rec, p, cv, ov);
      }
      for (const pe of Object.keys(rec.pe)) {
        const P = rec.pe[pe];
        const pcs = W.getComputedStyle(c, `::${pe}`);
        for (const p of peProps) {
          if (p !== 'content' && irrelevant(p, P.o, rec.o, rec)) continue;
          if ((p === 'width' || p === 'height') && /^inline/.test(P.o.display)) continue;
          const ov = P.o[p];
          if (same(ov, pcs.getPropertyValue(p), p)) continue;
          P.rule.style.setProperty(p, ov);
          P.decls.set(p, ov);
          stats.patched++;
        }
      }
    }
  }

  function prune(recs, env, stats) {
    const W = env.W;
    for (const rec of recs) {
      const c = rec.clone;
      const ccs = W.getComputedStyle(c);
      const po = rec.parent ? rec.parent.o : rec.ctxParent;
      const drop = (p) => { rec.decls.delete(p); c.style.removeProperty(p); stats.pruned++; };

      // motion that can never run
      const dur = rec.decls.get('transition-duration') ?? rec.o['transition-duration'];
      const del = rec.decls.get('transition-delay') ?? rec.o['transition-delay'];
      if (!/[1-9]/.test(`${dur}${del}`)) for (const p of [...rec.decls.keys()]) if (p.startsWith('transition-')) drop(p);
      const scrollDriven = rec.o['animation-timeline'] && rec.o['animation-timeline'] !== 'auto';
      if (scrollDriven || (rec.decls.get('animation-name') ?? rec.o['animation-name']) === 'none') for (const p of [...rec.decls.keys()]) if (p.startsWith('animation-')) drop(p);

      for (const [p, v] of [...rec.decls]) {
        if (rec.patched.has(p) || MOTION.test(p)) continue;
        if (!INHERITED.has(p) && irrelevant(p, rec.o, po, rec)) { drop(p); continue; }
        if (staticDefault(p, v)) { drop(p); continue; }
        if (GEOM.has(p) && !NEUTRAL.test(v)) continue;
        c.style.removeProperty(p);
        const now = ccs.getPropertyValue(p);
        const want = p in rec.o ? rec.o[p] : rec.cs.getPropertyValue(p);
        if (same(want, now, p)) { rec.decls.delete(p); stats.pruned++; }
        else c.style.setProperty(p, v);
      }

      for (const pe of Object.keys(rec.pe)) {
        const P = rec.pe[pe];
        const pcs = W.getComputedStyle(c, `::${pe}`);
        for (const [p, v] of [...P.decls]) {
          if (p === 'content' || MOTION.test(p)) continue;
          if (!INHERITED.has(p) && irrelevant(p, P.o, rec.o, rec)) { P.decls.delete(p); P.rule.style.removeProperty(p); continue; }
          if (staticDefault(p, v)) { P.decls.delete(p); P.rule.style.removeProperty(p); continue; }
          P.rule.style.removeProperty(p);
          const want = p in P.o ? P.o[p] : P.cs.getPropertyValue(p);
          if (same(want, pcs.getPropertyValue(p), p)) P.decls.delete(p);
          else P.rule.style.setProperty(p, v);
        }
      }
    }
  }

  /**
   * Hover/focus declarations: apply each one to the rebuilt element and keep it only if the
   * computed value actually changes (drops `focus:shadow-none` with no shadow, the `initial`
   * longhands a `background:` shorthand expands to, etc.). CSS-wide keywords become real values.
   */
  function cleanStates(recs, env) {
    const W = env.W;
    for (const rec of recs) {
      if (!rec.states) continue;
      const c = rec.clone;
      const ccs = W.getComputedStyle(c);
      for (const [st, decls] of Object.entries(rec.states)) {
        for (const [p, val] of Object.entries(decls)) {
          const prev = c.style.getPropertyValue(p);
          const base = ccs.getPropertyValue(p);
          c.style.setProperty(p, val);
          const now = ccs.getPropertyValue(p);
          if (prev) c.style.setProperty(p, prev); else c.style.removeProperty(p);
          if (!now || same(now, base, p)) { delete decls[p]; continue; }
          if (/^(initial|inherit|unset|revert|revert-layer)$/i.test(val)) decls[p] = now;
        }
        if (!Object.keys(decls).length) delete rec.states[st];
      }
    }
  }

  function geometry(recs, env, stats) {
    const candidates = recs.filter((rec) => !(rec.svg && rec.parent?.svg) && !/^(inline|contents)$/.test(rec.o.display) && !/^table-(row|row-group|header-group|footer-group|column)/.test(rec.o.display));
    const off = (rec) => {
      const r = rec.clone.getBoundingClientRect();
      return { dw: Math.abs(r.width - rec.rect.width), dh: Math.abs(r.height - rec.rect.height) };
    };
    const bad = new Set(candidates.filter((rec) => { const d = off(rec); return d.dw > 1 || d.dh > 1; }));
    stats.sizeMismatches = bad.size;
    if (bad.size > Math.max(8, candidates.length * 0.4)) {
      stats.warnings.push('Layout differs a lot from the original (often a web font that could not load); sizes were not pinned.');
      return;
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const rec = candidates[i];
      if (!bad.has(rec)) continue;
      const d = off(rec);
      const pin = (p, delta) => {
        if (rec.o[p] === 'auto') return;
        if (stats.patches.length < 60) stats.patches.push(`${rec.tag}[${rec.i}] pin ${p}: ${rec.o[p]} (off by ${Math.round(delta)}px)`);
        rec.clone.style.setProperty(p, rec.o[p]);
        rec.decls.set(p, rec.o[p]);
        stats.pinned++;
      };
      if (d.dw > 1) pin('width', d.dw);
      if (d.dh > 1) pin('height', d.dh);
    }
    // final fidelity score: boxes within 1px of the original (size and offset from the root)
    const r0 = recs[0].clone.getBoundingClientRect(), o0 = recs[0].rect;
    let ok = 0;
    for (const rec of candidates) {
      const r = rec.clone.getBoundingClientRect(), o = rec.rect;
      if (Math.abs(r.width - o.width) <= 1 && Math.abs(r.height - o.height) <= 1 &&
        Math.abs((r.left - r0.left) - (o.left - o0.left)) <= 1.5 && Math.abs((r.top - r0.top) - (o.top - o0.top)) <= 1.5) ok++;
    }
    stats.fidelity = candidates.length ? Math.round((ok / candidates.length) * 100) : 100;
  }

  // ---------------------------------------------------------------- model

  function toModel(rec) {
    const n = { tag: rec.tag };
    if (rec.svg) n.svg = 1;
    if (rec.attrs.length) n.a = rec.attrs;
    if (rec.decls.size) n.s = Object.fromEntries(rec.decls);
    const st = {};
    for (const [k, v] of Object.entries(rec.states || {})) {
      const d = {};
      // drop declarations that can't matter in this state (e.g. outline-color while outline-style is none)
      const merged = { ...rec.o, ...v };
      const po = rec.parent ? rec.parent.o : rec.ctxParent;
      for (const [p, val] of Object.entries(v)) {
        if (rec.decls.get(p) === val) continue;
        if (!INHERITED.has(p) && irrelevant(p, merged, po, rec)) continue;
        d[p] = val;
      }
      if (Object.keys(d).length) st[k] = d;
    }
    if (Object.keys(st).length) n.st = st;
    const pe = {};
    for (const [k, P] of Object.entries(rec.pe)) pe[k] = Object.fromEntries(P.decls);
    if (Object.keys(pe).length) n.pe = pe;
    if (!rec.svg && isInlineLevel(rec)) n.inl = 1;
    const h = rec.el.classList ? hintOf(rec.el) : null;
    if (h) n.h = h;
    const kids = [];
    if (rec.svgDefs) kids.push({ tag: 'defs', svg: 1, k: rec.svgDefs });
    for (const k of rec.kids) kids.push(k.rec ? toModel(k.rec) : (k.pre ? { t: k.text, pre: 1 } : { t: k.text }));
    if (kids.length) n.k = kids;
    return n;
  }

  function contextBackground(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const bg = getComputedStyle(p).backgroundColor;
      if (bg && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(bg)) return bg;
    }
    return 'rgb(255, 255, 255)';
  }

  function adjustRoot(rec) {
    const pos = rec.o.position;
    const d = rec.decls;
    if (pos === 'absolute' || pos === 'fixed') {
      for (const p of ['position', 'top', 'right', 'bottom', 'left', 'float', 'translate', 'z-index']) { d.delete(p); rec.skip.add(p); }
      d.set('position', 'relative');
      const t = rec.o.transform;
      if (t === 'none' || /^matrix\(1, 0, 0, 1, [-\d.e]+, [-\d.e]+\)$/.test(t)) { d.delete('transform'); rec.skip.add('transform'); }
    }
    if (rec.o.float !== 'none') { d.delete('float'); rec.skip.add('float'); }
    for (const p of ['margin-top', 'margin-bottom']) rec.skip.add(p);
    if (pos === 'sticky') { for (const p of ['top', 'bottom']) { d.delete(p); rec.skip.add(p); } }
  }

  function suggestName(el, rect) {
    const h = hintOf(el) || el.getAttribute('aria-label') || '';
    const named = { nav: 'Nav', header: 'Header', footer: 'Footer', button: 'Button', form: 'Form', aside: 'Sidebar', article: 'Card', table: 'Table', ul: 'List', ol: 'List', dialog: 'Dialog', a: 'Link', img: 'Image', svg: 'Icon', main: 'Main' };
    const roles = { navigation: 'Nav', banner: 'Header', contentinfo: 'Footer', dialog: 'Dialog', search: 'Search', tablist: 'Tabs' };
    const wide = rect.width > innerWidth * 0.7;
    const guess = () => {
      if (roles[el.getAttribute('role')]) return roles[el.getAttribute('role')];
      if (named[el.localName]) return named[el.localName];
      if (el.querySelector('footer') || (wide && el.closest('footer'))) return 'Footer';
      if (wide && rect.top + scrollY < 120 && rect.height < 160 && (el.querySelector('nav, a') || el.closest('header'))) return 'Header';
      if (el.querySelector('h1')) return 'Hero';
      if (el.querySelector('form, input')) return 'Form';
      if (el.localName === 'section') return 'Section';
      const heading = el.querySelector('h2, h3');
      const words = heading?.textContent.trim().split(/\s+/).slice(0, 3).join(' ');
      return words && /^[\w\s'-]+$/.test(words) ? `${words} Section` : null;
    };
    const base = h || guess() || 'Snagged';
    const pascal = base.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
    return /^[A-Z]/.test(pascal) ? pascal.slice(0, 40) : `Snagged${pascal}`.slice(0, 40);
  }

  // ---------------------------------------------------------------- entry point

  async function capture(root, opts = {}) {
    const t0 = performance.now();
    const progress = opts.onProgress || (() => {});
    if (!(root instanceof Element)) throw new Error('Nothing selected');
    const stats = { patches: [], elements: 0, rulesOnPage: 0, rulesMatched: 0, patched: 0, pruned: 0, pinned: 0, sizeMismatches: 0, fidelity: null, ms: 0, warnings: [] };

    // Snapshot first (synchronously), so JS-driven animation can't drift between the screenshot
    // and what we read. The slow stylesheet indexing happens afterwards.
    const animated = settleAnimations(root);
    const { recs, shadowHosts, hiddenSkipped } = collect(root, opts.exclude, opts.includeHidden);
    for (const rec of recs) {
      snapshot(rec);
      rec.inlineText = rec.el.style?.cssText || '';
      rec.anim = animated.get(rec.el);
    }
    if (hiddenSkipped) stats.warnings.push(`Skipped ${hiddenSkipped} hidden menu/popover subtree(s). Shift+click when picking to include them.`);
    stats.elements = recs.length;
    if (shadowHosts) stats.warnings.push(`${shadowHosts} web component(s) with shadow DOM: only their light-DOM content was captured.`);
    for (const rec of recs) processText(rec);

    progress('Reading stylesheets…');
    const db = await buildDb(opts.fetchCss);
    stats.rulesOnPage = db.ruleCount;
    if (db.errors.length) stats.warnings.push(`${db.errors.length} stylesheet(s) could not be read: ${db.errors.slice(0, 3).join('; ')}`);

    progress('Resolving the cascade…');
    const used = new Set();
    for (const rec of recs) cascadeRec(rec, db, used);
    stats.rulesMatched = used.size;
    const rootRec = recs[0];
    const parentEl = root.parentElement;
    const pcs = parentEl ? getComputedStyle(parentEl) : null;
    rootRec.ctxParent = { display: pcs ? pcs.display : 'block' };
    adjustRoot(rootRec);

    // Width of the box the component is rebuilt into.
    const ml = parseFloat(rootRec.o['margin-left']) || 0, mr = parseFloat(rootRec.o['margin-right']) || 0;
    const blockParent = pcs && /^(block|flow-root|list-item|table-cell)$/.test(pcs.display);
    const outOfFlow = /^(absolute|fixed)$/.test(rootRec.o.position) || rootRec.o.float !== 'none';
    let wrapW = rootRec.rect.width + ml + mr;
    if (blockParent && !outOfFlow && !isInlineLevel(rootRec)) {
      wrapW = parentEl.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
    }
    wrapW = Math.max(1, Math.round(wrapW * 100) / 100);

    const fontCss = db.fontFaces.map((f) => f.css).join('\n');
    progress('Rebuilding & comparing…');
    const env = await buildClone(recs, wrapW, fontCss);
    env.root = rootRec;
    try {
      verify(recs, env, stats);
      prune(recs, env, stats);
      verify(recs, env, stats);
      geometry(recs, env, stats);
      cleanStates(recs, env);
    } finally {
      if (opts.debugKeep) globalThis.__snagDebug = { env, recs };
      else env.frame.remove();
    }

    // font-size always travels with its line-height (keeps Tailwind text-* sizes safe)
    for (const rec of recs) {
      if (rec.decls.has('font-size') && !rec.decls.has('line-height')) rec.decls.set('line-height', rec.o['line-height']);
    }

    const tree = toModel(rootRec);
    const families = new Set();
    const anims = new Set();
    const scan = (n) => {
      for (const s of [n.s, ...Object.values(n.pe || {}), ...Object.values(n.st || {})]) {
        if (!s) continue;
        if (s['font-family']) for (const f of s['font-family'].split(',')) families.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase());
        if (s['animation-name']) for (const a of s['animation-name'].split(',')) anims.add(a.trim());
      }
      for (const k of n.k || []) if (k.tag) scan(k);
    };
    scan(tree);
    const seen = new Set();
    const fontFaces = db.fontFaces.filter((f) => families.has(f.family.toLowerCase()) && !seen.has(f.css) && seen.add(f.css)).map((f) => f.css);
    const keyframes = [...anims].filter((a) => db.keyframes.has(a)).map((a) => db.keyframes.get(a));

    // source size of what was captured: each element's own markup + its text + the CSS rules it used
    let origBytes = 0;
    for (const rec of recs) {
      origBytes += rec.el.outerHTML.length - rec.el.innerHTML.length;
      for (const k of rec.kids) if (!k.rec) origBytes += k.text.length;
    }
    for (const r of used) origBytes += r.len;
    stats.origBytes = origBytes;
    stats.ms = Math.round(performance.now() - t0);

    return {
      v: 1,
      page: { url: location.href, title: document.title },
      label: `${root.localName}${root.id ? `#${root.id}` : ''}${hintOf(root) ? `.${hintOf(root)}` : ''}`,
      suggestedName: suggestName(root, rootRec.rect),
      width: wrapW,
      size: { w: Math.round(rootRec.rect.width), h: Math.round(rootRec.rect.height) },
      background: contextBackground(root),
      root: tree,
      fontFaces,
      keyframes,
      stats,
    };
  }

  globalThis.__snagExtract = { capture, _internals: { specificity, analyzeSelector, nestSelector, resolveVars, buildDb, matchEntries } };
})();
