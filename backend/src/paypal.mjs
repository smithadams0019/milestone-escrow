// Direct REST. No MCP tool touches Payouts, and the SDKs hide the item-level truth we need.
export class PayPalError extends Error {
  constructor(status, body, where) {
    super(`${where}: ${status} ${body?.name || ''} ${body?.message || ''}`.trim());
    this.status = status; this.body = body; this.where = where;
    this.name = body?.name || 'PAYPAL_ERROR';
    this.details = body?.details || [];
  }
}

export function makePayPal({ clientId, secret, api = 'https://api-m.sandbox.paypal.com', fetchImpl = fetch }) {
  let cached = null;
  async function token() {
    if (cached && cached.exp > Date.now() + 30000) return cached.value;
    const r = await fetchImpl(`${api}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    if (!r.ok) throw new PayPalError(r.status, j, 'oauth');
    cached = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cached.value;
  }
  async function call(method, path, body, where, extraHeaders = {}) {
    const r = await fetchImpl(`${api}${path}`, {
      signal: AbortSignal.timeout(25000), // a stuck PayPal call must not hold the Lambda
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    if (!r.ok) throw new PayPalError(r.status, j, where || `${method} ${path}`);
    return j;
  }
  return {
    api,
    createPayout: (body, requestId) => call('POST', '/v1/payments/payouts', body, 'create payout', requestId ? { 'PayPal-Request-Id': requestId } : {}),
    getBatch: (id, { paged = true } = {}) => call('GET', `/v1/payments/payouts/${encodeURIComponent(id)}${paged ? '?page_size=100' : ''}`, undefined, 'get batch'),
    getItem: (id) => call('GET', `/v1/payments/payouts-item/${encodeURIComponent(id)}`, undefined, 'get item'),
    cancelItem: (id) => call('POST', `/v1/payments/payouts-item/${encodeURIComponent(id)}/cancel`, undefined, 'cancel item'),
    createInvoice: (body, requestId) => call('POST', '/v2/invoicing/invoices', body, 'create invoice', requestId ? { 'PayPal-Request-Id': requestId } : {}),
    searchInvoices: (body) => call('POST', '/v2/invoicing/search-invoices?page=1&page_size=10', body, 'search invoices'),
    getInvoice: (id) => call('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`, undefined, 'get invoice'),
    verifyWebhook: (body) => call('POST', '/v1/notifications/verify-webhook-signature', body, 'verify webhook'),
    listWebhooks: () => call('GET', '/v1/notifications/webhooks', undefined, 'list webhooks'),
    createWebhook: (body) => call('POST', '/v1/notifications/webhooks', body, 'create webhook'),
  };
}

/** Pull the item list across pages of a payout batch GET (page_size 100 -> follow total_pages). */
export async function getFullBatch(pp, id) {
  return pp.getBatch(id);
}

/** PayPal rejects a repeated sender_batch_id with a link to the batch it already made. Returns that batch id, or null. */
export function existingBatchId(err) {
  const link = err?.details?.find?.((d) => d.field === 'SENDER_BATCH_ID')?.link?.[0]?.href;
  return link ? link.split('/').pop().split('?')[0] : null;
}

export const isDuplicateInvoice = (err) => err?.status === 422 && JSON.stringify(err.details || []).includes('DUPLICATE_INVOICE_NUMBER');
