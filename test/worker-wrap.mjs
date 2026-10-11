/** test/via-worker.mjs: a handler, as the Worker runs it. */
import { serve } from '../worker/adapter.mjs';

export function viaWorker(handler) {
  return async function (req, res) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) if (v !== undefined && k !== 'x-forwarded-for') headers.set(k, String(v));
    const ip = req.headers?.['x-forwarded-for'] ?? req.socket?.remoteAddress;
    if (ip) headers.set('cf-connecting-ip', String(ip).split(',')[0].trim());
    const method = req.method ?? 'GET';
    // Fetch forbids building a TRACE or CONNECT Request, and Cloudflare never hands one
    // to a Worker, so those go to the handler as they came.
    if (method === 'TRACE' || method === 'CONNECT') return handler(req, res);
    const hasBody = method !== 'GET' && method !== 'HEAD' && req.body !== undefined;
    const body = !hasBody ? undefined : typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
    const request = new Request(new URL(req.url ?? '/', 'https://api.confused4now.org'), { method, headers, body });
    // Anything a test hung on req besides the HTTP request itself (req.token) rides along.
    const extra = Object.fromEntries(Object.entries(req).filter(([k]) => !['method', 'headers', 'body', 'socket', 'url'].includes(k)));
    const response = await serve((r, s) => handler(Object.assign(r, extra), s), request);

    res.status(response.status);
    for (const [k, v] of response.headers) res.setHeader(k, v);
    const text = await response.text();
    if ((response.headers.get('content-type') ?? '').startsWith('application/json')) res.json(JSON.parse(text));
    else res.end(text || undefined);
  };
}
