/**
 * An in-memory GitHub for the author endpoints: real git object ids (blobs hash as
 * git hashes them), commits with parents, recursive trees, fast-forward-only ref
 * moves, issues with labels and events, pull requests with merges, and the App's
 * installation-token exchange. Enough for the endpoints to be exercised through their
 * shipped code paths with `fetch` replaced.
 */
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
export const blobId = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

export function createFakeGitHub() {
  const repos = new Map();
  const state = { calls: [], tokenRequests: [], nextNumber: 100, clock: Date.parse('2026-09-28T10:00:00Z'), hooks: {}, users: new Map(), autoMerge: [] };

  function repo(full) {
    const key = full.toLowerCase();
    if (!repos.has(key)) {
      repos.set(key, { full, refs: new Map(), commits: new Map(), trees: new Map(), blobs: new Map(), issues: new Map(), pulls: new Map(), labels: new Set() });
    }
    return repos.get(key);
  }

  const tick = () => new Date((state.clock += 60_000)).toISOString();

  function putBlob(r, buf) {
    const id = blobId(buf);
    r.blobs.set(id, buf);
    return id;
  }
  function putTree(r, files) {
    const id = sha1(`tree ${JSON.stringify([...files].sort())}`);
    r.trees.set(id, new Map(files));
    return id;
  }
  function putCommit(r, { tree, parents, message, author, committer }) {
    const date = tick();
    const c = { tree, parents, message, author: { date, ...(author ?? { name: 'someone', email: 'someone@example.invalid' }) }, committer: committer ?? author, date };
    const id = sha1(`commit ${JSON.stringify(c)} ${Math.random()}`);
    r.commits.set(id, c);
    return id;
  }

  /** Commit `files` ({ path: string|Buffer|null }) on `branch`, as `author`. */
  function commitFiles(full, branch, files, { message = 'change', author } = {}) {
    const r = repo(full);
    const parent = r.refs.get(branch);
    const base = parent ? new Map(r.trees.get(r.commits.get(parent).tree)) : new Map();
    for (const [path, content] of Object.entries(files)) {
      if (content === null) base.delete(path);
      else base.set(path, putBlob(r, Buffer.isBuffer(content) ? content : Buffer.from(content)));
    }
    const id = putCommit(r, { tree: putTree(r, base), parents: parent ? [parent] : [], message, author });
    r.refs.set(branch, id);
    return id;
  }

  function filesAt(r, commit) {
    return r.trees.get(r.commits.get(commit).tree);
  }
  function textAt(full, commit, path) {
    const r = repo(full);
    const id = filesAt(r, commit).get(path);
    return id ? r.blobs.get(id).toString('utf8') : undefined;
  }
  function ancestors(r, id) {
    const out = [];
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
      const c = queue.shift();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(...(r.commits.get(c)?.parents ?? []));
    }
    return out;
  }

  function diff(r, a, b) {
    const A = a ? filesAt(r, a) : new Map();
    const B = filesAt(r, b);
    const files = [];
    for (const path of new Set([...A.keys(), ...B.keys()])) {
      if (A.get(path) === B.get(path)) continue;
      const before = A.has(path) ? r.blobs.get(A.get(path)).toString('utf8').split('\n') : [];
      const after = B.has(path) ? r.blobs.get(B.get(path)).toString('utf8').split('\n') : [];
      const patch = ['@@ -1 +1 @@', ...before.filter((l) => !after.includes(l)).map((l) => `-${l}`), ...after.filter((l) => !before.includes(l)).map((l) => `+${l}`)].join('\n');
      const added = after.filter((l) => !before.includes(l)).length;
      const removed = before.filter((l) => !after.includes(l)).length;
      files.push({ filename: path, status: !A.has(path) ? 'added' : !B.has(path) ? 'removed' : 'modified', additions: added, deletions: removed, changes: added + removed, patch });
    }
    return files;
  }
  const commitJson = (r, id) => {
    const c = r.commits.get(id);
    return { sha: id, html_url: `https://github.com/${r.full}/commit/${id}`, commit: { message: c.message, author: c.author }, author: c.author?.login ? { login: c.author.login } : null };
  };

  function addIssue(full, issue) {
    const r = repo(full);
    const number = state.nextNumber++;
    r.issues.set(number, { number, state: 'open', comments: [], events: [], created_at: tick(), html_url: `https://github.com/${r.full}/issues/${number}`, labels: [], ...issue });
    return number;
  }
  function addPull(full, { head, base, title, user = 'reader-bot[bot]', commits = [] }) {
    const r = repo(full);
    const number = state.nextNumber++;
    r.pulls.set(number, { number, state: 'open', title, user: { login: user }, head: { ref: head, sha: r.refs.get(head) }, base: { ref: base, repo: { full_name: r.full } },
      html_url: `https://github.com/${r.full}/pull/${number}`, created_at: tick(), mergeable: true, mergeable_state: 'clean', body: '', comments: [], prCommits: commits });
    return number;
  }

  async function fetchImpl(url, opts = {}) {
    url = String(url);
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ method, url, body, auth: opts.headers?.Authorization });
    for (const [pattern, fn] of Object.entries(state.hooks)) {
      if (url.includes(pattern)) {
        const out = await fn({ method, url, body });
        if (out) return out;
      }
    }
    const u = new URL(url);
    let m;
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname)) && method === 'POST') {
      state.tokenRequests.push(body);
      const [name] = body.repositories;
      const r = [...repos.values()].find((x) => x.full.split('/')[1] === name) ?? { full: `unknown/${name}` };
      return json(201, { token: `ghs_${name}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions, repositories: [{ full_name: r.full }] });
    }
    if ((m = /^\/users\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
      const user = state.users.get(decodeURIComponent(m[1]).toLowerCase());
      return user ? json(200, user) : json(404, { message: 'Not Found' });
    }
    if (u.pathname === '/graphql' && method === 'POST') {
      // Only enablePullRequestAutoMerge: remember which pull request, and how.
      state.autoMerge.push(body.variables);
      return json(200, { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { mergeMethod: body.variables.method } } } } });
    }
    if (!(m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname))) throw new Error(`fake github: unexpected ${method} ${url}`);
    const r = repo(decodeURIComponent(m[1]));
    const rest = m[2] ?? '';
    const q = u.searchParams;

    if (rest === '/installation') return json(200, { id: 4242 });

    // --- git data
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      const sha = r.refs.get(decodeURIComponent(m[1]));
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = body.ref.replace(/^refs\/heads\//, '');
      if (r.refs.has(name)) return json(422, { message: 'Reference already exists' });
      r.refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const name = decodeURIComponent(m[1]);
      const current = r.refs.get(name);
      if (!body.force && current && !ancestors(r, body.sha).includes(current)) return json(422, { message: 'Update is not a fast forward' });
      r.refs.set(name, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'DELETE') {
      r.refs.delete(decodeURIComponent(m[1]));
      return { ok: true, status: 204, json: async () => null, text: async () => '' };
    }
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const c = r.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json(404, {});
    }
    if (rest === '/git/commits' && method === 'POST') {
      const id = putCommit(r, { tree: body.tree, parents: body.parents, message: body.message, author: body.author, committer: body.committer });
      return json(201, { sha: id });
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const t = r.trees.get(m[1]);
      if (!t) return json(404, {});
      return json(200, { sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, sha, type: 'blob', size: r.blobs.get(sha).length })) });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const files = body.base_tree ? new Map(r.trees.get(body.base_tree)) : new Map();
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!files.has(e.path)) return json(422, { message: `path ${e.path} not in tree` });
          files.delete(e.path);
        } else {
          if (!r.blobs.has(e.sha)) return json(422, { message: 'blob not found' });
          files.set(e.path, e.sha);
        }
      }
      return json(201, { sha: putTree(r, files) });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      return json(201, { sha: putBlob(r, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const b = r.blobs.get(m[1]);
      return b ? json(200, { encoding: 'base64', content: b.toString('base64').replace(/.{60}/g, '$&\n') }) : json(404, {});
    }

    // --- history
    if (rest === '/commits' && method === 'GET') {
      const start = r.refs.get(q.get('sha')) ?? q.get('sha');
      const path = q.get('path');
      const since = q.get('since');
      const out = [];
      for (const id of ancestors(r, start)) {
        const c = r.commits.get(id);
        const parent = c.parents[0];
        if (path && filesAt(r, id).get(path) === (parent ? filesAt(r, parent).get(path) : undefined)) continue;
        if (since && c.date < since) continue;
        out.push(commitJson(r, id));
      }
      const per = Number(q.get('per_page') ?? 30);
      const page = Number(q.get('page') ?? 1);
      return json(200, out.slice((page - 1) * per, page * per));
    }
    if ((m = /^\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const c = r.commits.get(m[1]);
      if (!c) return json(404, { message: 'Not Found' });
      const parent = c.parents[0];
      return json(200, { ...commitJson(r, m[1]), parents: c.parents.map((sha) => ({ sha })), files: parent ? diff(r, parent, m[1]) : [] });
    }
    if ((m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const [a, b] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])].map((x) => r.refs.get(x) ?? x);
      if (!r.commits.has(a) || !r.commits.has(b)) return json(404, { message: 'Not Found' });
      const behind = new Set(ancestors(r, a));
      const commits = ancestors(r, b).filter((id) => !behind.has(id)).reverse();
      const ahead = new Set(ancestors(r, b));
      const behindBy = ancestors(r, a).filter((id) => !ahead.has(id)).length;
      return json(200, { ahead_by: commits.length, behind_by: behindBy, status: behindBy ? (commits.length ? 'diverged' : 'behind') : commits.length ? 'ahead' : 'identical', commits: commits.map((id) => commitJson(r, id)), files: diff(r, a, b) });
    }

    // --- issues
    if (rest === '/issues' && method === 'GET') {
      const want = q.get('labels');
      const list = [...r.issues.values()].filter((i) => i.state === q.get('state') && (!want || i.labels.some((l) => l.name === want))).reverse();
      return json(200, list);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const i = r.issues.get(Number(m[1])) ?? r.pulls.get(Number(m[1]));
      if (!i) return json(404, {});
      if (method === 'PATCH') Object.assign(i, body);
      return json(200, i);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest)) && method === 'POST') {
      const i = r.issues.get(Number(m[1])) ?? r.pulls.get(Number(m[1]));
      i.comments.push(body.body);
      return json(201, { id: 1 });
    }
    if ((m = /^\/issues\/(\d+)\/events$/.exec(rest))) return json(200, r.issues.get(Number(m[1]))?.events ?? []);
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(rest)) && method === 'POST') {
      const i = r.issues.get(Number(m[1]));
      for (const name of body.labels) {
        if (!i.labels.some((l) => l.name === name)) i.labels.push({ name });
        i.events.push({ event: 'labeled', label: { name }, created_at: tick() });
      }
      return json(200, i.labels);
    }
    if ((m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(rest)) && method === 'DELETE') {
      const i = r.issues.get(Number(m[1]));
      const name = decodeURIComponent(m[2]);
      if (!i.labels.some((l) => l.name === name)) return json(404, {});
      i.labels = i.labels.filter((l) => l.name !== name);
      return json(200, i.labels);
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && method === 'GET') return r.labels.has(decodeURIComponent(m[1])) ? json(200, {}) : json(404, {});
    if (rest === '/labels' && method === 'POST') { r.labels.add(body.name); return json(201, {}); }

    // --- pulls
    if (rest === '/pulls' && method === 'GET') {
      const head = q.get('head');
      const list = [...r.pulls.values()].filter((p) => (q.get('state') === 'all' || p.state === 'open')
        && (!q.get('base') || p.base.ref === q.get('base'))
        && (!head || `${r.full.split('/')[0]}:${p.head.ref}` === head)).reverse();
      return json(200, list);
    }
    if (rest === '/pulls' && method === 'POST') {
      const number = addPull(r.full, { head: body.head, base: body.base, title: body.title, user: 'textbook-suggest-edit[bot]' });
      r.pulls.get(number).body = body.body;
      r.pulls.get(number).node_id = `PR_${number}`;
      return json(201, r.pulls.get(number));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const p = r.pulls.get(Number(m[1]));
      if (!p) return json(404, {});
      if (method === 'PATCH') Object.assign(p, body);
      return json(200, p);
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(rest))) {
      const p = r.pulls.get(Number(m[1]));
      return json(200, diff(r, r.refs.get(p.base.ref), r.refs.get(p.head.ref)));
    }
    if ((m = /^\/pulls\/(\d+)\/commits$/.exec(rest))) return json(200, r.pulls.get(Number(m[1])).prCommits);
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const p = r.pulls.get(Number(m[1]));
      if (!p.mergeable) return json(405, { message: 'not mergeable' });
      const baseHead = r.refs.get(p.base.ref);
      const headSha = r.refs.get(p.head.ref);
      const tree = r.commits.get(headSha).tree;
      const parents = body.merge_method === 'merge' ? [baseHead, headSha] : [baseHead];
      const id = putCommit(r, { tree, parents, message: `${body.commit_title}\n\n${body.commit_message ?? ''}`, author: { name: 'textbook-suggest-edit[bot]', email: 'bot@example.invalid' } });
      r.refs.set(p.base.ref, id);
      p.state = 'closed';
      p.merged = true;
      p.merge_commit_sha = id;
      p.merged_at = tick();
      p.mergeBody = body;
      return json(200, { merged: true, sha: id });
    }
    throw new Error(`fake github: unexpected ${method} ${url}`);
  }

  return { state, repo, commitFiles, textAt, addIssue, addPull, fetch: fetchImpl, filesAt: (full, c) => filesAt(repo(full), c) };
}
