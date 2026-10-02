// Computes WCAG contrast ratios from the design tokens actually shipped in frontend/src/styles.css.
// usage: node scripts/contrast.mjs   (exit 1 if any pair is under its threshold)
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8');
const block = (re) => { const m = css.match(re); const out = {}; if (m) for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[k] = v; return out; };
const light = block(/:root\s*\{([^}]*)\}/);
const dark = { ...light, ...block(/\[data-theme='dark'\]\s*\{([^}]*)\}/) };
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// [foreground, background, minimum, where it is used]
const PAIRS = [
  ['ink', 'page', 4.5, 'body text on page'], ['ink', 'card', 4.5, 'body text on cards'], ['ink2', 'page', 4.5, 'secondary text on page'], ['ink2', 'card', 4.5, 'secondary text on cards'],
  ['ink2', 'band', 4.5, 'secondary text on grid group bands'],
  ['ok-fg', 'ok-bg', 4.5, 'landed cell text'], ['warn-fg', 'warn-bg', 4.5, 'moving / unclaimed cell text'], ['bad-fg', 'bad-bg', 4.5, 'blocked / failed cell text'],
  ['idle-fg', 'card', 4.5, 'awaiting inspection cell text'], ['ok-fg', 'card', 4.5, 'green text on card'], ['warn-fg', 'card', 4.5, 'amber text on card'], ['bad-fg', 'card', 4.5, 'red text on card'],
  ['on-accent', 'accent', 4.5, 'button text on accent'], ['nav-fg', 'nav-bg', 4.5, 'navigation text'], ['nav-fg-on', 'nav-bg', 4.5, 'active navigation text'],
  ['accent', 'card', 3, 'focus ring / non-text accent vs card (3:1)'], ['line-strong', 'card', 3, 'input and cell borders (3:1)'],
];
let bad = 0; const rows = [];
for (const [name, theme] of [['light', light], ['dark', dark]]) for (const [f, b, min, use] of PAIRS) {
  if (!theme[f] || !theme[b]) { rows.push(`${name.padEnd(5)} MISSING ${f}/${b}`); bad++; continue; }
  const r = ratio(theme[f], theme[b]); const ok = r >= min; if (!ok) bad++;
  rows.push(`${name.padEnd(5)} ${ok ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (need ${min})  ${f} ${theme[f]} on ${b} ${theme[b]}  - ${use}`);
}
console.log(rows.join('\n')); console.log(bad ? `\n${bad} pair(s) below threshold` : '\nAll pairs meet WCAG AA (4.5:1 text, 3:1 non-text)'); process.exit(bad ? 1 : 0);
