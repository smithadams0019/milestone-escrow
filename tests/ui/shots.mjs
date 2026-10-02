// usage: node shots.mjs <outdir> [tabs=chain] ; screenshots at 360/768/1280/1920, light + dark
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const [out, tabsArg = 'chain', base = 'http://localhost:5193'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const scheme of ['light', 'dark']) for (const w of [360, 768, 1280, 1920]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 500 ? 780 : 900 }, colorScheme: scheme });
  const p = await ctx.newPage(); const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text())); p.on('pageerror', (e) => errs.push(String(e)));
  for (const tab of tabsArg.split(',')) {
    await p.goto(`${base}/#${tab}`); await p.waitForTimeout(1800);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await p.screenshot({ path: `${out}/${tab}-${w}-${scheme}.png`, fullPage: true });
    console.log(tab, w, scheme, 'horizontal overflow px:', sw, errs.length ? 'ERRORS ' + errs.join('|') : '');
  }
  await ctx.close();
}
await b.close();
