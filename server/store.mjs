/**
 * The todos, in one SQLite file (node:sqlite — built into Node 22.13+, so the
 * backend has no dependencies to install).
 *
 * Every row belongs to a SESSION: the page makes one id per browser tab
 * (sessionStorage) and sends it on every request. The nightly runs ~65 jobs
 * at once against this one backend; without sessions they would all share one
 * list and every count assertion would fail. Rows are swept a day after they
 * were written — this is a test target, not a place to keep anything.
 */
import { DatabaseSync } from 'node:sqlite';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function openStore(path) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS todo (
    session    TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    title      TEXT,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    PRIMARY KEY (session, id)
  )`);

  const row = (r) => ({ id: r.id, ...(r.title === null ? {} : { title: r.title }), done: Boolean(r.done) });
  const list = db.prepare('SELECT * FROM todo WHERE session = ? ORDER BY position');
  const insert = db.prepare(
    'INSERT INTO todo (session, id, title, done, created_at, position) VALUES (?, ?, ?, 0, ?, ' +
      '(SELECT COALESCE(MAX(position), 0) + 1 FROM todo WHERE session = ?))');
  const get = db.prepare('SELECT * FROM todo WHERE session = ? AND id = ?');

  return {
    list: (session) => list.all(session).map(row),
    get: (session, id) => {
      const r = get.get(session, id);
      return r ? row(r) : null;
    },
    insert(session, id, title, now = Date.now()) {
      insert.run(session, id, title, now, session);
      return this.get(session, id);
    },
    setDone(session, id, done) {
      const changed = db.prepare('UPDATE todo SET done = ? WHERE session = ? AND id = ?').run(done ? 1 : 0, session, id);
      return changed.changes ? this.get(session, id) : null;
    },
    remove: (session, id) => db.prepare('DELETE FROM todo WHERE session = ? AND id = ?').run(session, id).changes > 0,
    clear: (session) => db.prepare('DELETE FROM todo WHERE session = ?').run(session),
    count: (session) => db.prepare('SELECT COUNT(*) AS n FROM todo WHERE session = ?').get(session).n,
    total: () => db.prepare('SELECT COUNT(*) AS n FROM todo').get().n,
    sweep: (now = Date.now()) => db.prepare('DELETE FROM todo WHERE created_at < ?').run(now - DAY_MS).changes,
    close: () => db.close(),
  };
}
