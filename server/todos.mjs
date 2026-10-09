/**
 * The todo API, and the deliberate defects that live in the BACKEND.
 *
 * The page sends the defect it was opened with (`?bug=`, or the /verify/
 * page's variant.json) as `X-Todo-Bug`, so one backend serves every variant
 * at once — the nightly runs all of them together.
 *
 *   bug=app      saving a todo is refused (500)       -> APP BUG, fixed HERE
 *   bug=render   a saved todo comes back with no title -> APP BUG: the page shows
 *                                                        a nameless row (its renderer
 *                                                        guards since 30 Sep)
 *
 * The other defects (selector, submit, flaky) are the page's, in app/app.js.
 *
 *   GET    /api/todos          the session's todos, in order
 *   POST   /api/todos          {title}  → 201 the new todo
 *   PATCH  /api/todos/:id      {done}   → the todo
 *   DELETE /api/todos/:id               → 204
 *   POST   /api/seed           {count}  → the session's todos, replaced by N seeded ones
 */
import { randomUUID } from 'node:crypto';

export const LIMITS = { titleChars: 200, perSession: 100, total: 50_000, seed: 20 };

/** What a handler answers: a status and a JSON body (none for 204). */
const answer = (status, body) => ({ status, body });
const refuse = (status, error) => answer(status, { error });

export function handle(store, { method, path, body, session, bug }) {
  if (path === '/api/todos' && method === 'GET') return answer(200, store.list(session));
  if (path === '/api/todos' && method === 'POST') return create(store, session, body, bug);
  if (path === '/api/seed' && method === 'POST') return seed(store, session, body);
  const one = path.match(/^\/api\/todos\/([A-Za-z0-9-]{1,64})$/);
  if (one && method === 'PATCH') {
    if (typeof body?.done !== 'boolean') return refuse(400, 'done must be true or false');
    const todo = store.setDone(session, one[1], body.done);
    return todo ? answer(200, todo) : refuse(404, 'no such todo');
  }
  if (one && method === 'DELETE') {
    return store.remove(session, one[1]) ? answer(204) : refuse(404, 'no such todo');
  }
  return refuse(404, 'no such route');
}

function create(store, session, body, bug) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) return refuse(400, 'a todo needs a title');
  if (title.length > LIMITS.titleChars) return refuse(400, `a title is at most ${LIMITS.titleChars} characters`);
  if (store.count(session) >= LIMITS.perSession) return refuse(429, `at most ${LIMITS.perSession} todos per session`);
  if (store.total() >= LIMITS.total) return refuse(503, 'the backend is full; try again tomorrow');

  // ?bug=render: the row is saved and handed back without its title.
  return answer(201, store.insert(session, randomUUID(), bug === 'render' ? null : title));
}

function seed(store, session, body) {
  const count = Number(body?.count);
  if (!Number.isInteger(count) || count < 0 || count > LIMITS.seed) {
    return refuse(400, `count is a whole number from 0 to ${LIMITS.seed}`);
  }
  // The total cap holds for seeds too (9 Oct review: they bypassed it).
  if (store.total() - store.count(session) + count > LIMITS.total) {
    return refuse(503, 'the backend is full; try again later');
  }
  store.clear(session);
  for (let n = 1; n <= count; n += 1) store.insert(session, `seed-${n}`, `Seeded todo ${n}`);
  return answer(200, store.list(session));
}
