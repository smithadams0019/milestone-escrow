import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:5193';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const w of [360, 1280]) {
  const p = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage(); const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  for (const tab of ['chain', 'ledger', 'case']) {
    await p.goto(base + '/#' + tab); await p.waitForTimeout(3500);
    const m = await p.evaluate(() => ({ height: document.documentElement.scrollHeight, words: document.body.innerText.trim().split(/\s+/).length, tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()).join(' | '), active: document.querySelector('.tab[aria-current]')?.textContent.trim(), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    console.log(w, '#' + tab, JSON.stringify(m), errs.length ? 'ERR ' + errs[0] : '');
  }
  await p.screenshot({ path: `../../shots/r10-${w}.png`, fullPage: true });
}
await b.close();
