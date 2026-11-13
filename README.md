# Snag UI

A Chrome extension that turns any element on any website into a compact React component.
Click the toolbar icon, hover something you like, click it, and you get:

- **React + Tailwind** (v4 class names, plus arbitrary values where no utility fits)
- **React + CSS Module**
- **HTML + CSS**

alongside a side-by-side preview of the original screenshot and the rebuilt component.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder (not the repo root).
3. Pin **Snag UI** to the toolbar. Shortcut: **Alt+Shift+S** (change it at `chrome://extensions/shortcuts`).

To use it on `file://` pages, also enable **Allow access to file URLs** on the extension's details page.

## Use

| Action | Effect |
| --- | --- |
| Click the icon / Alt+Shift+S | start picking (again to cancel) |
| Move the mouse | highlight the element under the cursor |
| ↑ / ↓ | walk to the parent / back down |
| Click or Enter | capture the highlighted element |
| Shift+click | capture, *including* closed menus/popovers |
| Esc | cancel |

The result opens in a new tab. You can rename the component, toggle `.map()` extraction, copy or download each file,
and reopen earlier captures from **Recent** (the last 30 are kept locally).

## What it does to make the output compact

1. **Real cascade, not computed-style dumps.** It indexes every stylesheet on the page (cross-origin sheets
   are fetched by the service worker) and resolves the cascade per element: `@layer` order, specificity,
   `!important`, inline styles, nesting, `@media`/`@supports`, and logical→physical properties. That keeps
   the author's intent (`w-full`, `grid-cols-3`, `hover:` rules, `::before` badges) instead of frozen pixel
   values.
2. **Verify against a rebuild.** The element is rebuilt in a hidden same-origin iframe that contains only a
   Tailwind-preflight baseline. Its computed styles are diffed against the original to
   - patch anything the cascade missed (inherited page font, container queries, JS-set styles),
   - prune declarations that change nothing (resets, defaults, `box-sizing` where it can't matter),
   - pin a box's size only when its layout still disagrees.

   The result page shows the **Layout match**: the share of boxes within 1px of the original.
3. **Emit like a person would.**
   - Shorthands: `px-6`, `size-4`, `text-sm/6`, `rounded-full`, `truncate`, `sr-only`.
   - Colors are normalized to hex, including `oklch()`/`lab()`/`color-mix()`.
   - Identical styles share one class.
   - Runs of 3+ identical siblings become a data array plus `.map()`.
   - A long Tailwind string repeated 3+ times becomes a tiny local component (`<Link href=…>`).
   - Closed dropdowns and popovers are skipped unless you Shift+click.

## Notes and limits

- **Tailwind output targets v4** and assumes the project has Tailwind's preflight (the default). The CSS / CSS
  Module output ships its own scoped copy of preflight, so it renders the same in any project.
- **Fonts** keep their original URLs in `snag-extras.css`. Most commercial fonts are CORS-locked and licensed
  to their site, so swap them for your own. The preview embeds them only so the comparison is accurate.
- It's a **snapshot at the current viewport**: other breakpoints aren't captured (yet). Hover/focus/active
  states on the element itself are captured; parent-driven ones (`.card:hover .title`) are not.
- **Shadow DOM** internals of web components aren't captured (their light-DOM children are). Canvas/WebGL
  content (e.g. Stripe's animated gradient) isn't part of the DOM, so it won't come along.
- JS-animated content is captured as it looked at the moment you clicked.
- The extension needs access to all sites so it can read cross-origin stylesheets. Captures stay in
  `chrome.storage.local` on your machine.

## Development

```bash
npm install
npx playwright install chromium

npm test              # fixture page (nav, cards, pricing) + compile all generated JSX
npm run test:sites    # + tailwindcss.com, github.com, stripe.com, wikipedia (needs network)
npm run test:picker   # drives the real UI: toolbar action → hover → click → result tab
```

`test/run.mjs` loads the unpacked extension into Chromium, snags each target in `test/sites.json`, and writes to
`test/out/<name>/`:

- the generated files
- `original.png`: the element on the page
- `rebuilt.png`: the CSS output, rendered
- `rebuilt-tailwind.png`: the Tailwind output, compiled by the real Tailwind v4 compiler

It also prints a pixel diff between them. Debug helpers:

- `test/debug-match.mjs`: which rules match an element
- `test/debug-diff.mjs`: every computed property that differs between original and rebuild
- `test/diff-image.mjs`: visual diff of two screenshots
- `test/probe.mjs`: list candidate selectors on a page

### Layout

```
extension/
  manifest.json
  background.js         service worker: injects the picker, fetches CSS/fonts, screenshots, storage
  content/picker.js     overlay + element picking
  content/extract.js    cascade, rebuild/verify/prune, JSON model
  shared/base.js        scoped preflight baseline
  shared/emit.js        model → Tailwind / CSS / JSX (+ .map(), local components)
  result/               result page (code tabs, preview, history)
```
