/*
 * Snag UI — element picker overlay.
 * A transparent full-screen "catcher" sits above the page so nothing on the page
 * gets :hover / clicks while you pick; the element under the cursor is found
 * with elementsFromPoint().
 */
(() => {
  if (globalThis.__snagPicker) return;

  const ACCENT = '#7c5cff';
  let host = null, shadow = null, ui = null;
  let active = false, busy = false, current = null;
  const downStack = [];

  const CSS = `
    :host { all: initial; }
    .catcher { position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair; background: transparent; }
    .box { position: fixed; z-index: 2147483647; pointer-events: none; border: 2px solid ${ACCENT};
      background: color-mix(in srgb, ${ACCENT} 12%, transparent); border-radius: 3px; display: none;
      transition: all 60ms ease-out; box-sizing: border-box; }
    .tag { position: absolute; left: -2px; bottom: calc(100% + 4px); white-space: nowrap; font: 600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #fff; background: ${ACCENT}; padding: 1px 6px; border-radius: 4px; }
    .tag.below { bottom: auto; top: calc(100% + 4px); }
    .tag b { font-weight: 400; opacity: .8; margin-left: 6px; }
    .bar { position: fixed; z-index: 2147483647; left: 50%; bottom: 18px; transform: translateX(-50%); pointer-events: none;
      font: 500 12.5px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #f4f2ff; background: rgba(20, 16, 36, .92);
      padding: 10px 14px; border-radius: 999px; box-shadow: 0 8px 30px rgba(0,0,0,.35); display: flex; gap: 12px; align-items: center; }
    .bar .logo { font-weight: 700; color: #b9a8ff; }
    .bar kbd { font: inherit; font-size: 11px; background: rgba(255,255,255,.12); padding: 3px 6px; border-radius: 5px; margin-right: 3px; }
    .toast { position: fixed; z-index: 2147483647; right: 18px; top: 18px; pointer-events: none; display: none;
      font: 500 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #f4f2ff; background: rgba(20, 16, 36, .94);
      padding: 10px 14px; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); max-width: 360px; }
    .toast.err { background: #8a1c2b; }
  `;

  function mount() {
    if (host) return;
    host = document.createElement('snag-ui-overlay');
    shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const st = document.createElement('style');
      st.textContent = CSS;
      shadow.appendChild(st);
    }
    const el = (cls, parent = shadow) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
    ui = { catcher: el('catcher'), box: el('box'), bar: el('bar'), toast: el('toast') };
    ui.tag = el('tag', ui.box);
    const parts = [['logo', 'Snag UI'], [null, 'click to capture'], [null, '↑↓ parent / child'], [null, '⇧ keep hidden menus'], [null, 'esc to cancel']];
    for (const [cls, text] of parts) {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      if (text.startsWith('↑↓')) { const k = document.createElement('kbd'); k.textContent = '↑↓'; s.append(k, text.slice(2)); }
      else if (text.startsWith('⇧')) { const k = document.createElement('kbd'); k.textContent = '⇧'; s.append(k, text.slice(1)); }
      else if (text.startsWith('esc')) { const k = document.createElement('kbd'); k.textContent = 'esc'; s.append(k, text.slice(3)); }
      else s.textContent = text;
      ui.bar.appendChild(s);
    }
    (document.documentElement || document.body).appendChild(host);
  }

  function unmount() {
    host?.remove();
    host = shadow = ui = null;
  }

  function show(elm, on) { elm.style.setProperty('display', on ? '' : 'none'); }

  function describe(el) {
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].slice(0, 2).join('.');
    if (cls) s += `.${cls}`;
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }

  function highlight(el) {
    current = el;
    if (!el || !ui) { if (ui) show(ui.box, false); return; }
    const r = el.getBoundingClientRect();
    const b = ui.box.style;
    b.setProperty('display', 'block');
    b.setProperty('left', `${r.left}px`);
    b.setProperty('top', `${r.top}px`);
    b.setProperty('width', `${r.width}px`);
    b.setProperty('height', `${r.height}px`);
    ui.tag.textContent = describe(el);
    const dims = document.createElement('b');
    dims.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
    ui.tag.appendChild(dims);
    ui.tag.classList.toggle('below', r.top < 26);
  }

  function pickAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host || el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  }

  function onMove(e) {
    downStack.length = 0;
    highlight(pickAt(e.clientX, e.clientY));
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (current) snag(current, { includeHidden: e.shiftKey });
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { swallow(e); stop(); return; }
    if (e.key === 'ArrowUp' && current) {
      swallow(e);
      const p = current.parentElement;
      if (p && p !== document.body && p !== document.documentElement) { downStack.push(current); highlight(p); }
    } else if (e.key === 'ArrowDown' && current) {
      swallow(e);
      const next = downStack.pop() || current.firstElementChild;
      if (next) highlight(next);
    } else if (e.key === 'Enter' && current) {
      swallow(e);
      snag(current, { includeHidden: e.shiftKey });
    }
  }
  const onScroll = () => { if (current) highlight(current); };

  function start() {
    if (active || busy) return;
    mount();
    active = true;
    show(ui.catcher, true);
    show(ui.bar, true);
    ui.catcher.addEventListener('mousemove', onMove);
    ui.catcher.addEventListener('click', onClick);
    ui.catcher.addEventListener('mousedown', swallow);
    ui.catcher.addEventListener('contextmenu', swallow);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }

  function stop() {
    active = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    if (!busy) unmount();
  }

  function toggle() { if (active) stop(); else start(); }

  let toastTimer = 0;
  function toast(text, { error = false, ms = 0 } = {}) {
    mount();
    ui.toast.textContent = text;
    ui.toast.classList.toggle('err', error);
    show(ui.toast, true);
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { if (ui) show(ui.toast, false); if (!active && !busy) unmount(); }, ms);
  }

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function snag(el, { includeHidden = false } = {}) {
    if (!el || busy) return { error: 'busy' };
    busy = true;
    active = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    mount();
    // keep the transparent catcher (so nothing is :hover-ed), hide the visuals
    show(ui.box, false);
    show(ui.bar, false);
    show(ui.toast, false);
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch { /* ignore */ }
    await frame();
    const r = el.getBoundingClientRect();
    let shot = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'snag:screenshot', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, vw: innerWidth });
      shot = res?.dataUrl || null;
    } catch { /* screenshots are optional */ }
    toast('Snagging…');
    try {
      const model = await globalThis.__snagExtract.capture(el, {
        exclude: host,
        includeHidden,
        onProgress: (t) => toast(t),
        fetchCss: async (url) => {
          const res = await chrome.runtime.sendMessage({ type: 'snag:fetch-css', url });
          if (!res || res.error) throw new Error(res?.error || 'fetch failed');
          return res.text;
        },
      });
      model.previewFontFaces = await inlineFonts(model.fontFaces);
      const saved = await chrome.runtime.sendMessage({ type: 'snag:save', model, shot });
      if (saved?.error) throw new Error(saved.error);
      toast('Snagged ✓ — opening result', { ms: 1400 });
      return { id: saved.id };
    } catch (err) {
      console.error('[snag]', err);
      toast(`Snag failed: ${err?.message || err}`, { error: true, ms: 5000 });
      return { error: String(err?.message || err) };
    } finally {
      busy = false;
      if (ui) { show(ui.catcher, false); }
      setTimeout(() => { if (!active && !busy && ui && ui.toast.style.display === 'none') unmount(); }, 1600);
    }
  }

  /** Copy of the @font-face rules with font files embedded, so the result-page preview matches. */
  async function inlineFonts(faces, budget = 6_000_000) {
    const out = [];
    for (const css of faces || []) {
      let next = css;
      for (const [, url] of css.matchAll(/url\("?([^")]+)"?\)/g)) {
        if (url.startsWith('data:') || budget <= 0) continue;
        try {
          const res = await chrome.runtime.sendMessage({ type: 'snag:fetch-data-url', url });
          if (res?.dataUrl) { budget -= res.dataUrl.length; next = next.split(url).join(res.dataUrl); }
        } catch { /* keep the remote URL */ }
      }
      out.push(next);
    }
    return out;
  }

  globalThis.__snagPicker = {
    toggle, start, stop, snag,
    snagSelector: (sel) => snag(document.querySelector(sel)),
  };
})();
