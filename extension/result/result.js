/* Snag UI — result page: renders code tabs + live preview for a stored capture. */
(async function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const PREF_KEY = 'snagPrefs';

  const { snagIndex = [] } = await chrome.storage.local.get('snagIndex');
  const id = params.get('id') || snagIndex[0]?.id;
  const record = id ? (await chrome.storage.local.get(`snag:${id}`))[`snag:${id}`] : null;

  renderHistory(snagIndex, id);
  if (!record) {
    $('label').textContent = 'No capture found';
    $('files').innerHTML = '<div class="empty">Click the Snag UI toolbar icon (or press Alt+Shift+S) on any page and pick an element.</div>';
    return;
  }

  const { model, shot } = record;
  const prefs = loadPrefs();
  let tab = prefs.tab || 'tailwind';
  let view = prefs.view || 'both';
  let output = null;

  $('label').textContent = `${model.suggestedName} — ${model.label}`;
  $('url').textContent = model.page.title ? `${model.page.title} · ${model.page.url}` : model.page.url;
  $('url').href = model.page.url;
  document.title = `${model.suggestedName} · Snag UI`;
  $('name').value = model.suggestedName;
  $('maps').checked = prefs.maps !== false;

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab, view, maps: $('maps').checked })); } catch { /* ignore */ }
  }

  function regenerate() {
    const raw = $('name').value.trim();
    output = SnagEmit.emitAll(model, { name: raw || model.suggestedName, maps: $('maps').checked });
    window.__snagOutput = output;
    renderStats();
    renderFiles();
  }

  function kb(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`; }

  function renderStats() {
    const s = model.stats;
    const outBytes = output.tailwind[0].code.length; // the component itself (font/keyframe extras excluded)
    const chips = [
      ['Elements', s.elements],
      ['Rules matched', `${s.rulesMatched} / ${s.rulesOnPage}`],
      ['HTML+CSS → JSX', `${kb(s.origBytes)} → ${kb(outBytes)}`, outBytes < s.origBytes],
      ['Classes', output.stats.classes],
      ['Mapped lists', output.stats.maps],
      ['Layout match', s.fidelity == null ? '—' : `${s.fidelity}%`, s.fidelity >= 95],
      ['Auto-fixed', s.patched],
      ['Pruned', s.pruned],
      ['Time', `${(s.ms / 1000).toFixed(1)}s`],
    ];
    const el = $('stats');
    el.replaceChildren(...chips.map(([k, v, good]) => {
      const c = document.createElement('span');
      c.className = `chip${good ? ' good' : ''}`;
      c.append(`${k} `);
      const b = document.createElement('b');
      b.textContent = String(v);
      c.append(b);
      return c;
    }));
    const w = $('warnings');
    if (s.warnings?.length) {
      const ul = document.createElement('ul');
      for (const t of s.warnings) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
      w.replaceChildren(ul);
      w.hidden = false;
    }
  }

  function renderFiles() {
    for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    const files = output[tab];
    $('files').replaceChildren(...files.map((f) => {
      const wrap = document.createElement('div');
      wrap.className = 'file';
      const head = document.createElement('div');
      head.className = 'file-head';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = `${f.code.split('\n').length} lines · ${kb(f.code.length)}`;
      name.append(meta);
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const copy = button('Copy', 'btn primary', () => copyText(f.code));
      const dl = button('Download', 'btn', () => download(f.name, f.code));
      actions.append(copy, dl);
      head.append(name, actions);
      const pre = document.createElement('pre');
      pre.className = 'code';
      const code = document.createElement('code');
      code.innerHTML = highlight(f.code, f.lang);
      pre.append(code);
      wrap.append(head, pre);
      return wrap;
    }));
  }

  function button(text, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  async function copyText(text) {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  let toastEl;
  function toast(t) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.append(toastEl); }
    toastEl.textContent = t;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  // ---- preview
  function renderPreview() {
    for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    $('stage').dataset.view = view;
    if (shot?.src) {
      $('shot').src = shot.src;
      $('shot').style.width = `${Math.round((model.size.w || 0))}px`;
    } else {
      $('pane-original').querySelector('.canvas').innerHTML = '<div class="empty">No screenshot (the element was off-screen or capture was blocked).</div>';
    }
    const frame = $('preview');
    frame.style.width = `${model.width}px`;
    frame.srcdoc = output.previewDoc;
    frame.onload = fitPreview;
  }

  /** Crop + scale the rebuilt render to the component's own box, matching the screenshot pane. */
  function fitPreview() {
    const frame = $('preview');
    const doc = frame.contentDocument;
    if (!doc) return;
    frame.style.height = `${Math.ceil(doc.documentElement.scrollHeight)}px`;
    const el = doc.querySelector('.snag-wrap > *');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: model.width, height: doc.documentElement.scrollHeight };
    const canvas = $('rebuilt-canvas');
    const scale = Math.min(1, canvas.clientWidth / Math.max(1, r.width));
    $('scaler').style.transform = `scale(${scale}) translate(${-r.left}px, ${-r.top}px)`;
    canvas.style.height = `${Math.ceil(r.height * scale)}px`;
    canvas.style.width = `${Math.ceil(r.width * scale)}px`;
    canvas.style.maxWidth = '100%';
    document.body.dataset.ready = '1';
  }
  window.addEventListener('resize', fitPreview);

  // ---- history
  function renderHistory(index, current) {
    const sel = $('history');
    sel.replaceChildren(...index.map((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      const host = (() => { try { return new URL(e.url).host; } catch { return ''; } })();
      o.textContent = `${e.name || e.label} · ${host} · ${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      if (e.id === current) o.selected = true;
      return o;
    }));
    sel.addEventListener('change', () => { location.search = `?id=${sel.value}`; });
  }

  // ---- tiny syntax highlighter
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(code, lang) {
    const re = lang === 'css'
      ? /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|(^[^\n{}]+?(?=\s*\{))|(^\s+-?-?[a-z][a-z-]*)(?=\s*:)|(@[a-z-]+)/gm
      : /(\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|`[^`]*`)|(<\/?)([A-Za-z][\w.:-]*)|\b(import|from|export|default|function|return|const)\b|([A-Za-z_][\w:.-]*)(?==)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      last = re.lastIndex;
      if (m[0] === '') { re.lastIndex++; continue; }
      if (lang === 'css') {
        if (m[1]) out += `<span class="t-com">${esc(m[1])}</span>`;
        else if (m[2]) out += `<span class="t-str">${esc(m[2])}</span>`;
        else if (m[3]) out += `<span class="t-sel">${esc(m[3])}</span>`;
        else if (m[4]) out += `<span class="t-prop">${esc(m[4])}</span>`;
        else out += `<span class="t-kw">${esc(m[5])}</span>`;
      } else {
        if (m[1]) out += `<span class="t-com">${esc(m[1])}</span>`;
        else if (m[2]) out += `<span class="t-str">${esc(m[2])}</span>`;
        else if (m[4]) out += `${esc(m[3])}<span class="t-tag">${esc(m[4])}</span>`;
        else if (m[5]) out += `<span class="t-kw">${esc(m[5])}</span>`;
        else out += `<span class="t-attr">${esc(m[6])}</span>`;
      }
    }
    return out + esc(code.slice(last));
  }

  // ---- wiring
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    savePrefs();
    renderFiles();
  });
  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    savePrefs();
    renderPreview();
    requestAnimationFrame(fitPreview);
  });
  let nameTimer;
  $('name').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(regenerate, 200); });
  $('maps').addEventListener('change', () => { savePrefs(); regenerate(); });

  regenerate();
  renderPreview();
  window.__snagOutput = output;
})();
