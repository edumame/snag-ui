/*
 * Scoped reset that mirrors Tailwind v4 "preflight".
 *
 * Every captured component is measured against this baseline, so:
 *  - React + Tailwind output assumes the project's own preflight (which is identical).
 *  - CSS / CSS Module output ships this block so it renders the same in any project.
 * All selectors are wrapped in :where() so they carry zero specificity.
 */
globalThis.SNAG_BASE_CSS = `:where(.root, .root *), :where(.root, .root *)::before, :where(.root, .root *)::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
:where(.root) { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; }
:where(.root, .root *):where(hr) { height: 0; color: inherit; border-top-width: 1px; }
:where(.root, .root *):where(h1, h2, h3, h4, h5, h6) { font-size: inherit; font-weight: inherit; }
:where(.root, .root *):where(a) { color: inherit; text-decoration: inherit; }
:where(.root, .root *):where(b, strong) { font-weight: bolder; }
:where(.root, .root *):where(code, kbd, samp, pre) { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 1em; }
:where(.root, .root *):where(small) { font-size: 80%; }
:where(.root, .root *):where(sub, sup) { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
:where(.root, .root *):where(sub) { bottom: -0.25em; }
:where(.root, .root *):where(sup) { top: -0.5em; }
:where(.root, .root *):where(table) { text-indent: 0; border-color: inherit; border-collapse: collapse; }
:where(.root, .root *):where(ol, ul, menu) { list-style: none; }
:where(.root, .root *):where(img, svg, video, canvas, audio, iframe, embed, object) { display: block; vertical-align: middle; }
:where(.root, .root *):where(img, video) { max-width: 100%; height: auto; }
:where(.root, .root *):where(button, input, select, optgroup, textarea) { font: inherit; letter-spacing: inherit; color: inherit; border-radius: 0; background-color: transparent; opacity: 1; }
:where(.root, .root *):where(button, input:where([type="button"], [type="reset"], [type="submit"])) { appearance: button; }
:where(.root, .root *):where(textarea) { resize: vertical; }
:where(.root, .root *)::placeholder { opacity: 1; color: color-mix(in oklab, currentcolor 50%, transparent); }
:where(.root, .root *):where([hidden]:not([hidden="until-found"])) { display: none !important; }
`;
