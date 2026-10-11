// What the Worker's fetch refuses outright, kept out of the code it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('no fetch with redirect: "error" (Cloudflare Workers throw on it; use "manual" and check the status)', () => {
  for (const dir of ['api', 'author', 'lib', 'worker']) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      const text = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /redirect:\s*['"]error['"]/, `${dir}/${f}`);
    }
  }
});
