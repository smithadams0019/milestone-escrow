const BASE = import.meta.env.VITE_API_URL || '';
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || r.statusText), { code: j.error, status: r.status, paypal: j.paypal });
  return j;
}
export const api = {
  state: (refresh) => req('GET', '/api/state' + (refresh ? '?refresh=1' : '')),
  inspect: (b) => req('POST', '/api/inspect', b),
  reset: () => req('POST', '/api/reset'),
  reconcile: () => req('POST', '/api/reconcile'),
  cancel: (batch, payee) => req('POST', `/api/batches/${batch}/cancel/${payee}`),
  reissue: (b) => req('POST', '/api/reissue', b),
};
