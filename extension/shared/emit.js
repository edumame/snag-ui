/*
 * Snag UI — code generation. Turns the captured style model into:
 *   - React + Tailwind (v4 class names, arbitrary values where nothing fits)
 *   - React + CSS Module
 *   - plain HTML + CSS (also used for the live preview)
 * Compaction: identical style sets share one class, longhands collapse into
 * shorthands, and runs of 3+ structurally identical siblings become a data
 * array + .map().
 */
(function (G) {
  'use strict';

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const VARY = new Set(['href', 'src', 'srcset', 'alt', 'title', 'aria-label', 'datetime', 'value', 'placeholder', 'poster']);
  const BOOL_ATTRS = new Set(['disabled', 'checked', 'readonly', 'required', 'multiple', 'controls', 'muted', 'loop', 'playsinline', 'autoplay', 'open', 'reversed', 'allowfullscreen', 'hidden', 'novalidate', 'selected']);

  const isEl = (n) => n && n.tag != null;
  const kidsOf = (n) => n.k || [];

  // ------------------------------------------------------------ small helpers

  function px(v) {
    if (v == null) return null;
    const m = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)(px|rem)?$/i.exec(String(v).trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!m[2]) return n === 0 ? 0 : null;
    return m[2] === 'rem' ? n * 16 : n;
  }
  const num = (v) => (/^-?\d*\.?\d+$/.test(String(v).trim()) ? parseFloat(v) : null);
  const fmt = (n) => String(Math.round(n * 1000) / 1000);

  function parseRgb(v) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(String(v).trim());
    if (!m) return null;
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  function hexOf(r, g, b, a = 1) {
    let h = `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
    if (/^#(.)\1(.)\2(.)\3((.)\5)?$/.test(h)) h = `#${h[1]}${h[3]}${h[5]}${h.length === 9 ? h[7] : ''}`;
    return h;
  }
  // ---- modern color spaces → sRGB (computed styles come back as lab()/oklch()/color-mix())
  const COLOR_FN = /\b(?:color-mix\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|(?:ok)?(?:lab|lch)\([^()]*\)|color\([^()]*\)|hwb\([^()]*\)|hsla?\([^()]*\))/gi;
  let cctx = null;
  function canvasColor(c) {
    if (cctx === null) {
      try { cctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d'); }
      catch { cctx = false; }
    }
    if (!cctx) return null;
    cctx.fillStyle = '#010203';
    cctx.fillStyle = c;
    const fs = String(cctx.fillStyle);
    return fs === '#010203' ? null : fs;
  }
  const lin2srgb = (x) => { const s = Math.sign(x), a = Math.abs(x); return s * (a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055); };
  const srgb2lin = (x) => { const s = Math.sign(x), a = Math.abs(x); return s * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
  const mul = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const XYZ_TO_LSRGB = [[3.2409699419045226, -1.537383177570094, -0.4986107602930034], [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559], [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]];
  const D50_TO_D65 = [[0.9554734527042182, -0.023098536874261423, 0.0632593086610217], [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008], [0.012314001688319899, -0.020507696433477912, 1.3303659366080753]];
  const LP3_TO_XYZ = [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]];
  function oklabToLin(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  }
  function labToLin(L, a, b) {
    const k = 24389 / 27, e = 216 / 24389;
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
    const yr = L > k * e ? fy ** 3 : L / k;
    const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
    return mul(XYZ_TO_LSRGB, mul(D50_TO_D65, [xr * 0.96422, yr, zr * 0.82521]));
  }
  function modernToRgb(s) {
    const m = /^(oklab|oklch|lab|lch|color)\(\s*(.*)\)$/i.exec(s.trim());
    if (!m) return null;
    const fn = m[1].toLowerCase();
    let [main, alpha] = m[2].split('/');
    const parts = main.trim().split(/\s+/);
    let space = null;
    if (fn === 'color') space = parts.shift();
    const n = (t, pctScale = 1) => (t === 'none' ? 0 : t.endsWith('%') ? (parseFloat(t) / 100) * pctScale : parseFloat(t));
    const a = alpha == null ? 1 : n(alpha.trim());
    let lin;
    if (fn === 'oklab') lin = oklabToLin(n(parts[0]), n(parts[1], 0.4), n(parts[2], 0.4));
    else if (fn === 'oklch') { const h = (n(parts[2]) * Math.PI) / 180, C = n(parts[1], 0.4); lin = oklabToLin(n(parts[0]), C * Math.cos(h), C * Math.sin(h)); }
    else if (fn === 'lab') lin = labToLin(n(parts[0], 100), n(parts[1], 125), n(parts[2], 125));
    else if (fn === 'lch') { const h = (n(parts[2]) * Math.PI) / 180, C = n(parts[1], 150); lin = labToLin(n(parts[0], 100), C * Math.cos(h), C * Math.sin(h)); }
    else if (space === 'srgb') lin = parts.map((t) => srgb2lin(n(t)));
    else if (space === 'srgb-linear') lin = parts.map((t) => n(t));
    else if (space === 'display-p3') lin = mul(XYZ_TO_LSRGB, mul(LP3_TO_XYZ, parts.map((t) => srgb2lin(n(t)))));
    else return null;
    if (lin.some((x) => Number.isNaN(x))) return null;
    const [r, g, b] = lin.map((x) => Math.round(Math.max(0, Math.min(1, lin2srgb(x))) * 255));
    return [r, g, b, Math.max(0, Math.min(1, a))];
  }
  const srgbCache = new Map();
  function toSrgb(c) {
    if (/currentcolor|var\(/i.test(c)) return c;
    if (srgbCache.has(c)) return srgbCache.get(c);
    let out = c;
    const norm = canvasColor(c);
    if (norm) {
      const rgba = /^#|^rgba?\(/i.test(norm) ? (parseRgb(norm) || parseHex(norm)) : modernToRgb(norm);
      if (rgba) out = rgba[3] === 0 ? 'transparent' : hexOf(...rgba);
    }
    srgbCache.set(c, out);
    return out;
  }

  /** Every color in a CSS value → compact sRGB hex. */
  const compactColors = (v) => String(v).replace(COLOR_FN, toSrgb).replace(/rgba?\([^()]*\)/gi, (m) => {
    const c = parseRgb(m);
    if (!c) return m;
    if (c[3] === 0) return 'transparent';
    return hexOf(...c);
  });

  function splitTop(s, sep = ',') {
    const out = [];
    let depth = 0, start = 0, q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === sep && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out.filter((x) => x !== '');
  }

  /** Drop the invisible `0 0 #0000`-style layers Tailwind & co. leave in box-shadow. */
  function cleanShadow(v) {
    if (!v || v === 'none') return v;
    const layers = [];
    for (const layer of splitTop(v)) {
      const t = splitTop(compactColors(layer), ' ');
      const ci = t.findIndex((x) => x !== 'inset' && !/^-?[\d.]/.test(x));
      const color = ci >= 0 ? t[ci] : 'currentcolor';
      if (/^(transparent|#0000|#00000000)$/i.test(color)) continue;
      const lens = t.filter((x, i) => i !== ci && x !== 'inset').map(px);
      if (lens.length && lens.every((n) => n === 0)) continue;
      // browsers serialize "color x y blur"; authors write "x y blur color"
      if (ci >= 0) t.push(t.splice(ci, 1)[0]);
      layers.push(t.join(' ').replace(/(^|\s)0px\b/g, '$10'));
    }
    return layers.length ? layers.join(', ') : 'none';
  }

  /** Normalize a value for output: single-term calc() unwrapped, invisible shadows dropped, colors as hex. */
  function cleanValue(p, v) {
    v = String(v).trim().replace(/calc\(\s*(-?\d*\.?\d+(?:[a-z]+|%)?)\s*\)/gi, '$1');
    if (/radius$/.test(p)) v = v.replace(/\d*\.?\d+e\+\d+px/gi, '9999px'); // calc(infinity * 1px)
    if (p === 'box-shadow') v = cleanShadow(v);
    return compactColors(v);
  }

  // ------------------------------------------------------------ CSS (shorthands)

  const ORDER = [
    'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index', 'display', 'float', 'clear', 'box-sizing',
    'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
    'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
    'grid-column', 'grid-row', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
    'justify-content', 'justify-items', 'justify-self', 'align-content', 'align-items', 'align-self', 'gap', 'row-gap', 'column-gap',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color',
    'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'outline', 'outline-offset',
    'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-clip',
    'box-shadow', 'opacity',
    'color', 'font-family', 'font-size', 'line-height', 'font-weight', 'font-style', 'letter-spacing', 'text-align',
    'text-transform', 'text-decoration', 'white-space', 'text-overflow',
    'cursor', 'transform', 'transition', 'animation',
  ];
  const orderOf = (p) => { const i = ORDER.indexOf(p); return i < 0 ? 999 : i; };

  function shorten4([t, r, b, l]) {
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    if (r === l) return `${t} ${r} ${b}`;
    return `${t} ${r} ${b} ${l}`;
  }
  const SIDES = ['top', 'right', 'bottom', 'left'];

  function whiteSpaceOf(collapse, wrap) {
    if (collapse === 'break-spaces') return 'break-spaces';
    if (collapse === 'preserve') return wrap === 'nowrap' ? 'pre' : 'pre-wrap';
    if (collapse === 'preserve-breaks') return 'pre-line';
    if (wrap === 'nowrap') return 'nowrap';
    if (collapse === 'collapse' || wrap === 'wrap') return 'normal';
    return null;
  }

  function cssDecls(s) {
    const m = new Map(Object.entries(s || {}).map(([p, v]) => [p, cleanValue(p, v)]));
    const out = [];
    const take = (p) => { const v = m.get(p); m.delete(p); return v; };
    const all = (ps) => ps.every((p) => m.has(p));

    const ws = whiteSpaceOf(m.get('white-space-collapse'), m.get('text-wrap-mode'));
    if (ws && (m.has('white-space-collapse') || m.has('text-wrap-mode'))) { take('white-space-collapse'); take('text-wrap-mode'); out.push(['white-space', ws]); }

    for (const box of ['margin', 'padding']) {
      const ps = SIDES.map((s) => `${box}-${s}`);
      if (all(ps)) out.push([box, shorten4(ps.map(take))]);
    }
    if (all(SIDES) && SIDES.every((p) => m.get(p) === m.get('top'))) {
      const v = m.get('top');
      SIDES.forEach((p) => m.delete(p));
      out.push(['inset', v]);
    }

    // borders
    const W = SIDES.map((s) => `border-${s}-width`), S = SIDES.map((s) => `border-${s}-style`), C = SIDES.map((s) => `border-${s}-color`);
    const eq = (ps) => ps.every((p) => m.get(p) === m.get(ps[0]));
    if (all(W) && eq(W) && (!S.some((p) => m.has(p)) || (all(S) && eq(S))) && (!C.some((p) => m.has(p)) || (all(C) && eq(C)))) {
      const w = m.get(W[0]), st = m.get(S[0]) || 'solid', c = m.get(C[0]);
      [...W, ...S, ...C].forEach((p) => m.delete(p));
      out.push(['border', w === '0px' ? '0' : `${w} ${st}${c ? ` ${c}` : ''}`]);
    } else {
      for (let i = 0; i < 4; i++) {
        if (m.has(W[i]) && (m.has(C[i]) || m.has(S[i]))) {
          out.push([`border-${SIDES[i]}`, `${take(W[i])} ${take(S[i]) || 'solid'}${m.has(C[i]) ? ` ${take(C[i])}` : ''}`]);
        }
      }
      for (const [group, ps] of [['border-width', W], ['border-style', S], ['border-color', C]]) if (all(ps)) out.push([group, shorten4(ps.map(take))]);
    }
    const R = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    if (all(R) && R.every((p) => !/\s/.test(m.get(p)))) out.push(['border-radius', shorten4(R.map(take))]);

    if (all(['row-gap', 'column-gap'])) { const r = take('row-gap'), c = take('column-gap'); out.push(['gap', r === c ? r : `${r} ${c}`]); }
    if (all(['overflow-x', 'overflow-y'])) { const x = take('overflow-x'), y = take('overflow-y'); out.push(['overflow', x === y ? x : `${x} ${y}`]); }
    if (all(['flex-grow', 'flex-shrink', 'flex-basis'])) out.push(['flex', `${take('flex-grow')} ${take('flex-shrink')} ${take('flex-basis')}`]);
    for (const g of ['column', 'row']) {
      if (all([`grid-${g}-start`, `grid-${g}-end`])) {
        const a = take(`grid-${g}-start`), b = take(`grid-${g}-end`);
        out.push([`grid-${g}`, b === 'auto' ? a : `${a} / ${b}`]);
      }
    }
    if (all(['background-position-x', 'background-position-y'])) out.push(['background-position', `${take('background-position-x')} ${take('background-position-y')}`]);
    if (all(['outline-width', 'outline-style', 'outline-color'])) out.push(['outline', `${take('outline-width')} ${take('outline-style')} ${take('outline-color')}`]);

    const tr = transitionShorthand(m);
    if (tr) out.push(['transition', tr]);
    const an = animationShorthand(m);
    if (an) out.push(['animation', an]);

    if (m.has('text-decoration-line') && !m.has('text-decoration-style') && !m.has('text-decoration-thickness')) {
      const line = take('text-decoration-line'), color = take('text-decoration-color');
      out.push(['text-decoration', color ? `${line} ${color}` : line]);
    }

    for (const [p, v] of m) out.push([p, v]);
    return out.sort((a, b) => orderOf(a[0]) - orderOf(b[0]));
  }

  function transitionShorthand(m) {
    if (!m.has('transition-property') && !m.has('transition-duration')) return null;
    const props = splitTop(m.get('transition-property') || 'all');
    const dur = splitTop(m.get('transition-duration') || '0s');
    const ease = splitTop(m.get('transition-timing-function') || 'ease');
    const delay = splitTop(m.get('transition-delay') || '0s');
    ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'].forEach((p) => m.delete(p));
    return props.map((p, i) => {
      const parts = [p, dur[i % dur.length]];
      const e = ease[i % ease.length], d = delay[i % delay.length];
      if (e !== 'ease' || d !== '0s') parts.push(e);
      if (d !== '0s') parts.push(d);
      return parts.join(' ');
    }).join(', ');
  }
  function animationShorthand(m) {
    if (!m.has('animation-name') || m.get('animation-name') === 'none') return null;
    const keys = ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode'];
    const defaults = { 'animation-timing-function': 'ease', 'animation-delay': '0s', 'animation-iteration-count': '1', 'animation-direction': 'normal', 'animation-fill-mode': 'none' };
    const lists = keys.map((k) => splitTop(m.get(k) || defaults[k] || '0s'));
    keys.forEach((k) => m.delete(k));
    m.delete('animation-play-state');
    return lists[0].map((name, i) => {
      const parts = [name, lists[1][i % lists[1].length]];
      for (let j = 2; j < keys.length; j++) {
        const v = lists[j][i % lists[j].length];
        if (v !== defaults[keys[j]]) parts.push(v);
      }
      return parts.join(' ');
    }).join(', ');
  }

  const cssBlock = (sel, decls) => (decls.length ? `${sel} {\n${decls.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}` : '');

  // ------------------------------------------------------------ Tailwind

  function arbInner(v, keepSpaces) {
    let s = String(v).trim();
    if (!s.includes("'")) s = s.replace(/"/g, "'");
    s = s.replace(/_/g, '\\_');
    if (!keepSpaces) s = s.replace(/\s*,\s*/g, ',');
    return s.replace(/\s+/g, '_');
  }
  const arb = (v) => `[${arbInner(v)}]`;
  const arbProp = (p, v) => `[${p}:${arbInner(v)}]`;
  function cls(prefix, tok) {
    if (tok === '') return prefix;
    if (tok[0] === '-') return `-${prefix}-${tok.slice(1)}`;
    return `${prefix}-${tok}`;
  }

  function fraction(v) {
    const m = /^(\d*\.?\d+)%$/.exec(v);
    if (!m) return null;
    const p = parseFloat(m[1]);
    for (const [x, f] of [[100, 'full'], [50, '1/2'], [100 / 3, '1/3'], [200 / 3, '2/3'], [25, '1/4'], [75, '3/4'], [20, '1/5'], [40, '2/5'], [60, '3/5'], [80, '4/5'], [100 / 6, '1/6'], [500 / 6, '5/6']]) {
      if (Math.abs(p - x) < 0.01) return f;
    }
    return null;
  }

  function spaceTok(v) {
    v = String(v).trim();
    const n = px(v);
    if (n != null) {
      if (n === 0) return '0';
      if (n === 1) return 'px';
      if (n === -1) return '-px';
      const q = n / 4;
      if (Number.isInteger(q * 2)) return q < 0 ? `-${fmt(-q)}` : fmt(q);
    }
    if (v === 'auto') return 'auto';
    return fraction(v) || arb(v);
  }
  function sizeTok(v, axis) {
    const special = { 'fit-content': 'fit', 'min-content': 'min', 'max-content': 'max', auto: 'auto', '100%': 'full' };
    if (special[v]) return special[v];
    if (axis === 'w' && v === '100vw') return 'screen';
    if (axis === 'h') {
      const vh = { '100vh': 'screen', '100dvh': 'dvh', '100svh': 'svh', '100lvh': 'lvh' }[v];
      if (vh) return vh;
    }
    return spaceTok(v);
  }
  const CONTAINER = { 256: '3xs', 288: '2xs', 320: 'xs', 384: 'sm', 448: 'md', 512: 'lg', 576: 'xl', 672: '2xl', 768: '3xl', 896: '4xl', 1024: '5xl', 1152: '6xl', 1280: '7xl' };
  function maxWTok(v) {
    if (v === 'none') return 'none';
    if (v === '65ch') return 'prose';
    const n = px(v);
    if (n != null && CONTAINER[n]) return CONTAINER[n];
    return sizeTok(v, 'w');
  }

  function parseHex(s) {
    const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (!m) return null;
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1];
  }

  function colorTok(v) {
    const s = String(v).trim().toLowerCase();
    if (s === 'transparent') return 'transparent';
    if (s === 'currentcolor') return 'current';
    if (s === 'inherit') return 'inherit';
    if (s === 'white' || s === 'black') return s;
    const c = parseRgb(s) || parseHex(s);
    if (c) {
      const [r, g, b, a] = c;
      if (a === 0) return 'transparent';
      const named = r === 255 && g === 255 && b === 255 ? 'white' : r === 0 && g === 0 && b === 0 ? 'black' : null;
      if (a === 1) return named || `[${hexOf(r, g, b)}]`;
      const pct = a * 100;
      if (named && Math.abs(pct - Math.round(pct)) < 0.6) return `${named}/${Math.round(pct)}`;
      return `[${hexOf(r, g, b, a)}]`;
    }
    return arb(compactColors(v));
  }

  const FS = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
  const FS_LH = { xs: 16 / 12, sm: 20 / 14, base: 1.5, lg: 28 / 18, xl: 28 / 20, '2xl': 32 / 24, '3xl': 36 / 30, '4xl': 40 / 36, '5xl': 1, '6xl': 1, '7xl': 1, '8xl': 1, '9xl': 1 };
  const FW = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black', normal: 'normal', bold: 'bold' };
  const LEADING = { 1: 'none', 1.25: 'tight', 1.375: 'snug', 1.5: 'normal', 1.625: 'relaxed', 2: 'loose' };
  const TRACKING = { '-0.05em': 'tighter', '-0.025em': 'tight', '0em': 'normal', normal: 'normal', '0.025em': 'wide', '0.05em': 'wider', '0.1em': 'widest' };

  function lhModifier(lh) {
    if (lh === 'normal') return '[normal]';
    const n = px(lh);
    if (n != null && n > 0 && Number.isInteger((n / 4) * 2)) return fmt(n / 4);
    return arb(lh);
  }
  function leadingTok(lh) {
    const u = num(lh);
    if (u != null && LEADING[u]) return LEADING[u];
    if (u != null) return `[${lh}]`;
    return lhModifier(lh);
  }
  function textSize(fs, lh) {
    const n = px(fs);
    const name = n != null ? FS[n] : null;
    const sizeT = name || (n != null ? `[${fmt(n)}px]` : `[length:${arbInner(fs)}]`);
    if (lh == null) return `text-${sizeT}`;
    if (name) {
      const lpx = px(lh), u = num(lh), ratio = FS_LH[name];
      if ((lpx != null && Math.abs(lpx / n - ratio) < 0.005) || (u != null && Math.abs(u - ratio) < 0.005)) return `text-${name}`;
    }
    return `text-${sizeT}/${lhModifier(lh)}`;
  }

  function radTok(v) {
    const n = px(v);
    if (v === '50%' || (n != null && n >= 999)) return 'full';
    const R = { 0: 'none', 4: '', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' };
    if (n != null && R[n] !== undefined) return R[n];
    return arb(v);
  }
  function bwTok(v) {
    const n = px(v);
    if (n === 1) return '';
    if (n === 0) return '0';
    if (n === 2 || n === 4 || n === 8) return String(n);
    return arb(v);
  }

  const KW = {
    display: { block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', none: 'hidden', contents: 'contents', 'flow-root': 'flow-root', table: 'table', 'table-row': 'table-row', 'table-cell': 'table-cell', 'list-item': 'list-item', 'inline-table': 'inline-table', 'table-row-group': 'table-row-group', 'table-header-group': 'table-header-group', 'table-footer-group': 'table-footer-group', 'table-caption': 'table-caption', 'table-column': 'table-column' },
    position: { static: 'static', relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky' },
    'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
    'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
    'justify-content': { 'flex-start': 'justify-start', start: 'justify-start', left: 'justify-start', 'flex-end': 'justify-end', end: 'justify-end', right: 'justify-end', center: 'justify-center', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', stretch: 'justify-stretch', normal: 'justify-normal' },
    'align-items': { 'flex-start': 'items-start', start: 'items-start', 'self-start': 'items-start', 'flex-end': 'items-end', end: 'items-end', center: 'items-center', baseline: 'items-baseline', stretch: 'items-stretch', normal: 'items-stretch' },
    'align-self': { auto: 'self-auto', 'flex-start': 'self-start', start: 'self-start', 'flex-end': 'self-end', end: 'self-end', center: 'self-center', stretch: 'self-stretch', baseline: 'self-baseline' },
    'align-content': { 'flex-start': 'content-start', start: 'content-start', 'flex-end': 'content-end', end: 'content-end', center: 'content-center', 'space-between': 'content-between', 'space-around': 'content-around', 'space-evenly': 'content-evenly', stretch: 'content-stretch', normal: 'content-normal', baseline: 'content-baseline' },
    'justify-items': { start: 'justify-items-start', end: 'justify-items-end', center: 'justify-items-center', stretch: 'justify-items-stretch', normal: 'justify-items-normal' },
    'justify-self': { auto: 'justify-self-auto', start: 'justify-self-start', end: 'justify-self-end', center: 'justify-self-center', stretch: 'justify-self-stretch' },
    'text-align': { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify', start: 'text-start', end: 'text-end', '-webkit-center': 'text-center' },
    'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
    'font-style': { italic: 'italic', normal: 'not-italic', oblique: '[font-style:oblique]' },
    'white-space': { normal: 'whitespace-normal', nowrap: 'whitespace-nowrap', pre: 'whitespace-pre', 'pre-line': 'whitespace-pre-line', 'pre-wrap': 'whitespace-pre-wrap', 'break-spaces': 'whitespace-break-spaces' },
    'word-break': { 'break-all': 'break-all', 'keep-all': 'break-keep', normal: 'break-normal' },
    'overflow-wrap': { 'break-word': 'break-words', anywhere: '[overflow-wrap:anywhere]', normal: '[overflow-wrap:normal]' },
    'text-overflow': { ellipsis: 'text-ellipsis', clip: 'text-clip' },
    'text-wrap-style': { balance: 'text-balance', pretty: 'text-pretty' },
    visibility: { visible: 'visible', hidden: 'invisible', collapse: 'collapse' },
    'pointer-events': { none: 'pointer-events-none', auto: 'pointer-events-auto' },
    'user-select': { none: 'select-none', text: 'select-text', all: 'select-all', auto: 'select-auto' },
    'object-fit': { contain: 'object-contain', cover: 'object-cover', fill: 'object-fill', none: 'object-none', 'scale-down': 'object-scale-down' },
    'object-position': { '50% 50%': 'object-center', center: 'object-center', top: 'object-top', '50% 0%': 'object-top', bottom: 'object-bottom', '50% 100%': 'object-bottom', left: 'object-left', right: 'object-right' },
    'box-sizing': { 'border-box': 'box-border', 'content-box': 'box-content' },
    float: { left: 'float-left', right: 'float-right', none: 'float-none' },
    clear: { left: 'clear-left', right: 'clear-right', both: 'clear-both', none: 'clear-none' },
    'list-style-type': { none: 'list-none', disc: 'list-disc', decimal: 'list-decimal' },
    'list-style-position': { inside: 'list-inside', outside: 'list-outside' },
    'vertical-align': { baseline: 'align-baseline', top: 'align-top', middle: 'align-middle', bottom: 'align-bottom', 'text-top': 'align-text-top', 'text-bottom': 'align-text-bottom', sub: 'align-sub', super: 'align-super' },
    'text-decoration-line': { underline: 'underline', 'line-through': 'line-through', overline: 'overline', none: 'no-underline' },
    'text-decoration-style': { solid: 'decoration-solid', double: 'decoration-double', dotted: 'decoration-dotted', dashed: 'decoration-dashed', wavy: 'decoration-wavy' },
    'border-collapse': { collapse: 'border-collapse', separate: 'border-separate' },
    'table-layout': { auto: 'table-auto', fixed: 'table-fixed' },
    'background-repeat': { 'no-repeat': 'bg-no-repeat', repeat: 'bg-repeat', 'repeat-x': 'bg-repeat-x', 'repeat-y': 'bg-repeat-y', round: 'bg-repeat-round', space: 'bg-repeat-space' },
    'background-size': { cover: 'bg-cover', contain: 'bg-contain', auto: 'bg-auto' },
    'background-attachment': { fixed: 'bg-fixed', local: 'bg-local', scroll: 'bg-scroll' },
    'background-clip': { text: 'bg-clip-text', 'border-box': 'bg-clip-border', 'padding-box': 'bg-clip-padding', 'content-box': 'bg-clip-content' },
    'background-origin': { 'border-box': 'bg-origin-border', 'padding-box': 'bg-origin-padding', 'content-box': 'bg-origin-content' },
    isolation: { isolate: 'isolate', auto: 'isolation-auto' },
    appearance: { none: 'appearance-none', auto: 'appearance-auto' },
    resize: { none: 'resize-none', vertical: 'resize-y', horizontal: 'resize-x', both: 'resize' },
    '-webkit-font-smoothing': { antialiased: 'antialiased', auto: 'subpixel-antialiased' },
    'font-variant-numeric': { 'tabular-nums': 'tabular-nums', 'lining-nums': 'lining-nums', 'oldstyle-nums': 'oldstyle-nums', 'proportional-nums': 'proportional-nums', 'slashed-zero': 'slashed-zero', normal: 'normal-nums', ordinal: 'ordinal' },
    'grid-auto-flow': { row: 'grid-flow-row', column: 'grid-flow-col', dense: 'grid-flow-dense', 'row dense': 'grid-flow-row-dense', 'column dense': 'grid-flow-col-dense' },
    'outline-style': { none: 'outline-none', solid: 'outline-solid', dashed: 'outline-dashed', dotted: 'outline-dotted', double: 'outline-double' },
    'mix-blend-mode': {},
    'container-type': { 'inline-size': '@container', normal: '@container-normal', size: '@container-[size]' },
    'content': {},
  };

  function single(p, v) {
    const kw = KW[p];
    if (kw && kw[v] !== undefined) return kw[v];
    let n, m;
    switch (p) {
      case 'width': return cls('w', sizeTok(v, 'w'));
      case 'height': return cls('h', sizeTok(v, 'h'));
      case 'min-width': return cls('min-w', sizeTok(v, 'w'));
      case 'min-height': return cls('min-h', sizeTok(v, 'h'));
      case 'max-width': return cls('max-w', maxWTok(v));
      case 'max-height': return cls('max-h', v === 'none' ? 'none' : sizeTok(v, 'h'));
      case 'flex-basis': return cls('basis', sizeTok(v));
      case 'flex-grow': n = num(v); return n === 1 ? 'grow' : n != null && Number.isInteger(n) ? `grow-${n}` : null;
      case 'flex-shrink': n = num(v); return n === 1 ? 'shrink' : n != null && Number.isInteger(n) ? `shrink-${n}` : null;
      case 'order': n = num(v); return n != null && Number.isInteger(n) ? cls('order', String(n)) : null;
      case 'z-index': if (v === 'auto') return 'z-auto'; n = num(v); return n != null && Number.isInteger(n) ? cls('z', String(n)) : null;
      case 'opacity': n = num(v); if (n == null) return null; return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? `opacity-${Math.round(n * 100)}` : `opacity-[${v}]`;
      case 'top': case 'right': case 'bottom': case 'left': return cls(p, spaceTok(v));
      case 'color': return `text-${colorTok(v)}`;
      case 'background-color': return `bg-${colorTok(v)}`;
      case 'fill': return v === 'none' ? 'fill-none' : `fill-${colorTok(v)}`;
      case 'stroke': return v === 'none' ? 'stroke-none' : `stroke-${colorTok(v)}`;
      case 'stroke-width': n = num(v) ?? px(v); return n != null && Number.isInteger(n) ? `stroke-${n}` : `stroke-${arb(v)}`;
      case 'accent-color': return `accent-${colorTok(v)}`;
      case 'text-decoration-color': return `decoration-${colorTok(v)}`;
      case 'outline-color': return `outline-${colorTok(v)}`;
      case 'outline-width': n = px(v); return n != null && Number.isInteger(n) ? (n === 1 ? 'outline' : `outline-${n}`) : `outline-${arb(v)}`;
      case 'outline-offset': n = px(v); return n != null && Number.isInteger(n) ? cls('outline-offset', String(n)) : `outline-offset-${arb(v)}`;
      case 'font-weight': return FW[v] ? `font-${FW[v]}` : num(v) != null ? `font-[${v}]` : null;
      case 'font-family': return arbProp('font-family', v);
      case 'font-size': return textSize(v, null);
      case 'line-height': return `leading-${leadingTok(v)}`;
      case 'letter-spacing': return `tracking-${TRACKING[v] || arb(v)}`;
      case 'box-shadow': v = cleanShadow(v); return v === 'none' ? 'shadow-none' : `shadow-${arb(compactColors(v))}`;
      case 'background-image': return v === 'none' ? 'bg-none' : `bg-${arb(v)}`;
      case 'background-size': return `bg-[length:${arbInner(v.replace(/ auto$/, ''))}]`;
      case 'aspect-ratio': {
        const a = v.replace(/\s+/g, '');
        if (a === '1/1' || a === '1') return 'aspect-square';
        if (a === '16/9') return 'aspect-video';
        if (a === 'auto') return 'aspect-auto';
        return /^[\d.]+\/[\d.]+$/.test(a) ? `aspect-[${a}]` : null;
      }
      case 'grid-template-columns': case 'grid-template-rows': {
        const pre = p === 'grid-template-columns' ? 'grid-cols' : 'grid-rows';
        if (v === 'none') return `${pre}-none`;
        if (v === 'subgrid') return `${pre}-subgrid`;
        m = /^repeat\((\d+),\s*minmax\(0(px)?,\s*1fr\)\)$/.exec(v);
        if (m) return `${pre}-${m[1]}`;
        const tracks = v.split(/\s+/);
        if (tracks.length > 2 && !/[()[\]]/.test(v) && tracks.every((t) => t === tracks[0])) return `${pre}-[repeat(${tracks.length},${tracks[0]})]`;
        return `${pre}-${arb(v)}`;
      }
      case 'grid-auto-columns': return `auto-cols-${v === 'auto' ? 'auto' : v === 'min-content' ? 'min' : v === 'max-content' ? 'max' : arb(v)}`;
      case 'grid-auto-rows': return `auto-rows-${v === 'auto' ? 'auto' : v === 'min-content' ? 'min' : v === 'max-content' ? 'max' : arb(v)}`;
      case 'cursor': return /^[a-z-]+$/.test(v) ? `cursor-${v}` : null;
      case 'text-decoration-thickness': n = px(v); return v === 'auto' ? 'decoration-auto' : v === 'from-font' ? 'decoration-from-font' : n != null && Number.isInteger(n) ? `decoration-${n}` : `decoration-${arb(v)}`;
      case 'text-underline-offset': n = px(v); return v === 'auto' ? 'underline-offset-auto' : n != null && Number.isInteger(n) ? cls('underline-offset', String(n)) : `underline-offset-${arb(v)}`;
      case 'text-indent': return cls('indent', spaceTok(v));
      case 'backdrop-filter': m = /^blur\(([^()]+)\)$/.exec(v); return m ? `backdrop-blur-[${m[1]}]` : null;
      case 'filter': m = /^blur\(([^()]+)\)$/.exec(v); return m ? `blur-[${m[1]}]` : null;
      case 'mix-blend-mode': return /^[a-z-]+$/.test(v) ? `mix-blend-${v}` : null;
      case 'transform': return v === 'none' ? 'transform-none' : transformTok(v);
      case 'column-count': n = num(v); return n != null ? `columns-${n}` : null;
      case 'content': return `content-[${arbInner(v, true)}]`;
      default: return null;
    }
  }

  /** Single-function transforms → Tailwind's transform utilities (they render identically on their own). */
  function transformTok(v) {
    const fns = [...v.matchAll(/([a-zA-Z0-9]+)\(([^()]*)\)/g)];
    if (!fns.length || fns.map((f) => f[0]).join(' ') !== v.trim()) return null;
    const out = [];
    for (const [, fn, arg] of fns) {
      const a = arg.split(/\s*,\s*/);
      if (fn === 'rotate' && /^-?\d*\.?\d+deg$/.test(a[0])) {
        const d = parseFloat(a[0]);
        out.push([0, 1, 2, 3, 6, 12, 45, 90, 180].includes(Math.abs(d)) ? cls('rotate', String(d)) : `rotate-[${a[0]}]`);
      } else if (fn === 'translateX') out.push(cls('translate-x', spaceTok(a[0])));
      else if (fn === 'translateY') out.push(cls('translate-y', spaceTok(a[0])));
      else if (fn === 'translate' && a.length <= 2) { out.push(cls('translate-x', spaceTok(a[0]))); out.push(cls('translate-y', spaceTok(a[1] ?? '0px'))); }
      else if (fn === 'scale' && a.length === 1 && num(a[0]) != null && Number.isInteger(num(a[0]) * 100)) out.push(`scale-${Math.round(num(a[0]) * 100)}`);
      else return null;
    }
    return out.join(' ');
  }

  /** Emit Tailwind utilities for one style object, optionally under a variant (hover:, before:, …). */
  function tw(s, variant = '') {
    if (!s) return [];
    const m = new Map(Object.entries(s).map(([p, v]) => [p, cleanValue(p, v)]));
    const out = [];
    const add = (c) => { if (c) for (const x of c.split(' ')) if (x) out.push(variant + x); };
    const get = (p) => m.get(p);
    const del = (...ps) => ps.forEach((p) => m.delete(p));
    const take = (p) => { const v = m.get(p); m.delete(p); return v; };

    // whole-pattern utilities
    const clip = `${get('clip') || ''} ${get('clip-path') || ''}`;
    if (get('position') === 'absolute' && px(get('width')) === 1 && px(get('height')) === 1 && get('overflow-x') === 'hidden' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)|inset\(50%\)/.test(clip)) {
      add('sr-only');
      del('position', 'width', 'height', 'overflow-x', 'overflow-y', 'clip', 'clip-path', 'white-space-collapse', 'text-wrap-mode');
      for (const sd of ['top', 'right', 'bottom', 'left']) { del(`padding-${sd}`); if (px(get(`margin-${sd}`)) === -1) del(`margin-${sd}`); if (px(get(`border-${sd}-width`)) === 0) del(`border-${sd}-width`); }
    }
    if (get('text-overflow') === 'ellipsis' && get('overflow-x') === 'hidden' && get('text-wrap-mode') === 'nowrap') {
      add('truncate');
      del('text-overflow', 'overflow-x', 'text-wrap-mode');
      if (get('overflow-y') === 'hidden') del('overflow-y');
      if (get('white-space-collapse') === 'collapse') del('white-space-collapse');
    }
    const lc = get('-webkit-line-clamp');
    if (lc && /^\d+$/.test(lc)) {
      add(`line-clamp-${lc}`);
      del('-webkit-line-clamp', '-webkit-box-orient');
      if (get('display') === '-webkit-box') del('display');
      if (get('overflow-x') === 'hidden' && get('overflow-y') === 'hidden') del('overflow-x', 'overflow-y');
    }

    // layout
    if (m.has('position')) add(single('position', take('position')) || arbProp('position', get('position')));
    sides(m, ['top', 'right', 'bottom', 'left'], { all: 'inset', x: 'inset-x', y: 'inset-y', t: 'top', r: 'right', b: 'bottom', l: 'left' }, spaceTok, add);
    if (m.has('z-index')) { const v = take('z-index'); add(single('z-index', v) || arbProp('z-index', v)); }
    if (m.has('display')) { const v = take('display'); add(single('display', v) || arbProp('display', v)); }

    // flex
    if (m.has('flex-grow') && m.has('flex-shrink') && m.has('flex-basis')) {
      const key = `${get('flex-grow')} ${get('flex-shrink')} ${get('flex-basis')}`;
      const named = { '1 1 0%': 'flex-1', '1 1 0px': 'flex-1', '1 1 auto': 'flex-auto', '0 0 auto': 'flex-none', '0 1 auto': 'flex-initial' }[key];
      if (named) { add(named); del('flex-grow', 'flex-shrink', 'flex-basis'); }
    }
    for (const p of ['flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order']) {
      if (m.has(p)) { const v = take(p); add(single(p, v) || arbProp(p, v)); }
    }

    // grid placement
    for (const g of ['column', 'row']) {
      const pre = g === 'column' ? 'col' : 'row';
      const s0 = get(`grid-${g}-start`), e0 = get(`grid-${g}-end`);
      if (s0 == null && e0 == null) continue;
      del(`grid-${g}-start`, `grid-${g}-end`);
      let sm;
      if (s0 === '1' && e0 === '-1') { add(`${pre}-span-full`); continue; }
      if (s0 && (sm = /^span (\d+)$/.exec(s0)) && (!e0 || e0 === 'auto')) { add(`${pre}-span-${sm[1]}`); continue; }
      if (s0 && s0 !== 'auto') add(/^-?\d+$/.test(s0) ? cls(`${pre}-start`, s0) : `${pre}-start-${arb(s0)}`);
      if (e0 && e0 !== 'auto') add(/^-?\d+$/.test(e0) ? cls(`${pre}-end`, e0) : `${pre}-end-${arb(e0)}`);
    }

    // alignment & gaps
    for (const p of ['justify-content', 'justify-items', 'justify-self', 'align-content', 'align-items', 'align-self']) {
      if (m.has(p)) { const v = take(p); add(single(p, v) || arbProp(p, v)); }
    }
    if (m.has('row-gap') || m.has('column-gap')) {
      const r = take('row-gap'), c = take('column-gap');
      if (r != null && r === c) add(cls('gap', spaceTok(r)));
      else {
        if (c != null) add(c === 'normal' ? arbProp('column-gap', c) : cls('gap-x', spaceTok(c)));
        if (r != null) add(r === 'normal' ? arbProp('row-gap', r) : cls('gap-y', spaceTok(r)));
      }
    }

    // sizing
    if (m.has('width') && m.has('height') && sizeTok(get('width'), 'w') === sizeTok(get('height'), 'h') && !/^(screen|dvh|svh|lvh)$/.test(sizeTok(get('height'), 'h'))) {
      add(cls('size', sizeTok(take('width'), 'w')));
      del('height');
    }
    for (const p of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio']) {
      if (m.has(p)) { const v = take(p); add(single(p, v) || arbProp(p, v)); }
    }

    // spacing
    sides(m, ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], { all: 'm', x: 'mx', y: 'my', t: 'mt', r: 'mr', b: 'mb', l: 'ml' }, spaceTok, add);
    sides(m, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'], { all: 'p', x: 'px', y: 'py', t: 'pt', r: 'pr', b: 'pb', l: 'pl' }, spaceTok, add);

    // overflow
    if (m.has('overflow-x') || m.has('overflow-y')) {
      const x = take('overflow-x'), y = take('overflow-y');
      if (x != null && x === y) add(`overflow-${x}`);
      else { if (x != null) add(`overflow-x-${x}`); if (y != null) add(`overflow-y-${y}`); }
    }

    // borders
    const BP = { all: 'border', x: 'border-x', y: 'border-y', t: 'border-t', r: 'border-r', b: 'border-b', l: 'border-l' };
    sides(m, ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'], BP, bwTok, add);
    const styles = ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'];
    if (styles.every((p) => m.has(p)) && styles.every((p) => get(p) === get(styles[0]))) {
      const v = get(styles[0]);
      del(...styles);
      if (v !== 'solid') add(['dashed', 'dotted', 'double', 'none', 'hidden'].includes(v) ? `border-${v}` : arbProp('border-style', v));
    }
    sides(m, ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'], BP, colorTok, add);
    corners(m, add);

    // backgrounds
    if (m.has('background-position-x') && m.has('background-position-y')) {
      const pos = `${take('background-position-x')} ${take('background-position-y')}`.replace(/\b0px\b/g, '0%');
      const named = { '50% 50%': 'bg-center', '0% 0%': null, '50% 0%': 'bg-top', '50% 100%': 'bg-bottom', '0% 50%': 'bg-left', '100% 50%': 'bg-right' }[pos];
      if (named !== null) add(named || arbProp('background-position', pos));
    }

    // typography
    if (m.has('font-size')) {
      const fs = take('font-size');
      add(textSize(fs, m.has('line-height') ? take('line-height') : null));
    }
    const ws = whiteSpaceOf(get('white-space-collapse'), get('text-wrap-mode'));
    if (ws && (m.has('white-space-collapse') || m.has('text-wrap-mode'))) { del('white-space-collapse', 'text-wrap-mode'); add(KW['white-space'][ws]); }

    // motion
    const tr = transitionShorthand(m);
    if (tr) add(arbProp('transition', tr));
    const an = animationShorthand(m);
    if (an) add(arbProp('animation', an));

    const rest = [...m.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0]));
    for (const [p, v] of rest) add(single(p, v) || arbProp(p, compactColors(v)));
    return out;
  }

  function sides(m, props, names, tok, add) {
    const vals = props.map((p) => m.get(p));
    const present = vals.map((v) => v !== undefined);
    if (!present.some(Boolean)) return;
    props.forEach((p) => m.delete(p));
    const [t, r, b, l] = vals;
    if (present.every(Boolean) && t === r && r === b && b === l) { add(cls(names.all, tok(t))); return; }
    if (present[1] && present[3] && r === l) { add(cls(names.x, tok(r))); present[1] = present[3] = false; }
    if (present[0] && present[2] && t === b) { add(cls(names.y, tok(t))); present[0] = present[2] = false; }
    ['t', 'r', 'b', 'l'].forEach((k, i) => { if (present[i]) add(cls(names[k], tok(vals[i]))); });
  }

  function corners(m, add) {
    const P = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    const v = P.map((p) => m.get(p));
    const has = v.map((x) => x !== undefined);
    if (!has.some(Boolean)) return;
    P.forEach((p) => m.delete(p));
    const [tl, tr, br, bl] = v;
    if (has.every(Boolean) && tl === tr && tr === br && br === bl) { add(cls('rounded', radTok(tl))); return; }
    const pairs = [['t', 0, 1], ['b', 3, 2], ['l', 0, 3], ['r', 1, 2]];
    for (const [k, a, b] of pairs) {
      if (has[a] && has[b] && v[a] === v[b]) { add(cls(`rounded-${k}`, radTok(v[a]))); has[a] = has[b] = false; }
    }
    ['tl', 'tr', 'br', 'bl'].forEach((k, i) => { if (has[i]) add(cls(`rounded-${k}`, radTok(v[i]))); });
  }

  function twFor(n) {
    const out = tw(n.s);
    for (const [st, s] of Object.entries(n.st || {})) out.push(...tw(s, `${st}:`));
    for (const [pe, s] of Object.entries(n.pe || {})) out.push(...tw(s, `${pe}:`));
    return [...new Set(out)].join(' ');
  }

  // ------------------------------------------------------------ naming

  const TAG_NAMES = { div: 'box', span: 'text', a: 'link', button: 'button', img: 'image', svg: 'icon', li: 'item', ul: 'list', ol: 'list', p: 'paragraph', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'nav', header: 'header', footer: 'footer', section: 'section', article: 'card', input: 'input', label: 'label', form: 'form', table: 'table', tr: 'row', td: 'cell', th: 'headCell', strong: 'strong', em: 'em', small: 'small', code: 'code', pre: 'pre', figure: 'figure', figcaption: 'caption', main: 'main', aside: 'aside', hr: 'divider', select: 'select', textarea: 'textarea', path: 'path' };
  function camel(s) {
    s = String(s).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
    s = s.replace(/^[A-Z]/, (c) => c.toLowerCase());
    return /^[a-z]/.test(s) ? s : `c${s}`;
  }
  function pascal(s) { const c = camel(s); return c[0].toUpperCase() + c.slice(1); }
  function uniqueName(name, used) {
    let n = name, i = 2;
    while (used.has(n)) n = `${name}${i++}`;
    used.add(n);
    return n;
  }
  function plural(name) {
    if (/(s|x|ch|sh)$/.test(name)) return `${name}es`;
    if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
    return `${name}s`;
  }

  // ------------------------------------------------------------ context: classes per node

  const sortObj = (o) => (o ? Object.keys(o).sort().map((k) => [k, o[k]]) : null);
  const styleKey = (n) => JSON.stringify([sortObj(n.s), n.st ? Object.keys(n.st).sort().map((k) => [k, sortObj(n.st[k])]) : null, n.pe ? Object.keys(n.pe).sort().map((k) => [k, sortObj(n.pe[k])]) : null]);
  const EMPTY_KEY = JSON.stringify([null, null, null]);

  function buildCtx(root) {
    const ctx = { cls: new Map(), tw: new Map(), key: new Map(), classes: [] };
    const byKey = new Map();
    const used = new Set(['root']);
    const visit = (n, isRoot) => {
      const key = styleKey(n);
      ctx.key.set(n, key);
      let name = '';
      if (isRoot) { name = 'root'; ctx.classes.push({ name, node: n }); }
      else if (!n.svg || key !== EMPTY_KEY) {
        if (key === EMPTY_KEY) name = '';
        else if (byKey.has(key)) name = byKey.get(key);
        else {
          name = uniqueName(n.h ? camel(n.h) : (TAG_NAMES[n.tag.toLowerCase()] || camel(n.tag)), used);
          byKey.set(key, name);
          ctx.classes.push({ name, node: n });
        }
      }
      ctx.cls.set(n, name);
      ctx.tw.set(n, twFor(n));
      for (const k of kidsOf(n)) if (isEl(k)) visit(k, false);
    };
    visit(root, true);
    return ctx;
  }

  function cssFor(ctx, model, { base = true } = {}) {
    const blocks = [];
    if (base) blocks.push(`/* scoped reset (Tailwind preflight) */\n${G.SNAG_BASE_CSS.trim()}`);
    for (const { name, node } of ctx.classes) {
      blocks.push(cssBlock(`.${name}`, cssDecls(node.s)));
      for (const [st, s] of Object.entries(node.st || {})) blocks.push(cssBlock(`.${name}:${st}`, cssDecls(s)));
      for (const [pe, s] of Object.entries(node.pe || {})) blocks.push(cssBlock(`.${name}::${pe}`, cssDecls(s)));
    }
    for (const k of model.keyframes || []) blocks.push(k);
    for (const f of model.fontFaces || []) blocks.push(f);
    return blocks.filter(Boolean).join('\n\n') + '\n';
  }

  // ------------------------------------------------------------ repeated siblings → .map()

  function planMaps(root, ctx) {
    const plan = new Map();
    const sigCache = new Map();
    const usedNames = new Set();
    const sig = (n) => {
      let s = sigCache.get(n);
      if (s) return s;
      const attrs = (n.a || []).map(([k, v]) => (VARY.has(k) ? k : `${k}=${v}`)).sort().join('&');
      s = `${n.tag}|${ctx.key.get(n)}|${attrs}|${kidsOf(n).map((k) => (isEl(k) ? sig(k) : 'T')).join(',')}`;
      sigCache.set(n, s);
      return s;
    };
    const visit = (n) => {
      const kids = kidsOf(n);
      const runs = [];
      let i = 0;
      while (i < kids.length) {
        if (!isEl(kids[i]) || n.svg) { i++; continue; }
        const s = sig(kids[i]);
        let j = i + 1;
        while (j < kids.length && isEl(kids[j]) && sig(kids[j]) === s) j++;
        if (j - i >= 3) { runs.push(makeRun(kids.slice(i, j), i, j, usedNames, n)); i = j; continue; }
        i++;
      }
      if (runs.length) plan.set(n, runs);
      const inRun = (idx) => runs.some((r) => idx >= r.start && idx < r.end);
      kids.forEach((k, idx) => { if (isEl(k) && !inRun(idx)) visit(k); });
    };
    visit(root);
    return plan;
  }

  /** Name for a mapped array: the list container's class (`nav__links` → navLinks), else the item's, else its tag. */
  function arrayName(parent, first) {
    const hintIn = (n) => { if (n.h) return n.h; for (const k of kidsOf(n)) if (isEl(k)) { const h = hintIn(k); if (h) return h; } return null; };
    const strip = (h) => camel(h.replace(/^.*__/, (m) => (m.length > 2 ? '' : m)) || h);
    if (parent.h && /[a-z]s$/i.test(parent.h)) return camel(parent.h.replace(/__/g, '-'));
    if (first.h) return plural(strip(first.h));
    const inner = hintIn(first);
    if (inner) return plural(camel(inner.replace(/__/g, '-')));
    return plural({ li: 'item', a: 'link', button: 'button', article: 'card', tr: 'row', img: 'image', svg: 'icon' }[first.tag.toLowerCase()] || 'item');
  }

  function makeRun(items, start, end, usedNames, parent) {
    const leaves = [];
    const walk = (n, path) => {
      for (const [k] of n.a || []) if (VARY.has(k)) leaves.push({ kind: 'attr', name: k, path });
      kidsOf(n).forEach((c, i) => {
        if (isEl(c)) walk(c, [...path, i]);
        else leaves.push({ kind: 'text', path: [...path, i] });
      });
    };
    walk(items[0], []);
    const at = (n, path) => path.reduce((x, i) => kidsOf(x)[i], n);
    const valueOf = (item, leaf) => {
      const node = at(item, leaf.path);
      if (leaf.kind === 'text') return node.t;
      return (node.a.find(([k]) => k === leaf.name) || [])[1];
    };
    const variable = leaves.filter((leaf) => {
      const vals = items.map((it) => (leaf.kind === 'text' ? valueOf(it, leaf).trim() : valueOf(it, leaf)));
      return vals.some((v) => v !== vals[0]);
    });
    const names = new Set();
    const textLeaves = variable.filter((l) => l.kind === 'text');
    const TEXT_NAMES = textLeaves.length === 1 ? ['label'] : ['title', 'description', 'detail', 'meta'];
    for (const leaf of variable) {
      let base;
      if (leaf.kind === 'text') base = TEXT_NAMES[textLeaves.indexOf(leaf)] || `text${textLeaves.indexOf(leaf) + 1}`;
      else base = { srcset: 'srcSet', 'aria-label': 'ariaLabel', src: 'src', href: 'href', alt: 'alt', title: 'tooltip', datetime: 'dateTime' }[leaf.name] || camel(leaf.name);
      leaf.field = uniqueName(base, names);
    }
    const data = items.map((it) => Object.fromEntries(variable.map((leaf) => [leaf.field, leaf.kind === 'text' ? valueOf(it, leaf).trim() : valueOf(it, leaf)])));
    const keyField = ['href', 'label', 'title', ...variable.map((l) => l.field)].find((f) => {
      const vals = data.map((d) => d[f]);
      return vals[0] !== undefined && vals.every((v) => v) && new Set(vals).size === vals.length;
    });

    // template = first item with variable leaves marked
    const clone = (n, path) => {
      const c = { ...n };
      if (n.a) c.a = n.a.map(([k, v]) => {
        const leaf = variable.find((l) => l.kind === 'attr' && l.name === k && l.path.join() === path.join());
        return leaf ? [k, v, leaf.field] : [k, v];
      });
      if (n.k) c.k = n.k.map((k, i) => {
        if (isEl(k)) return clone(k, [...path, i]);
        const leaf = variable.find((l) => l.kind === 'text' && l.path.join() === [...path, i].join());
        return leaf ? { ...k, field: leaf.field } : k;
      });
      return c;
    };
    const first = items[0];
    const arrName = uniqueName(arrayName(parent, first), usedNames);
    return { start, end, count: items.length, template: clone(first, []), data, fields: variable.map((l) => l.field), keyField, arrName, origin: items[0] };
  }

  // ------------------------------------------------------------ JSX

  const JSX_ATTR = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', srcset: 'srcSet', crossorigin: 'crossOrigin', autocomplete: 'autoComplete', autofocus: 'autoFocus', autoplay: 'autoPlay', playsinline: 'playsInline', datetime: 'dateTime', enterkeyhint: 'enterKeyHint', inputmode: 'inputMode', referrerpolicy: 'referrerPolicy', allowfullscreen: 'allowFullScreen', spellcheck: 'spellCheck', novalidate: 'noValidate', contenteditable: 'contentEditable', accesskey: 'accessKey', usemap: 'useMap', frameborder: 'frameBorder' };
  function jsxAttrName(n, node) {
    if (node.svg) {
      if (n === 'class') return 'className';
      if (n.startsWith('data-') || n.startsWith('aria-')) return n;
      if (n === 'xmlns:xlink') return 'xmlnsXlink';
      return n.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
    }
    const t = node.tag.toLowerCase();
    if (n === 'value' && (t === 'input' || t === 'textarea' || t === 'select')) return 'defaultValue';
    if (n === 'checked') return 'defaultChecked';
    return JSX_ATTR[n] || n;
  }
  const jsxStr = (v) => (/["\\\n{}]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`);
  function jsxAttr(n, v, field, node, itemVar) {
    const name = jsxAttrName(n, node);
    if (field) return `${name}={${itemVar}.${field}}`;
    if (v === '' && BOOL_ATTRS.has(n)) return name;
    return `${name}=${jsxStr(v)}`;
  }
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/ /g, '&nbsp;');
  function jsxText(k, itemVar) {
    if (k.pre) return `{${JSON.stringify(k.t)}}`;
    const t = k.t;
    const lead = t.startsWith(' ') && t.length > 0, trail = t.endsWith(' ') && t.length > 1;
    const core = t.trim();
    if (!core && !k.field) return '{" "}';
    const body = k.field ? `{${itemVar}.${k.field}}` : escText(core);
    return `${lead ? '{" "}' : ''}${body}${trail ? '{" "}' : ''}`;
  }

  const twAttr = (c) => `className=${c.includes('"') ? `{${JSON.stringify(c)}}` : `"${c}"`}`;

  function renderJsx(n, depth, env) {
    const pad = '  '.repeat(depth);
    const orig = n.__orig || n;
    const comp = env.mode === 'tw' && !n.svg ? env.comps?.get(`${n.tag}|${env.ctx.tw.get(orig)}`) : null;
    if (comp) comp.used = true;
    const tag = comp ? comp.name : n.tag;
    const attrs = [];
    if (env.key) attrs.push(`key={${env.key}}`);
    if (comp) { /* class lives in the local component */ }
    else if (env.mode === 'tw') { const c = env.ctx.tw.get(orig); if (c) attrs.push(twAttr(c)); }
    else { const c = env.ctx.cls.get(orig); if (c) attrs.push(`className={s.${c}}`); }
    for (const [k, v, field] of n.a || []) {
      if (k === 'selected' && !field) continue;
      attrs.push(jsxAttr(k, v, field, n, env.itemVar));
    }
    const inner = { ...env, key: null };
    const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    const kids = kidsOf(n);
    if (!kids.length) return [`${pad}${open} />`];
    const runs = env.plan.get(orig) || [];
    if (!runs.length && kids.every((k) => !isEl(k))) {
      const text = kids.map((k) => jsxText(k, env.itemVar)).join('');
      if (text.length + open.length + pad.length < 110) return [`${pad}${open}>${text}</${tag}>`];
    }
    const lines = [`${pad}${open}>`];
    for (let i = 0; i < kids.length; i++) {
      const run = runs.find((r) => r.start === i);
      if (run) {
        lines.push(...renderRun(run, depth + 1, inner));
        i = run.end - 1;
        continue;
      }
      const k = kids[i];
      if (isEl(k)) lines.push(...renderJsx(k, depth + 1, inner));
      else lines.push(`${pad}  ${jsxText(k, env.itemVar)}`);
    }
    lines.push(`${pad}</${tag}>`);
    return lines;
  }

  function attachOrig(t, o) {
    t.__orig = o;
    const tk = kidsOf(t), ok = kidsOf(o);
    tk.forEach((k, i) => { if (isEl(k)) attachOrig(k, ok[i]); });
    return t;
  }

  function renderRun(run, depth, env) {
    const pad = '  '.repeat(depth);
    env.arrays.set(run.arrName, run);
    const tpl = attachOrig(run.template, run.origin);
    if (!run.fields.length) {
      const body = renderJsx(tpl, depth + 1, { ...env, key: 'i' });
      return [`${pad}{Array.from({ length: ${run.count} }, (_, i) => (`, ...body, `${pad}))}`];
    }
    const key = run.keyField ? `item.${run.keyField}` : 'i';
    const body = renderJsx(tpl, depth + 1, { ...env, key, itemVar: 'item' });
    return [`${pad}{${run.arrName}.map((item${run.keyField ? '' : ', i'}) => (`, ...body, `${pad}))}`];
  }

  function formatArray(run) {
    const rows = run.data.map((d) => {
      const one = `{ ${Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v ?? '')}`).join(', ')} }`;
      if (one.length < 96) return `  ${one},`;
      return `  {\n${Object.entries(d).map(([k, v]) => `    ${k}: ${JSON.stringify(v ?? '')},`).join('\n')}\n  },`;
    });
    return `const ${run.arrName} = [\n${rows.join('\n')}\n];`;
  }

  const COMP_NAMES = { a: 'Link', button: 'Button', li: 'Item', td: 'Cell', th: 'HeaderCell', span: 'Text', p: 'Paragraph', div: 'Box', img: 'Image', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', input: 'Input', label: 'Label', tr: 'Row', ul: 'List', section: 'Section', article: 'Card' };

  /** Tag + long Tailwind string used 3+ times → a tiny local component (`<Link href=…>`). */
  function findComponents(root, ctx, taken) {
    const counts = new Map();
    const visit = (n, isRoot) => {
      if (!isRoot && !n.svg) {
        const c = ctx.tw.get(n);
        if (c && c.length >= 30) {
          const key = `${n.tag}|${c}`;
          const e = counts.get(key) || { n: 0, node: n, hints: new Set() };
          e.n++;
          e.hints.add(n.h || '');
          counts.set(key, e);
        }
      }
      for (const k of kidsOf(n)) if (isEl(k)) visit(k, false);
    };
    visit(root, true);
    const comps = new Map();
    for (const [key, { n, node, hints }] of counts) {
      if (n < 3) continue;
      const shared = hints.size === 1 ? [...hints][0] : '';
      const base = shared ? pascal(shared) : (COMP_NAMES[node.tag.toLowerCase()] || pascal(node.tag));
      comps.set(key, { name: uniqueName(base, taken), tag: node.tag, cls: ctx.tw.get(node), used: false });
    }
    return comps;
  }

  function emitReact(model, ctx, plan, mode, name) {
    const comps = mode === 'tw' ? findComponents(model.root, ctx, new Set([name])) : null;
    const env = { mode, ctx, plan, comps, arrays: new Map(), itemVar: 'item', key: null };
    const body = renderJsx(model.root, 2, env);
    let code = '';
    if (mode === 'css') code += `import s from "./${name}.module.css";\n\n`;
    for (const run of env.arrays.values()) if (run.fields.length) code += `${formatArray(run)}\n\n`;
    for (const c of comps?.values() || []) {
      if (!c.used) continue;
      code += `function ${c.name}(props) {\n  return <${c.tag} ${twAttr(c.cls)} {...props} />;\n}\n\n`;
    }
    code += `export default function ${name}() {\n  return (\n${body.join('\n')}\n  );\n}\n`;
    return code;
  }

  // ------------------------------------------------------------ HTML

  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  function renderHtml(n, depth, ctx, pretty, classOf = (x) => ctx.cls.get(x)) {
    const pad = pretty ? '  '.repeat(depth) : '';
    const c = classOf(n);
    const attrs = [];
    if (c) attrs.push(`class="${c}"`);
    for (const [k, v] of n.a || []) attrs.push(v === '' && BOOL_ATTRS.has(k) ? k : `${k}="${escAttr(String(v))}"`);
    const open = `<${n.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    const kids = kidsOf(n);
    if (!n.svg && VOID.has(n.tag.toLowerCase())) return `${pad}${open}`;
    if (!kids.length) return `${pad}${open}</${n.tag}>`;
    // whitespace between inline content is significant: only break lines between block children
    const breakable = pretty && kids.every((k) => isEl(k) && !k.inl);
    if (!breakable) return `${pad}${open}${kids.map((k) => (isEl(k) ? renderHtml(k, 0, ctx, false, classOf) : escHtml(k.t))).join('')}</${n.tag}>`;
    return `${pad}${open}\n${kids.map((k) => renderHtml(k, depth + 1, ctx, true, classOf)).join('\n')}\n${pad}</${n.tag}>`;
  }

  // ------------------------------------------------------------ entry

  function emitAll(model, opts = {}) {
    const name = pascal(opts.name || model.suggestedName || 'Snagged');
    const ctx = buildCtx(model.root);
    const plan = opts.maps === false ? new Map() : planMaps(model.root, ctx);
    const moduleCss = cssFor(ctx, model);
    const html = renderHtml(model.root, 0, ctx, true);
    const extras = [...(model.keyframes || []), ...(model.fontFaces || [])].join('\n\n');

    const tailwindFiles = [{ name: `${name}.jsx`, lang: 'jsx', code: emitReact(model, ctx, plan, 'tw', name) }];
    if (extras) tailwindFiles.push({ name: 'snag-extras.css', lang: 'css', code: `/* Add to your global CSS (fonts / keyframes used by ${name}) */\n${extras}\n` });

    const previewCss = model.previewFontFaces ? cssFor(ctx, { ...model, fontFaces: model.previewFontFaces }) : moduleCss;
    const previewDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${model.background || '#fff'};}
.snag-wrap{width:${model.width}px;display:flow-root;}
${previewCss}</style></head><body><div class="snag-wrap">${renderHtml(model.root, 0, ctx, false)}</div></body></html>`;

    return {
      name,
      tailwind: tailwindFiles,
      module: [
        { name: `${name}.jsx`, lang: 'jsx', code: emitReact(model, ctx, plan, 'css', name) },
        { name: `${name}.module.css`, lang: 'css', code: moduleCss },
      ],
      html: [
        { name: `${camel(name)}.html`, lang: 'html', code: `${html}\n` },
        { name: `${camel(name)}.css`, lang: 'css', code: moduleCss },
      ],
      previewDoc,
      // same markup with Tailwind classes (used by the test harness to verify the Tailwind translation)
      tailwindHtml: renderHtml(model.root, 0, ctx, false, (x) => ctx.tw.get(x)),
      stats: { classes: ctx.classes.length, maps: [...plan.values()].reduce((a, r) => a + r.length, 0) },
    };
  }

  G.SnagEmit = { emitAll, _internals: { tw, cssDecls, colorTok, spaceTok, textSize, cleanShadow } };
})(globalThis);
