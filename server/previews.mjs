/**
 * Backend previews: a fix branch's backend, started for Sauce Verify's proof.
 *
 * Verify proves a fix to the page on a Pages preview (/preview/<commit>/).
 * A fix to THIS backend needs the branch's backend running too, so the proof
 * walk can call it. This runner, on the live backend, starts one on request:
 *
 *   POST /previews  {"ref": "sauce-verify/fix-…"}   Authorization: Bearer <PREVIEW_TOKEN>
 *     → 201 {"url": "<PUBLIC_URL>/preview/<sha12>", "sha": "…", "expires_at": "…"}
 *   ANY  /preview/<sha12>/<path>   → that backend's <path>
 *
 * Asking again for a running one keeps it running for another TTL. Only
 * `sauce-verify/fix-*` branches, only with the token, at most MAX at once.
 *
 * WHO RUNS THE CODE (9 Oct review). A branch's server is model-written code,
 * so it must not run as this process: on the VM the launcher is
 * `sudo /usr/local/bin/todo-preview`, which starts it as another user in its
 * own systemd unit — no access to this process, its environment, the token
 * file or the live database, no network beyond loopback, and outside this
 * service's cgroup, so restarting the live backend does not kill a proof in
 * progress (the registry file lets the restarted one find it again). The
 * direct launcher, for tests and a laptop, is a child process of this one and
 * shares its user: it isolates nothing.
 */
