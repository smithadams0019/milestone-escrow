// Local server running the same route() as the Lambda. STORE=dynamo uses the real table, otherwise memory.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { makePayPal } from './paypal.mjs';
import { makeAgent } from './agent.mjs';
import { dynamoStore, memoryStore } from './store.mjs';
import { makeService } from './service.mjs';
import { route } from './handler.mjs';

for (const l of readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
try { process.env.RECIPIENTS_JSON ||= readFileSync(new URL('../../.recipients.json', import.meta.url), 'utf8'); } catch {}
const env = { ...process.env };
const store = process.env.STORE === 'dynamo' ? dynamoStore({ table: process.env.TABLE || 'escrow-ledger' }) : memoryStore();
const pp = makePayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, api: env.PAYPAL_API });
let agent = makeAgent();
if (process.env.FAKE_AGENT) { // dev only: scripted model so UI iteration does not wait on Bedrock
  const { scriptedBedrock } = await import('../test/helpers.mjs');
  agent = makeAgent({ client: scriptedBedrock('pass') });
}
const s = makeService({ store, pp, agent, env });

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const u = new URL(req.url, 'http://x');
  try {
    const r = await route(s, { method: req.method, path: u.pathname, headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8'), query: Object.fromEntries(u.searchParams) });
    res.writeHead(r.statusCode, r.headers); res.end(r.body);
  } catch (e) {
    res.writeHead(e.status || 500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: e.code || 'INTERNAL', message: e.message, paypal: e.paypal }));
  }
}).listen(Number(process.env.PORT || 8787), () => console.log('local api on', process.env.PORT || 8787, 'store=', store.kind));
