/**
 * A Fetch Request to the Node-style req/res the handlers were written for (Vercel's
 * helpers: res.status, res.json, a parsed JSON body), and the result back to a
 * Response. Used by worker/index.mjs, and by test/via-worker.mjs, which runs the
 * whole test suite through it.
 */
async function bodyOf(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const text = await request.text();
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // Vercel hands a handler parsed JSON; unparseable JSON stays a string, which
  // parseBody turns into the handler's own 400.
  if (type === 'application/json' && text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function toNode(request, url, body) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k] = v;
  // Cloudflare's own view of the caller; a client-sent X-Forwarded-For is never trusted.
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (ip) headers['x-forwarded-for'] = ip;
  else delete headers['x-forwarded-for'];
  const req = { method: request.method, url: url.pathname + url.search, headers, body, socket: { remoteAddress: ip } };

  const out = new Headers();
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    setHeader(k, v) {
      out.delete(k);
      for (const one of Array.isArray(v) ? v : [v]) out.append(k, String(one));
      return this;
    },
    getHeader: (k) => out.get(k) ?? undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      if (!out.has('content-type')) out.set('Content-Type', 'application/json; charset=utf-8');
      return this.end(JSON.stringify(payload));
    },
    send(payload) {
      return typeof payload === 'object' && payload !== null ? this.json(payload) : this.end(payload);
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body = chunk;
      this.headersSent = true;
      return this;
    },
  };
  return { req, res, out };
}

function toResponse(res, out) {
  const empty = res.statusCode === 204 || res.statusCode === 304 || res.body === null;
  return new Response(empty ? null : res.body, { status: res.statusCode, headers: out });
}

/** Run a handler on a Request. `url` is the (rewritten) URL the handler should see. */
export async function serve(handler, request, url = new URL(request.url)) {
  const { req, res, out } = toNode(request, url, await bodyOf(request));
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`unhandled: ${request.method} ${url.pathname}: ${err?.stack ?? err}`);
    if (!res.headersSent) return Response.json({ error: 'internal error' }, { status: 500 });
  }
  return toResponse(res, out);
}