import { execFile, spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REF = /^sauce-verify\/fix-[A-Za-z0-9._-]{1,100}$/;
const SHA12 = /^[0-9a-f]{12}$/;
const START_MS = 15_000;
const PROXY_TIMEOUT_MS = 30_000;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

/** Starts a preview's server on a port, and stops it — as a child process (tests, a laptop). */
export function directLauncher(childEnv = {}) {
  const children = new Map();
  return {
    async start(sha12, dir, port) {
      const child = spawn(process.execPath, ['--no-warnings', join(dir, 'server', 'server.mjs')], {
        env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', TODO_DB: ':memory:', ...childEnv },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      children.set(sha12, child);
      child.on('exit', () => children.get(sha12) === child && children.delete(sha12));
    },
    async stop(sha12) {
      children.get(sha12)?.kill();
      children.delete(sha12);
    },
  };
}

/** The VM's: a root-owned wrapper that runs the preview as its own user in its own unit. */
export function commandLauncher(command) {
  return {
    start: (sha12, dir, port) => run('sudo', ['-n', command, 'start', sha12, String(port)], { timeout: 30_000 }),
    stop: (sha12) => run('sudo', ['-n', command, 'stop', sha12], { timeout: 30_000 }).catch(() => {}),
  };
}

export function previewRunner({ repoUrl, dir, token, publicUrl, ttlMs = 60 * 60_000, max = 3,
                                launcher = directLauncher(), origins = [] }) {
  const running = new Map(); // sha12 → { port, expiresAt, timer }
  const starting = new Map(); // sha12 → Promise: one start per commit at a time
  let git = Promise.resolve(); // one fetch at a time: they share repo.git and FETCH_HEAD
  const registry = join(dir, 'registry.json');

  function save() {
    const entries = Object.fromEntries([...running].map(([sha, p]) => [sha, { port: p.port, expiresAt: p.expiresAt }]));
    writeFileSync(registry, JSON.stringify(entries));
  }

  function arm(sha12, preview) {
    clearTimeout(preview.timer);
    preview.timer = setTimeout(() => stop(sha12), Math.max(0, preview.expiresAt - Date.now()));
    preview.timer.unref();
  }

  async function stop(sha12) {
    const preview = running.get(sha12);
    if (!preview) return;
    clearTimeout(preview.timer);
    running.delete(sha12);
    save();
    await launcher.stop(sha12);
    rmSync(join(dir, sha12), { recursive: true, force: true });
  }

  /** After a restart of this process: the previews still running are proxied again. */
  async function load() {
    mkdirSync(dir, { recursive: true });
    let saved = {};
    try {
      saved = JSON.parse(readFileSync(registry, 'utf8'));
    } catch {
      /* none yet */
    }
    for (const [sha12, { port, expiresAt }] of Object.entries(saved)) {
      if (SHA12.test(sha12) && expiresAt > Date.now() && (await healthy(port))) {
        const preview = { port, expiresAt };
        running.set(sha12, preview);
        arm(sha12, preview);
      } else {
        await launcher.stop(sha12);
      }
    }
    save();
  }

  function authorised(header) {
    const given = Buffer.from(String(header || '').replace(/^Bearer /, ''));
    const wanted = Buffer.from(token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  function fetchRef(ref) {
    const turn = git.then(async () => {
      const repo = join(dir, 'repo.git');
      await run('git', ['init', '--quiet', '--bare', repo]);
      await run('git', ['-C', repo, 'fetch', '--quiet', '--depth=1', repoUrl, ref], { timeout: 60_000 });
      const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'FETCH_HEAD']);
      return { repo, sha: stdout.trim() };
    });
    git = turn.catch(() => {});
    return turn;
  }

  async function unpack(repo, sha, into) {
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    await new Promise((resolve, reject) => {
      const archive = spawn('git', ['-C', repo, 'archive', sha, 'server']);
      const tar = spawn('tar', ['-x', '-C', into]);
      archive.stdout.pipe(tar.stdin);
      archive.on('error', reject);
      tar.on('error', reject);
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
  }

  async function launch(sha12, fetched) {
    while (running.size >= max) await stop([...running.keys()][0]); // the oldest makes room
    const into = join(dir, sha12);
    await unpack(fetched.repo, fetched.sha, into);
    const port = await freePort();
    await launcher.start(sha12, into, port);
    if (!(await healthy(port, START_MS))) {
      await launcher.stop(sha12);
      throw new Error('the preview backend did not start');
    }
    return { port };
  }

  async function start(req, res, body) {
    if (!authorised(req.headers.authorization)) return send(res, 401, { error: 'not authorised' });
    const ref = body?.ref;
    if (typeof ref !== 'string' || !REF.test(ref)) return send(res, 400, { error: 'ref must be a sauce-verify/fix-* branch' });
    let fetched;
    try {
      fetched = await fetchRef(ref);
    } catch {
      return send(res, 404, { error: `could not fetch ${ref}` });
    }
    const sha12 = fetched.sha.slice(0, 12);
    if (!running.has(sha12)) {
      if (!starting.has(sha12)) {
        starting.set(sha12, launch(sha12, fetched).finally(() => starting.delete(sha12)));
      }
      try {
        const { port } = await starting.get(sha12);
        if (!running.has(sha12)) running.set(sha12, { port });
      } catch (error) {
        return send(res, 502, { error: String(error.message || error) });
      }
    }
    const preview = running.get(sha12);
    preview.expiresAt = Date.now() + ttlMs;
    arm(sha12, preview);
    save();
    return send(res, 201, { url: `${publicUrl}/preview/${sha12}`, sha: fetched.sha,
                            expires_at: new Date(preview.expiresAt).toISOString() });
  }

  function proxy(req, res, sha12, rest) {
    const preview = running.get(sha12);
    if (!preview) {
      // With CORS: the page must read "gone", not a network error (9 Oct review).
      return send(res, 404, { error: 'no such preview (it may have expired)' }, corsFor(req, origins));
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    const upstream = http.request(
      { host: '127.0.0.1', port: preview.port, method: req.method, path: rest || '/', headers,
        timeout: PROXY_TIMEOUT_MS },
      (answer) => {
        const back = { ...answer.headers };
        for (const name of HOP_BY_HOP) delete back[name];
        res.writeHead(answer.statusCode, back);
        answer.pipe(res);
      });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        send(res, error.message === 'timeout' ? 504 : 502, { error: 'the preview backend did not answer' },
             corsFor(req, origins));
      } else res.destroy();
    });
    req.pipe(upstream);
  }

  return {
    running,
    load,
    /** True when it handled the request. `body` is read only for POST /previews. */
    async handle(req, res, url, readBody) {
      if (url.pathname === '/previews' && req.method === 'POST') {
        await start(req, res, await readBody());
        return true;
      }
      const match = url.pathname.match(/^\/preview\/([0-9a-f]{12})(\/.*)?$/);
      if (!match) return false;
      proxy(req, res, match[1], (match[2] || '/') + url.search);
      return true;
    },
    stopAll: () => Promise.all([...running.keys()].map(stop)),
    /** For a restart of this process: forget the previews without stopping them (they outlive it on the VM). */
    detach: () => [...running.values()].forEach((p) => clearTimeout(p.timer)),
  };
}

function corsFor(req, origins) {
  const origin = req.headers.origin;
  return origin && origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function healthy(port, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  do {
    const ok = await new Promise((resolve) => {
      const probe = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2_000 }, (answer) => {
        answer.resume();
        resolve(answer.statusCode === 200);
      });
      probe.on('error', () => resolve(false));
      probe.on('timeout', () => probe.destroy());
    });
    if (ok) return true;
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  return false;
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}
