/**
 * Three-way merge of a page: what the suggester saw (`base`), what the drafts have now
 * (`current`) and what they proposed (`suggested`). Git merges by line, and a Markdown
 * paragraph is one line, so two suggestions on one paragraph always conflict there.
 * Here the page is compared paragraph by paragraph, and one both sides changed is merged again word by word: two fixes in
 * different places of it both land; only changes to the same words overlap.
 *
 *   merge3(base, current, suggested)
 *     -> { text, overlaps: [{ line, base, current, suggested }] }
 *        `text` has every change that doesn't overlap; where one does, the current
 *        paragraph stays as it is: the suggestion's copy of it holds the old wording
 *        of everything else the drafts changed there, so it is never put in.
 *        `line` is the 0-based line in `current` where the paragraph starts; `base` is
 *        the paragraph as the suggester saw it.
 *
 * Pure: no I/O. CPU stays small: common head and tail are trimmed before the LCS, and
 * the word-level pass runs only on the paragraphs both sides changed.
 */

// ponytail: an LCS table over what's left after trimming; beyond this many cells a
// region is treated as overlapping (needs a look) rather than spending the CPU.
const MAX_CELLS = 2_000_000;


// A line with the blank lines after it: a paragraph, so blank lines never pair up on their own.
const paras = (t) => t.match(/[^\n]*\n+|[^\n]+$/g) ?? [];
// Words with the spaces after them, so inserting "the " is one token; leading spaces apart.
const words = (t) => t.match(/^\s+|\S+\s*/g) ?? [];

/** Changed regions of b against a: [{ lo, hi, from, to }] (a[lo..hi) became b[from..to)), or null if too large. */
function hunks(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ lo: pre, hi: pre + n, from: pre, to: pre + m }];
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // Tokens as numbers (comparing numbers, not strings, in the n×m loop).
  const ids = new Map();
  const id = (x) => {
    let k = ids.get(x);
    if (k === undefined) ids.set(x, (k = ids.size));
    return k;
  };
  const A = Int32Array.from({ length: n }, (_, i) => id(a[pre + i]));
  const B = Int32Array.from({ length: m }, (_, j) => id(b[pre + j]));
  // LCS lengths of the suffixes, then walk forward.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = A[i];
    const row = i * w;
    const next = row + w;
    for (let j = m - 1; j >= 0; j--) {
      const down = t[next + j];
      const right = t[row + j + 1];
      t[row + j] = ai === B[j] ? t[next + j + 1] + 1 : down > right ? down : right;
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (!open) return;
    // n tokens replaced by n: one change each, so neighbouring paragraphs (or words)
    // changed on one side don't swallow the other side's change next door.
    if (i - open.i === j - open.j) for (let k = 0; k < i - open.i; k++) out.push({ lo: pre + open.i + k, hi: pre + open.i + k + 1, from: pre + open.j + k, to: pre + open.j + k + 1 });
    else out.push({ lo: pre + open.i, hi: pre + i, from: pre + open.j, to: pre + j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { i, j };
      if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) j++;
      else i++;
    }
  }
  close();
  return out;
}

const overlap = (x, y) => (x.lo < y.hi && y.lo < x.hi) // ranges share base tokens
  || (x.lo === x.hi && y.lo === y.hi && x.lo === y.lo) // both insert at one point
  // an insertion inside the other's change, or at its start (both add text at one point)
  || (x.lo === x.hi && y.lo <= x.lo && x.lo < y.hi) || (y.lo === y.hi && x.lo <= y.lo && y.lo < x.hi);

/**
 * diff3 on token arrays. -> { out: tokens, conflicts: [{ at, cur: tokens, sug: tokens }] } or null (too large).
 * `resolve(cur, sug, base, at)` gives the tokens for a conflicting region (`at`: its index in
 * `cur`), or undefined to keep `cur`; such a region is listed in `conflicts`.
 */
function tokens3(base, cur, sug, resolve) {
  const hc = hunks(base, cur);
  const hs = hunks(base, sug);
  if (!hc || !hs) return null;
  const all = [...hc.map((h) => ({ ...h, side: 'c' })), ...hs.map((h) => ({ ...h, side: 's' }))].sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  // Groups of hunks that overlap, transitively.
  const groups = [];
  for (const h of all) {
    const g = groups.at(-1);
    if (g && g.some((x) => overlap(x, h))) g.push(h);
    else groups.push([h]);
  }
  const out = [];
  const conflicts = [];
  let pos = 0; // in base
  let dc = 0; // cur index - base index, before the group
  let ds = 0;
  for (const g of groups) {
    const lo = Math.min(...g.map((h) => h.lo));
    const hi = Math.max(...g.map((h) => h.hi));
    for (let k = pos; k < lo; k++) out.push(base[k]);
    const gc = g.filter((h) => h.side === 'c');
    const gs = g.filter((h) => h.side === 's');
    const span = (hs, d) => {
      const delta = hs.reduce((n, h) => n + (h.to - h.from) - (h.hi - h.lo), 0);
      return [lo + d, hi + d + delta, delta];
    };
    const [c0, c1, dcg] = span(gc, dc);
    const [s0, s1, dsg] = span(gs, ds);
    const curPart = cur.slice(c0, c1);
    const sugPart = sug.slice(s0, s1);
    if (!gs.length || curPart.join('') === sugPart.join('')) out.push(...curPart);
    else if (!gc.length) out.push(...sugPart);
    else {
      conflicts.push({ at: c0, sat: s0, bat: lo, cur: curPart, sug: sugPart, base: base.slice(lo, hi) });
      out.push(...(resolve(curPart, sugPart, base.slice(lo, hi), c0) ?? curPart));
    }
    dc += dcg;
    ds += dsg;
    pos = hi;
  }
  for (let k = pos; k < base.length; k++) out.push(base[k]);
  return { out, conflicts };
}

