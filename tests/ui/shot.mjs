import { chromium } from 'playwright-core';
const [url, out, w = 1500, h = 1000, tab = 'chain'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
await p.goto(url + '#' + tab); await p.waitForTimeout(2500);
await p.screenshot({ path: out, fullPage: true });
await b.close();
