/**
 * Readers' proposals brought up to date with the drafts (lib/reapply.mjs refreshProposals),
 * run by .github/workflows/proposals.yml: after an accept on the Worker, for that page
 * (repository_dispatch c4n-proposals { book, path }), and by hand over every book's open
 * proposals (the backlog). Each one GitHub can't merge is merged again with the drafts
 * word by word and committed to its branch where the words don't overlap; one where they
 * do is labelled "paragraph changed". Accepts, declines and merges nothing.
 *
 *   node scripts/refresh-proposals.mjs [book] [path]
 */
import { REGISTRY, appCredentials, budget } from '../lib/author.mjs';
import { refreshProposals } from '../lib/reapply.mjs';

const appToken = appCredentials({ contents: 'write', pull_requests: 'write', issues: 'write' });

async function main() {
  const [slug, path] = process.argv.slice(2).filter(Boolean);
  const books = REGISTRY.books.filter((b) => b.content?.drafts_branch && b.status !== 'retired' && (!slug || b.slug === slug));
  if (slug && !books.length) throw new Error(`no such book with a drafts branch: ${slug}`);
  const totals = { clean: 0, refreshed: 0, overlap: 0, other: 0 };
  let failed = false;
  for (const book of books) {
    try {
      const { token } = await appToken(book, `refresh ${book.slug}`);
      const r = await refreshProposals(book, token, budget(10 * 60_000, 30_000), { paths: path ? new Set([path]) : null, tag: `book=${book.slug}` });
      for (const k of ['clean', 'refreshed', 'overlap']) totals[k] += r[k].length;
      totals.other += r.other.length;
      console.log(`${book.slug}: merge as they are #${r.clean.join(' #') || '-'}; brought up to date #${r.refreshed.join(' #') || '-'}; need a look #${r.overlap.join(' #') || '-'}${r.other.length ? `; other ${JSON.stringify(r.other)}` : ''}`);
    } catch (err) {
      failed = true;
      console.error(`${book.slug}: ${err.message}`);
    }
  }
  console.log(`total: ${totals.clean + totals.refreshed} clean (${totals.refreshed} of them brought up to date now), ${totals.overlap} need a look, ${totals.other} other`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
