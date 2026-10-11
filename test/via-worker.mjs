/**
 * `npm run test:worker`: the whole suite, with every handler run through the Worker's
 * adapter (worker/adapter.mjs) instead of being called directly: each test's req
 * becomes a Fetch Request (its IP as CF-Connecting-IP, its body as JSON text), the
 * adapter rebuilds req/res from that, and the Response is replayed onto the test's res.
 * Loaded with `node --import ./test/via-worker.mjs`.
 */
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  const ADAPTER = ${JSON.stringify(new URL('./worker-wrap.mjs', import.meta.url).href)};
  export async function load(url, context, next) {
    const result = await next(url, context);
    if (!/\\/(api|author)\\/[a-z-]+\\.js(\\?|$)/.test(url)) return result;
    let source = String(result.source ?? (await import('node:fs')).readFileSync(new URL(url)));
    if (/export default async function handler\\(/.test(source)) {
      source = source.replace('export default async function handler(', 'async function handler(') +
        '\\nimport { viaWorker as __viaWorker } from ' + JSON.stringify(ADAPTER) + ';\\nexport default __viaWorker(handler);\\n';
    } else if (/export default wrap\\(/.test(source)) {
      source = source.replace('export default wrap(', 'const __handler = wrap(') +
        '\\nimport { viaWorker as __viaWorker } from ' + JSON.stringify(ADAPTER) + ';\\nexport default __viaWorker(__handler);\\n';
    } else {
      throw new Error('via-worker: no default handler export in ' + url);
    }
    return { ...result, source, shortCircuit: true };
  }
`));
