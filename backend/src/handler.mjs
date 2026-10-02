import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { makePayPal } from './paypal.mjs';
import { makeAgent } from './agent.mjs';
import { dynamoStore } from './store.mjs';
import { makeService } from './service.mjs';

let svc;
async function boot() {
  if (svc) return svc;
  const env = { ...process.env };
  if (process.env.SSM_PREFIX) {
    const ssm = new SSMClient({ region: process.env.AWS_REGION });
    const r = await ssm.send(new GetParametersByPathCommand({ Path: process.env.SSM_PREFIX, WithDecryption: true }));
    for (const p of r.Parameters || []) env[p.Name.split('/').pop()] = p.Value;
  }
  const pp = makePayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, api: env.PAYPAL_API });
  svc = makeService({ store: dynamoStore({ table: env.TABLE }), pp, agent: makeAgent(), env });
  return svc;
}

// CORS headers come from the Function URL configuration (deploy.sh). Adding them here as well produced a duplicate
// Access-Control-Allow-Origin header that browsers reject, found by loading the deployed site in a real browser.
const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export async function route(s, { method, path, headers, rawBody, query }) {
  let m;
  if (method === 'OPTIONS') return json(204, {});
  if (method === 'GET' && path === '/api/health') return json(200, { ok: true, time: new Date().toISOString() });
  if (method === 'GET' && path === '/api/state') {
    if (query.refresh === '1') await s.refreshOpen();
    return json(200, await s.view());
  }
  const body = () => { try { return rawBody ? JSON.parse(rawBody) : {}; } catch { throw Object.assign(new Error('Body is not JSON'), { status: 400, code: 'BAD_JSON' }); } };
  if (method === 'POST' && path === '/api/inspect') return json(200, await s.inspect(body()));
  if (method === 'POST' && path === '/api/reconcile') return json(200, await s.reconcile());
  if (method === 'POST' && path === '/api/reset') return json(200, await s.reset());
  if (method === 'POST' && path === '/api/webhook') return json(200, await s.webhook({ headers, rawBody }));
  if (method === 'POST' && path === '/api/reissue') return json(200, await s.reissue(body()));
  if (method === 'POST' && (m = path.match(/^\/api\/batches\/([A-Z0-9]+)\/refresh$/))) return json(200, await s.refreshBatch(m[1]));
  if (method === 'POST' && (m = path.match(/^\/api\/batches\/([A-Z0-9]+)\/cancel\/([a-z]+)$/))) return json(200, await s.cancelItem(m[1], m[2]));
  return json(404, { error: 'NOT_FOUND', message: `${method} ${path}` });
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.rawPath || event.path;
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
  try {
    return await route(await boot(), { method, path, headers: event.headers || {}, rawBody, query: event.queryStringParameters || {} });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('ERR', e.stack || e);
    return json(status, { error: e.code || 'INTERNAL', message: e.message, paypal: e.paypal });
  }
}
