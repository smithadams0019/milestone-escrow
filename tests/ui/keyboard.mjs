// Keyboard-only walk: Tab through the chain page, report the focused element each step and whether a focus ring is drawn.
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:5193';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await p.goto(base + '/#chain'); await p.waitForTimeout(1500);
const seen = [];
for (let i = 0; i < 16; i++) {
  await p.keyboard.press('Tab');
  seen.push(await p.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 34)}" outline=${cs.outlineStyle} ${cs.outlineWidth}`; }));
}
console.log(seen.join('\n'));
// open the drawer by keyboard, confirm Escape closes it
await p.getByRole('button', { name: /^Release milestone/ }).first().focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
console.log('drawer open via Enter:', await p.getByRole('dialog').count() === 1);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
console.log('Escape closes drawer:', await p.getByRole('dialog').count() === 0);
// 200% zoom equivalent: halve the viewport
await p.setViewportSize({ width: 640, height: 450 }); await p.waitForTimeout(400);
console.log('200% (640px wide) horizontal overflow px:', await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
// reduced motion
const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }); const p2 = await ctx2.newPage(); await p2.goto(base + '/#chain'); await p2.waitForTimeout(800);
console.log('reduced-motion animation on a cell:', await p2.evaluate(() => getComputedStyle(document.querySelector('.cell')).animationName));
await b.close();
