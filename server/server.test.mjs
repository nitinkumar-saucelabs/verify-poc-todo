/**
 * The backend, through HTTP: `node --test server/`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { directLauncher, previewRunner } from './previews.mjs';
import { createServer, writeLimiter } from './server.mjs';
import { DAY_MS, openStore } from './store.mjs';
import { LIMITS } from './todos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://nitinkumar-saucelabs.github.io';

async function listening(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A server for one test, closed (and its previews stopped) whatever the test does — a failing
 *  test that left one listening kept `node --test` waiting for ever. */
async function serving(t, options) {
  const server = createServer(options);
  t.after(async () => {
    await options.previews?.stopAll();
    server.closeAllConnections?.();
    server.close();
  });
  return listening(server);
}

function client(base, session = 'session-aaaa', bug = 'none') {
  return async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Todo-Session': session, 'X-Todo-Bug': bug, Origin: ORIGIN,
                 ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

describe('the todo API', () => {
  let server, base, store;
  before(async () => {
    store = openStore(':memory:');
    server = createServer({ store });
    base = await listening(server);
  });
  after(() => { server.closeAllConnections(); server.close(); });

  test('a session adds, completes, lists and deletes its todos', async () => {
    const api = client(base, 'session-crud');
    const added = await api('POST', '/api/todos', { title: '  Buy milk ' });
    assert.equal(added.status, 201);
    assert.equal(added.body.title, 'Buy milk');
    assert.equal((await api('PATCH', `/api/todos/${added.body.id}`, { done: true })).body.done, true);
    assert.deepEqual((await api('GET', '/api/todos')).body, [{ id: added.body.id, title: 'Buy milk', done: true }]);
    assert.equal((await api('DELETE', `/api/todos/${added.body.id}`)).status, 204);
    assert.deepEqual((await api('GET', '/api/todos')).body, []);
  });

  test('sessions never see each other: the nightly runs ~65 jobs on one backend', async () => {
    await client(base, 'session-one')('POST', '/api/todos', { title: 'mine' });
    assert.deepEqual((await client(base, 'session-two')('GET', '/api/todos')).body, []);
  });

  test('seeding replaces the session’s todos, in order', async () => {
    const api = client(base, 'session-seed');
    await api('POST', '/api/todos', { title: 'gone after seeding' });
    const seeded = await api('POST', '/api/seed', { count: 2 });
    assert.deepEqual(seeded.body.map((t) => t.title), ['Seeded todo 1', 'Seeded todo 2']);
    assert.deepEqual((await api('POST', '/api/seed', { count: 2 })).body.length, 2, 'seeding again is idempotent');
  });

  test('?bug=app: every save is refused, and nothing is kept', async () => {
    const api = client(base, 'session-app', 'app');
    const refused = await api('POST', '/api/todos', { title: 'Buy milk' });
    assert.equal(refused.status, 500);
    assert.equal(refused.body.error, 'the backend refuses to save');
    assert.deepEqual((await api('GET', '/api/todos')).body, []);
  });

  test('?bug=render: the todo comes back without its title', async () => {
    const api = client(base, 'session-render', 'render');
    const saved = await api('POST', '/api/todos', { title: 'Buy milk' });
    assert.equal(saved.status, 201);
    assert.equal('title' in saved.body, false);
  });

  test('requests without a session, with bad bodies, or over the limits are refused', async () => {
    const api = client(base, 'session-limits');
    assert.equal((await client(base, 'x')('GET', '/api/todos')).status, 400);
    assert.equal((await api('POST', '/api/todos', { title: '' })).status, 400);
    assert.equal((await api('POST', '/api/todos', { title: 'x'.repeat(LIMITS.titleChars + 1) })).status, 400);
    assert.equal((await api('PATCH', '/api/todos/nope', { done: 'yes' })).status, 400);
    assert.equal((await api('PATCH', '/api/todos/nope', { done: true })).status, 404);
    assert.equal((await api('POST', '/api/seed', { count: LIMITS.seed + 1 })).status, 400);
    assert.equal((await api('POST', '/api/todos', 'x'.repeat(9000))).status, 413);
    const raw = await fetch(`${base}/api/todos`, { method: 'POST', body: '{nope', headers: { 'X-Todo-Session': 'session-limits' } });
    assert.equal(raw.status, 400);
  });

  test('a session holds at most the limit', async () => {
    const api = client(base, 'session-full');
    for (let n = 0; n < LIMITS.perSession; n += 1) await api('POST', '/api/todos', { title: `t${n}` });
    assert.equal((await api('POST', '/api/todos', { title: 'one more' })).status, 429);
  });

  test('the page’s origins may call it across origins; others get no CORS', async () => {
    const preflight = await fetch(`${base}/api/todos`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Todo-Session/);
    const other = await client(base)('GET', '/api/todos', undefined, { Origin: 'https://evil.example' });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  test('rows are swept a day after they were written, or sooner when told', () => {
    const local = openStore(':memory:');
    local.insert('session-old', 'a', 'old', Date.now() - DAY_MS - 1);
    local.insert('session-old', 'b', 'new');
    assert.equal(local.sweep(), 1);
    assert.deepEqual(local.list('session-old').map((t) => t.id), ['b']);

    const vm = openStore(':memory:', { keepMs: 2 * 3_600_000 });
    vm.insert('s-vm', 'a', 'three hours old', Date.now() - 3 * 3_600_000);
    vm.insert('s-vm', 'b', 'an hour old', Date.now() - 3_600_000);
    assert.equal(vm.sweep(), 1);
  });

  test('a seed cannot go past the total cap (9 Oct review: it bypassed it)', async (t) => {
    const full = { ...openStore(':memory:'), total: () => LIMITS.total, count: () => 0, clear() {}, insert() {} };
    const capBase = await serving(t, { store: full });
    assert.equal((await client(capBase, 'session-seed-cap')('POST', '/api/seed', { count: 5 })).status, 503);
  });

  test('one address may change only so much a minute; the nightly is far below it', () => {
    let t = 0;
    const allow = writeLimiter(3, 60_000, () => t);
    const from = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
    assert.deepEqual([1, 2, 3, 4].map(() => allow(from('203.0.113.9'))), [true, true, true, false]);
    assert.equal(allow(from('127.0.0.1', '198.51.100.1, 203.0.113.7')), true, 'behind Caddy: the last forwarded address');
    assert.equal(allow(from('203.0.113.8', '203.0.113.9')), true, 'a forwarded header from elsewhere is not trusted');
    t = 60_000;
    assert.equal(allow(from('203.0.113.9')), true, 'a minute later');
  });

  test('too many changes from one address are refused, reads are not', async (t) => {
    const limitedBase = await serving(t, { store: openStore(':memory:'), allowWrite: writeLimiter(1) });
    const api = client(limitedBase, 'session-limit');
    assert.equal((await api('POST', '/api/todos', { title: 'one' })).status, 201);
    assert.equal((await api('POST', '/api/todos', { title: 'two' })).status, 429);
    assert.equal((await api('GET', '/api/todos')).status, 200);
  });
});

describe('backend previews', () => {
  let server, base, work, runner, repo, starts;
  const TOKEN = 'preview-token';
  const BRANCH = 'sauce-verify/fix-d-1-1008120000';
  const OTHER = 'sauce-verify/fix-d-2-1008120000';

  function counting(launcher) {
    return { start: (...a) => { starts.push(a[0]); return launcher.start(...a); }, stop: launcher.stop };
  }

  function runnerFor(extra = {}) {
    return previewRunner({ repoUrl: repo, dir: join(work, 'previews'), token: TOKEN, publicUrl: 'https://todo-api.example',
                           launcher: counting(directLauncher({ ALLOWED_ORIGINS: ORIGIN })), origins: [ORIGIN], ...extra });
  }

  before(async () => {
    // A repository with this server/ on two fix branches, as Verify's branches would be.
    work = mkdtempSync(join(tmpdir(), 'todo-previews-'));
    repo = join(work, 'origin');
    cpSync(HERE, join(repo, 'server'), { recursive: true, filter: (p) => !p.includes('.db') && !p.includes('.previews') });
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '--quiet', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'server');
    git('branch', BRANCH);
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'another fix');
    git('branch', OTHER);
    starts = [];
    runner = runnerFor();
    await runner.load();
    server = createServer({ store: openStore(':memory:'), previews: runner });
    base = await listening(server);
  });
  after(async () => {
    await runner.stopAll();
    server.closeAllConnections();
    server.close();
    rmSync(work, { recursive: true, force: true });
  });

  const start = (body, token = TOKEN, at = base) => fetch(`${at}/previews`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('a fix branch’s backend starts, and is reached under /preview/<commit>/', async () => {
    const started = await start({ ref: BRANCH });
    assert.equal(started.status, 201);
    const { url, sha } = await started.json();
    assert.equal(url, `https://todo-api.example/preview/${sha.slice(0, 12)}`);

    const api = client(`${base}/preview/${sha.slice(0, 12)}`, 'session-preview', 'app');
    const refused = await api('POST', '/api/todos', { title: 'Buy milk' });
    assert.equal(refused.status, 500, 'the branch’s own code answers (this branch still has the bug)');
    assert.equal(refused.headers.get('access-control-allow-origin'), ORIGIN, 'its own CORS, through the proxy');
    assert.equal((await client(base, 'session-preview')('GET', '/api/todos')).body.length, 0,
                 'and its database is its own');

    assert.equal((await start({ ref: BRANCH })).status, 201, 'asked again: the same one, kept longer');
    assert.equal(runner.running.size, 1);
  });

  test('two asks for one commit at once start it once', async (t) => {
    // A launcher slow enough that the second ask always arrives mid-start.
    const direct = directLauncher({ ALLOWED_ORIGINS: ORIGIN });
    let launched = 0;
    const slow = { start: async (...a) => { launched += 1; await new Promise((r) => setTimeout(r, 800)); return direct.start(...a); },
                   stop: direct.stop };
    const once = previewRunner({ repoUrl: repo, dir: join(work, 'once'), token: TOKEN, publicUrl: 'https://todo-api.example',
                                 launcher: slow, origins: [ORIGIN] });
    await once.load();
    const onceBase = await serving(t, { store: openStore(':memory:'), previews: once });
    const [a, b] = await Promise.all([start({ ref: BRANCH }, TOKEN, onceBase), start({ ref: BRANCH }, TOKEN, onceBase)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(launched, 1);
  });

  test('a restarted runner finds the previews still running and proxies them again', async () => {
    const { sha } = await (await start({ ref: BRANCH })).json();
    const again = runnerFor();
    await again.load();
    assert.ok(again.running.has(sha.slice(0, 12)), 'from the registry, after a health check');
    again.detach();
  });

  test('the oldest makes room, and a gone preview answers 404 the page can read', async (t) => {
    await runner.stopAll();
    const one = runnerFor({ max: 1 });
    const oneBase = await serving(t, { store: openStore(':memory:'), previews: one });
    const first = (await (await start({ ref: BRANCH }, TOKEN, oneBase)).json()).sha.slice(0, 12);
    const second = (await (await start({ ref: OTHER }, TOKEN, oneBase)).json()).sha.slice(0, 12);
    assert.notEqual(first, second);
    assert.deepEqual([...one.running.keys()], [second]);
    const gone = await fetch(`${oneBase}/preview/${first}/api/todos`, { headers: { Origin: ORIGIN } });
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get('access-control-allow-origin'), ORIGIN, 'a network error would read as the fix failing');
  });

  test('a preview stops when its time is up', async (t) => {
    const brief = runnerFor({ ttlMs: 300 });
    const briefBase = await serving(t, { store: openStore(':memory:'), previews: brief });
    const sha12 = (await (await start({ ref: OTHER }, TOKEN, briefBase)).json()).sha.slice(0, 12);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(brief.running.size, 0);
    assert.equal((await fetch(`${briefBase}/preview/${sha12}/health`)).status, 404);
  });

  test('a backend that never comes up is a 502, not a hang', async (t) => {
    const dud = runnerFor({ launcher: { start: async () => {}, stop: async () => {} } });
    const dudBase = await serving(t, { store: openStore(':memory:'), previews: dud });
    const answer = await start({ ref: BRANCH }, TOKEN, dudBase);
    assert.equal(answer.status, 502);
    assert.match((await answer.json()).error, /did not start/);
  });

  test('only with the token, and only for sauce-verify fix branches that exist', async () => {
    assert.equal((await start({ ref: BRANCH }, 'wrong')).status, 401);
    assert.equal((await start({ ref: 'main' })).status, 400);
    assert.equal((await start({ ref: 'sauce-verify/fix-x;rm -rf /' })).status, 400);
    assert.equal((await start({ ref: 'sauce-verify/fix-missing' })).status, 404);
    assert.equal((await fetch(`${base}/preview/0123456789ab/api/todos`)).status, 404);
  });
});
