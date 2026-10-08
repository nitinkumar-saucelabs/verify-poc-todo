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
 * The branch is fetched from the repository, only `server/` is unpacked, and it
 * runs as a child process on a localhost port with an in-memory database and
 * none of this process's secrets. Only `sauce-verify/fix-*` branches, only with
 * the token, at most MAX at once, each stopped after TTL.
 */
import { execFile, spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REF = /^sauce-verify\/fix-[A-Za-z0-9._-]{1,100}$/;
const START_MS = 15_000;

export function previewRunner({ repoUrl, dir, token, publicUrl, ttlMs = 30 * 60_000, max = 3, childEnv = {} }) {
  const running = new Map(); // sha12 → { port, child, expiresAt, timer }

  function stop(sha12) {
    const preview = running.get(sha12);
    if (!preview) return;
    clearTimeout(preview.timer);
    preview.child.kill();
    running.delete(sha12);
    rmSync(join(dir, sha12), { recursive: true, force: true });
  }

  function authorised(header) {
    const given = Buffer.from(String(header || '').replace(/^Bearer /, ''));
    const wanted = Buffer.from(token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  async function fetchRef(ref) {
    const repo = join(dir, 'repo.git');
    mkdirSync(dir, { recursive: true });
    await run('git', ['init', '--quiet', '--bare', repo]);
    await run('git', ['-C', repo, 'fetch', '--quiet', '--depth=1', repoUrl, ref], { timeout: 60_000 });
    const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'FETCH_HEAD']);
    return { repo, sha: stdout.trim() };
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

  function startChild(into) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(into, 'server', 'server.mjs')], {
        // A clean environment: the child never sees PREVIEW_TOKEN, so it cannot start previews itself.
        env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', TODO_DB: ':memory:', ...childEnv },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the preview backend did not start'));
      }, START_MS);
      let said = '';
      child.stdout.on('data', (chunk) => {
        said += chunk;
        const port = said.match(/listening on (\d+)/)?.[1];
        if (port) {
          clearTimeout(timer);
          resolve({ child, port: Number(port) });
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the preview backend exited (${code})`));
      });
    });
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
      while (running.size >= max) stop([...running.keys()][0]); // the oldest makes room
      try {
        const into = join(dir, sha12);
        await unpack(fetched.repo, fetched.sha, into);
        const { child, port } = await startChild(into);
        running.set(sha12, { port, child });
        child.on('exit', () => running.get(sha12)?.child === child && running.delete(sha12));
      } catch (error) {
        return send(res, 502, { error: String(error.message || error) });
      }
    }
    const preview = running.get(sha12);
    clearTimeout(preview.timer);
    preview.expiresAt = new Date(Date.now() + ttlMs);
    preview.timer = setTimeout(() => stop(sha12), ttlMs);
    preview.timer.unref();
    return send(res, 201, { url: `${publicUrl}/preview/${sha12}`, sha: fetched.sha,
                            expires_at: preview.expiresAt.toISOString() });
  }

  function proxy(req, res, sha12, rest) {
    const preview = running.get(sha12);
    if (!preview) return send(res, 404, { error: 'no such preview (it may have expired)' });
    const upstream = http.request(
      { host: '127.0.0.1', port: preview.port, method: req.method, path: rest || '/', headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
    upstream.on('error', () => send(res, 502, { error: 'the preview backend did not answer' }));
    req.pipe(upstream);
  }

  return {
    running,
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
    stopAll: () => [...running.keys()].forEach(stop),
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