const wordSet = (t) => new Set(t.toLowerCase().split(/\s+/));
/** How alike two paragraphs' word sets are: shared words over all words (0–1). */
function alike(x, y) {
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, x.size + y.size - n);
}

/** Paragraphs the suggestion changed in place, each merged by words with its counterpart in `c`. -> tokens */
function inPlace(c, sug, was, firstLine, overlaps) {
  const out = [...c];
  const used = new Set();
  const lineOf = (j) => firstLine + c.slice(0, j).join('').split('\n').length - 1;
  const sets = [];
  const setOf = (k) => (sets[k] ??= wordSet(c[k]));
  for (let i = 0; i < was.length; i++) {
    if (sug[i] === was[i]) continue;
    let j = -1;
    let best = 0.3; // below this, the paragraph is gone from the drafts
    const ws = wordSet(was[i]);
    for (let k = 0; k < c.length; k++) {
      const score = used.has(k) ? 0 : alike(ws, setOf(k));
      if (score > best) [best, j] = [score, k];
    }
    if (j < 0) {
      // Removed from the drafts since: shown empty, and kept removed.
      const at = Math.min(c.length, [...used].reduce((m, k) => Math.max(m, k + 1), 0));
      overlaps.push({ line: lineOf(at), base: was[i].trimEnd(), current: '', suggested: sug[i].trimEnd() });
      continue;
    }
    used.add(j);
    const w = tokens3(words(was[i]), words(c[j]), words(sug[i]), () => undefined);
    if (w && !w.conflicts.length) {
      out[j] = w.out.join('');
      continue;
    }
    overlaps.push({ line: lineOf(j), base: was[i].trimEnd(), current: c[j].trimEnd(), suggested: sug[i].trimEnd() });
  }
  return out;
}

const before = (toks, k) => toks.slice(0, k).join('').length;
/** The line of `text` holding character `at`: [start, end) without its newline. */
function lineAround(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  return [start, nl < 0 ? text.length : nl];
}

export function merge3(base, current, suggested) {
  const overlaps = [];
  const cur = paras(current);
  // Paragraphs first; where both sides changed, again by words. Words that still clash
  // are an overlap: the paragraph holding them (a Markdown paragraph is one line) is
  // reported and kept as it is now; every other change in the region is merged.
  const r = tokens3(paras(base), cur, paras(suggested), (c, sug, was, at) => {
    // The usual case: the suggestion edited paragraphs in place. Each is merged with its
    // counterpart in the drafts alone (small, and the overlap is exactly that paragraph).
    if (sug.length === was.length) return inPlace(c, sug, was, cur.slice(0, at).join('').split('\n').length - 1, overlaps);
    const cw = words(c.join(''));
    const sw = words(sug.join(''));
    const bw = words(was.join(''));
    const w = tokens3(bw, cw, sw, () => undefined);
    const firstLine = cur.slice(0, at).join('').split('\n').length - 1;
    if (!w) {
      // Too large to merge by words: reported whole.
      overlaps.push({ line: firstLine, base: was.join('').trimEnd(), current: c.join('').trimEnd(), suggested: sug.join('').trimEnd() });
      return c;
    }
    if (!w.conflicts.length) return [w.out.join('')];
    const curText = c.join('');
    const sugText = sug.join('');
    const wasText = was.join('');
    const seen = new Set();
    for (const k of [...w.conflicts].reverse()) {
      // A side that removed the words has no paragraph of its own there: shown as empty.
      const [cs, ce] = k.cur.length ? lineAround(curText, before(cw, k.at)) : [before(cw, k.at), before(cw, k.at)];
      const [ss, se] = k.sug.length ? lineAround(sugText, before(sw, k.sat)) : [0, 0];
      const [bs, be] = lineAround(wasText, before(bw, k.bat));
      const key = k.cur.length ? cs : `gone${cs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overlaps.unshift({ line: firstLine + curText.slice(0, cs).split('\n').length - 1, base: wasText.slice(bs, be), current: curText.slice(cs, ce), suggested: sugText.slice(ss, se) });
    }
    return [w.out.join('')];
  });
  if (!r) return { text: current, overlaps: [{ line: 0, base, current, suggested }] };
  return { text: r.out.join(''), overlaps };
}
