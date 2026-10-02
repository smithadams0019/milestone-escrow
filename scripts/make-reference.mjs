// Assemble backend/src/reference-m1.json from a REAL milestone-1 release already made against an API.
// usage: node scripts/make-reference.mjs http://localhost:8787
import { writeFileSync } from 'node:fs';
import { SAMPLE_REPORTS } from '../backend/src/seed.mjs';
const api = process.argv[2];
let d;
for (let i = 0; i < 40; i++) {
  d = await (await fetch(`${api}/api/state?refresh=1`)).json();
  const b = d.batches.find((x) => x.milestone === 1);
  if (b && d.milestones[0].rollup?.settled) break;
  await new Promise((r) => setTimeout(r, 4000));
}
const batch = d.batches.find((x) => x.milestone === 1);
const insp = d.inspections.find((x) => x.n === 1);
if (!batch || !insp) throw new Error('no M1 release found at ' + api);
const { reportPreview, ...rest } = insp;
const inspection = { ...rest, report: SAMPLE_REPORTS[1].pass.text };
writeFileSync(new URL('../backend/src/reference-m1.json', import.meta.url), JSON.stringify({ inspection, batch }, null, 1));
console.log('wrote reference: batch', batch.id, 'status', batch.status, batch.items.map((i) => i.payeeId + ':' + i.status).join(' '));
