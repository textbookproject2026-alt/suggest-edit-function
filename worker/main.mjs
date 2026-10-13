/**
 * c4n-api's main module (wrangler.toml): the Worker (worker/index.mjs) and its one other
 * entrypoint. Kept apart from index.mjs because `cloudflare:workers` loads only on
 * Cloudflare, and the tests import index.mjs in Node. workerd treats every named export
 * here as an entrypoint, so add none by accident.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import worker, { periodic } from './index.mjs';

export default worker;

/**
 * The five-minute jobs, for build-nudge's 15-minute cron (its service binding C4N_JOBS):
 * Cloudflare never ran c4n-api's own five-minute schedule (13 Oct). A named entrypoint
 * has no URL: only a Worker bound to it can call it.
 */
export class Jobs extends WorkerEntrypoint {
  async run(source) {
    return periodic(this.env, String(source || 'service binding').slice(0, 60));
  }
}
