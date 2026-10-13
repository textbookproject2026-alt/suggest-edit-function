/**
 * D1 for the tests: node:sqlite in memory, shaped like the binding
 * (prepare(sql).bind(...).first()/run()/all()), with the repo's migrations applied.
 * node:sqlite doesn't bind D1's numbered ?1 parameters, so each becomes a plain ?.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const statement = (sql, params = []) => {
    const order = [];
    const plain = sql.replace(/\?(\d+)/g, (_, n) => (order.push(Number(n) - 1), '?'));
    const args = order.map((i) => params[i] ?? null);
    return {
      bind: (...p) => statement(sql, p),
      first: async () => {
        const row = db.prepare(plain).get(...args);
        return row ? { ...row } : null;
      },
      run: async () => (db.prepare(plain).run(...args), { success: true }),
      all: async () => ({ results: db.prepare(plain).all(...args).map((r) => ({ ...r })) }),
    };
  };
  return { prepare: (sql) => statement(sql), raw: db };
}
