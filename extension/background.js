// Snag UI — service worker: injects the picker, fetches cross-origin CSS, screenshots, stores results.

const CONTENT_FILES = ['shared/base.js', 'content/extract.js', 'content/picker.js'];
const MAX_HISTORY = 30;

chrome.action.onClicked.addListener((tab) => startPicker(tab));

async function startPicker(tab) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__snagPicker.toggle() });
  } catch (err) {
    console.warn('[snag] cannot run on this page:', err);
    chrome.action.setBadgeBackgroundColor({ color: '#b3261e', tabId: tab.id });
    chrome.action.setBadgeText({ text: '✕', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2500);
  }
}

const handlers = {
  async 'snag:fetch-css'({ url }) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text() };
  },

  // Fonts are usually CORS-locked to their site; the preview gets them inlined as data: URLs.
  async 'snag:fetch-data-url'({ url, maxBytes = 2_500_000 }) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Error('too large');
    return { dataUrl: await blobToDataUrl(blob) };
  },

  async 'snag:screenshot'({ rect, vw }, sender) {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return { dataUrl: await crop(dataUrl, rect, vw) };
  },

  async 'snag:save'({ model, shot }, sender) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const { snagIndex = [] } = await chrome.storage.local.get('snagIndex');
    const entry = { id, at: Date.now(), title: model.page.title, url: model.page.url, label: model.label, name: model.suggestedName };
    const next = [entry, ...snagIndex];
    const dropped = next.splice(MAX_HISTORY);
    await chrome.storage.local.set({ snagIndex: next, [`snag:${id}`]: { model, shot } });
    if (dropped.length) await chrome.storage.local.remove(dropped.map((d) => `snag:${d.id}`));
    const url = chrome.runtime.getURL(`result/result.html?id=${id}`);
    await chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined, openerTabId: sender.tab?.id });
    return { id };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function crop(dataUrl, rect, vw) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = vw ? bmp.width / vw : 1;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bmp.width - sx, Math.round((rect.width + Math.min(0, rect.x)) * scale));
  const sh = Math.min(bmp.height - sy, Math.round((rect.height + Math.min(0, rect.y)) * scale));
  if (sw <= 2 || sh <= 2) return null;
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return { src: await blobToDataUrl(out), scale };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}
