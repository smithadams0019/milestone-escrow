// Drives the real UI through the full release (real Bedrock agent + real PayPal sandbox) and screenshots each stage.
import { chromium } from 'playwright-core';
const [out, base = 'http://localhost:5193', w = 1280, scheme = 'light', ms = '2'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: +w, height: 900 }, colorScheme: scheme });
const p = await ctx.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(base + '/#chain'); await p.waitForTimeout(1500);
await p.getByRole('button', { name: `Release milestone ${ms}`, exact: true }).first().click();
await p.waitForTimeout(400); await p.screenshot({ path: `${out}-1-form.png` });
await p.locator('.chip').first().click();
await p.getByRole('button', { name: 'Check report and release' }).click();
await p.waitForTimeout(500); await p.screenshot({ path: `${out}-2-confirm.png` });
await p.getByRole('dialog', { name: /Release milestone/ }).last().getByRole('button', { name: 'Check report and release' }).click();
await p.waitForTimeout(3000); await p.screenshot({ path: `${out}-3-working.png` });
const t0 = Date.now();
try { await p.getByRole('button', { name: 'Watch the chain' }).waitFor({ timeout: 150000 }); } catch (e) { await p.screenshot({ path: `${out}-FAIL.png` }); console.log('FAILED waiting; page errors:', errs.join(' | ')); process.exit(1); }
console.log('agent+payout took', Math.round((Date.now() - t0 + 3000) / 1000), 's');
await p.waitForTimeout(500); await p.screenshot({ path: `${out}-4-result.png` });
await p.getByRole('button', { name: 'Watch the chain' }).click();
await p.waitForTimeout(900); await p.screenshot({ path: `${out}-5-cascade-a.png` });
await p.waitForTimeout(900); await p.screenshot({ path: `${out}-6-cascade-b.png` });
await p.waitForTimeout(6000); await p.screenshot({ path: `${out}-7-after.png`, fullPage: true });
console.log('errors:', errs.join(' | ') || 'none'); await b.close();
