/**
 * The todo app's backend (8 Oct). `node server/server.mjs` — no dependencies.
 *
 * The page on GitHub Pages calls it across origins, so it answers CORS for the
 * origins in ALLOWED_ORIGINS. Every request names its session (X-Todo-Session)
 * and the defect the page was opened with (X-Todo-Bug); see todos.mjs.
 *
 * Environment:
 *   PORT, HOST          where to listen (8095 on 127.0.0.1; PORT=0 picks one)
 *   TODO_DB             the SQLite file (server/todos.db; ':memory:' for a preview)
 *   ALLOWED_ORIGINS     comma-separated origins the page may call from
 *   PREVIEW_TOKEN       set: this backend also starts fix branches' backends
 *   PREVIEW_DIR, PUBLIC_URL, REPO_URL   where previews unpack, are reached, come from
 *   PREVIEW_LAUNCHER    the VM's root-owned wrapper (run with sudo) that starts a preview as its own
 *                       user; unset: a child process of this one (tests, a laptop) — see previews.mjs
 *   WRITE_LIMIT         saves per minute from one address (300); TODO_KEEP_HOURS  rows kept (2)
 */
import { realpathSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { commandLauncher, directLauncher, previewRunner } from './previews.mjs';
import { openStore } from './store.mjs';
import { handle } from './todos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const BUG = /^[a-z]{1,20}$/;
const MAX_BODY = 8 * 1024;
const WRITES = ['POST', 'PATCH', 'DELETE'];
export const DEFAULT_ORIGINS = ['https://nitinkumar-saucelabs.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];

/**
 * At most `limit` writes a minute from one address (9 Oct review: sessions are
 * the client's to choose, so a caller could fill the database in a minute and
 * the healthy app would answer 503 for a day). The nightly writes a few per job.
 * Behind Caddy on loopback, the address is the last X-Forwarded-For entry.
 */
export function writeLimiter(limit = 300, windowMs = 60_000, now = Date.now) {
  const seen = new Map();
  return (req) => {
    const peer = req.socket.remoteAddress || '';
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((a) => a.trim()).filter(Boolean);
    const from = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && forwarded.length ? forwarded.at(-1) : peer;
    const t = now();
    const entry = seen.get(from);
    if (!entry || t - entry.since >= windowMs) {
      seen.set(from, { since: t, count: 1 });
      if (seen.size > 10_000) seen.delete(seen.keys().next().value);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function createServer({ store, origins = DEFAULT_ORIGINS, previews = null, allowWrite = writeLimiter() }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://backend');
    try {
      if (previews && (await previews.handle(req, res, url, () => readJson(req)))) return;
      cors(req, res, origins);
      if (req.method === 'OPTIONS') return end(res, 204);
      if (url.pathname === '/health') return end(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) return end(res, 404, { error: 'no such route' });
      const session = req.headers['x-todo-session'];
      if (!SESSION.test(String(session || ''))) return end(res, 400, { error: 'X-Todo-Session names the session' });
      if (WRITES.includes(req.method) && !allowWrite(req)) {
        return end(res, 429, { error: 'too many changes from this address — try again in a minute' });
      }
      const bug = BUG.test(String(req.headers['x-todo-bug'] || '')) ? req.headers['x-todo-bug'] : 'none';
      const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : null;
      const { status, body: out } = handle(store, { method: req.method, path: url.pathname, body, session, bug });
      return end(res, status, out);
    } catch (error) {
      return end(res, error.status || 500, { error: error.status ? error.message : 'the backend failed' });
    }
  });
}

function cors(req, res, origins) {
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Todo-Session, X-Todo-Bug');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  res.setHeader('Vary', 'Origin');
}

function end(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk); // past the limit: drained, not kept, so the 413 is heard
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('the body is too large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('the body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// --- run it --------------------------------------------------------------------------

// Real paths: a script reached through a symlink (macOS /var → /private/var) is still this one.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const env = process.env;
  const store = openStore(env.TODO_DB || join(HERE, 'todos.db'), { keepMs: Number(env.TODO_KEEP_HOURS || 2) * 3_600_000 });
  const origins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : DEFAULT_ORIGINS;
  const launcher = env.PREVIEW_LAUNCHER ? commandLauncher(env.PREVIEW_LAUNCHER)
    : directLauncher({ ALLOWED_ORIGINS: origins.join(',') });
  const previews = env.PREVIEW_TOKEN
    ? previewRunner({ repoUrl: env.REPO_URL, dir: env.PREVIEW_DIR || join(HERE, '.previews'), token: env.PREVIEW_TOKEN,
                      publicUrl: env.PUBLIC_URL || '', launcher, origins })
    : null;
  await previews?.load();
  const server = createServer({ store, origins, previews, allowWrite: writeLimiter(Number(env.WRITE_LIMIT || 300)) });
  server.listen(Number(env.PORT ?? 8095), env.HOST || '127.0.0.1', () => {
    console.log(`listening on ${server.address().port}`);
  });
  const sweep = setInterval(() => store.sweep(), 10 * 60_000);
  sweep.unref();
  store.sweep();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      // On the VM a preview is its own unit and outlives this process: the
      // restarted backend finds it in the registry. A child process cannot.
      if (env.PREVIEW_LAUNCHER) previews?.detach();
      else await previews?.stopAll();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
