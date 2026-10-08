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

import { previewRunner } from './previews.mjs';
import { createServer } from './server.mjs';
import { DAY_MS, openStore } from './store.mjs';
import { LIMITS } from './todos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://nitinkumar-saucelabs.github.io';

async function listening(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
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
  after(() => server.close());

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

  test('rows are swept a day after they were written', () => {
    const local = openStore(':memory:');
    local.insert('session-old', 'a', 'old', Date.now() - DAY_MS - 1);
    local.insert('session-old', 'b', 'new');
    assert.equal(local.sweep(), 1);
    assert.deepEqual(local.list('session-old').map((t) => t.id), ['b']);
  });
});

describe('backend previews', () => {
  let server, base, work, runner;
  const TOKEN = 'preview-token';
  const BRANCH = 'sauce-verify/fix-d-1-1008120000';

  before(async () => {
    // A repository with this server/ on a fix branch, as Verify's branch would be.
    work = mkdtempSync(join(tmpdir(), 'todo-previews-'));
    const repo = join(work, 'origin');
    cpSync(HERE, join(repo, 'server'), { recursive: true, filter: (p) => !p.includes('.db') && !p.includes('.previews') });
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '--quiet', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'server');
    git('branch', BRANCH);
    runner = previewRunner({ repoUrl: repo, dir: join(work, 'previews'), token: TOKEN,
                             publicUrl: 'https://todo-api.example', childEnv: { ALLOWED_ORIGINS: ORIGIN } });
    server = createServer({ store: openStore(':memory:'), previews: runner });
    base = await listening(server);
  });
  after(() => {
    runner.stopAll();
    server.close();
    rmSync(work, { recursive: true, force: true });
  });

  const start = (body, token = TOKEN) => fetch(`${base}/previews`, {
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
    assert.equal((await client(base, 'session-preview')('GET', '/api/todos')).body.length, 0,
                 'and its database is its own');

    assert.equal((await start({ ref: BRANCH })).status, 201, 'asked again: the same one, kept longer');
    assert.equal(runner.running.size, 1);
  });

  test('only with the token, and only for sauce-verify fix branches that exist', async () => {
    assert.equal((await start({ ref: BRANCH }, 'wrong')).status, 401);
    assert.equal((await start({ ref: 'main' })).status, 400);
    assert.equal((await start({ ref: 'sauce-verify/fix-x;rm -rf /' })).status, 400);
    assert.equal((await start({ ref: 'sauce-verify/fix-missing' })).status, 404);
    assert.equal((await fetch(`${base}/preview/0123456789ab/api/todos`)).status, 404);
  });
});
