/**
 * Todo app — the Sauce Verify POC target.
 *
 * A query parameter selects a deliberate defect so the correct triage verdict
 * is known in advance:
 *
 *   ?bug=none      everything works                        -> green
 *   ?bug=app       the backend refuses every save (500)    -> APP BUG
 *   ?bug=flaky     Complete silently fails some of the time-> FLAKE
 *   ?bug=selector  Add button's data-testid is renamed     -> TEST BUG
 *   ?bug=submit    Add button removed; Enter submits       -> TEST BUG (needs a model)
 *   ?bug=render    the backend hands a saved todo back     -> APP BUG, and the one
 *                  with no title; the renderer assumes one    whose fix is a guard
 *
 * The todos live on a backend (server/, 8 Oct), in a session per browser tab;
 * `app` and `render` are the backend's defects, told which one by the
 * X-Todo-Bug header, the others are this page's.
 *
 * Support parameters:
 *   ?seed=N        pre-populate N todos without using the Add path, so specs
 *                  that are not about adding still run under ?bug=app.
 *   ?flakeRate=R   failure probability for ?bug=flaky (default 0.3).
 *   ?api=URL       the backend's API base (https, or http on localhost). The
 *                  /verify/ page takes it from variant.json — a fix's preview
 *                  points it at the fix's own backend.
 */

import { telemetry } from './telemetry.js';

/** The live backend, on the Sauce Verify VM. */
const DEFAULT_API = 'https://todo-api.136.66.24.255.nip.io/api';
const SESSION_KEY = 'verify-poc-session';

const params = new URLSearchParams(location.search);
const config = {
  bug: params.get('bug') || 'none',
  seed: Number(params.get('seed') || 0),
  flakeRate: Number(params.get('flakeRate') ?? 0.3),
  api: apiBase(params.get('api')),
};

/** ?api=, if it is a backend this page may talk to; the live one otherwise. */
function apiBase(given) {
  try {
    const url = new URL(given);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol === 'https:' || local) return url.href.replace(/\/$/, '');
  } catch {
    /* absent or not a URL */
  }
  return DEFAULT_API;
}

/** One session per tab: a reload keeps the list, a new test's browser starts empty. */
function session() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return (window.__verifySession ??= crypto.randomUUID()); // storage blocked: this page load only
  }
}

let todos = [];
let filter = 'all';

/* ---------- the backend ---------- */

/**
 * One request. Throws an Error a person can read, carrying the request that
 * failed — the report names it, the way the triage rules name it from the HAR.
 */
async function request(method, path, body, failed) {
  const url = `${config.api}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Todo-Session': session(), 'X-Todo-Bug': config.bug },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server'), { apiPath: new URL(url).pathname, apiStatus: 0 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`${failed} (${response.status})`),
                        { apiPath: new URL(url).pathname, apiStatus: response.status });
  }
  return response.status === 204 ? null : response.json();
}

/* ---------- defects ---------- */

/** ?bug=flaky: Complete fails part of the time, on unchanged code. */
function completeSilentlyFails() {
  return config.bug === 'flaky' && Math.random() < config.flakeRate;
}

/** ?bug=submit: the Add button is gone; the form is submitted with Enter.
 *
 * Deliberately NOT healable by swapping one data-testid for another: there is
 * no replacement id to find, because the control no longer exists. A human can
 * still add a todo — type and press Enter — so the app is healthy and the test
 * is stale, which is the case a selector matcher cannot express and a model can.
 */
function applySubmitDefect() {
  if (config.bug !== 'submit') return;
  const button = document.querySelector('[data-testid="add-button"]');
  if (button) button.remove();
}

/** ?bug=selector: the button the tests click is renamed. */
function applySelectorDefect() {
  if (config.bug !== 'selector') return;
  const button = document.querySelector('[data-testid="add-button"]');
  if (button) button.setAttribute('data-testid', 'submit-button');
}

/* ---------- actions ---------- */

async function addTodo(title) {
  if (!title.trim()) return;
  // The SDK's own click breadcrumb says `Clicked  BUTTON` — no data-testid,
  // no typed value. These manual ones carry what a generated test needs.
  telemetry.crumb('add todo', { testid: 'new-form', title: title.trim() });
  // Under ?bug=app the backend refuses this (500); under ?bug=render it hands
  // the row back without its title — the defect is the DATA, so the honest fix
  // is a guard where it is read, and render() is where it throws.
  const saved = await request('POST', '/todos', { title: title.trim() }, 'Could not save todo');
  todos.push(saved);
  telemetry.crumb('todo added', { count: todos.length });
  render();
}

async function toggleTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  if (completeSilentlyFails()) return render(); // no state change, no error shown
  const saved = await request('PATCH', `/todos/${id}`, { done: !todo.done }, 'Could not update todo');
  todo.done = saved.done;
  telemetry.crumb(todo.done ? 'todo completed' : 'todo reopened', { testid: 'toggle', title: todo.title });
  render();
}

async function deleteTodo(id) {
  const todo = todos.find((t) => t.id === id);
  await request('DELETE', `/todos/${id}`, undefined, 'Could not delete todo');
  todos = todos.filter((t) => t.id !== id);
  telemetry.crumb('todo deleted', { testid: 'delete', title: todo?.title });
  render();
}

/** An action that failed says so on the page, as the add always has. */
function reporting(action) {
  return async (...args) => {
    clearError();
    try {
      await action(...args);
    } catch (error) {
      showError(error.message);
      render();
    }
  };
}

function setFilter(next) {
  filter = next;
  telemetry.crumb(`filter ${next}`, { testid: `filter-${next}` });
  render();
}

/* ---------- rendering ---------- */

function visibleTodos() {
  if (filter === 'active') return todos.filter((t) => !t.done);
  if (filter === 'completed') return todos.filter((t) => t.done);
  return todos;
}

function render() {
  const list = document.querySelector('[data-testid="todo-list"]');
  const visible = visibleTodos();

  list.replaceChildren(
    ...visible.map((todo) => {
      const item = document.createElement('li');
      item.dataset.testid = 'todo-item';
      item.dataset.id = todo.id;
      if (todo.done) item.classList.add('done');

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.testid = 'toggle';
      toggle.checked = todo.done;
      toggle.setAttribute('aria-label', `Complete ${todo.title}`);
      toggle.addEventListener('change', () => reporting(toggleTodo)(todo.id));

      const title = document.createElement('span');
      title.className = 'title';
      title.dataset.testid = 'todo-title';
      // Assumes every todo has a title. Under ?bug=render one does not, and
      // this throws — an ordinary crash on unexpected data, and the kind whose
      // fix is a one-line guard rather than the removal of a feature.
      title.textContent = (todo.title ?? '').trim();

      const remove = document.createElement('button');
      remove.dataset.testid = 'delete';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${todo.title}`);
      remove.addEventListener('click', () => reporting(deleteTodo)(todo.id));

      item.append(toggle, title, remove);
      return item;
    }),
  );

  document.querySelector('[data-testid="empty-state"]').hidden = todos.length > 0;
  document.querySelector('[data-testid="count"]').textContent =
    `${todos.filter((t) => !t.done).length} left`;

  for (const button of document.querySelectorAll('.filters button')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
}

function showError(message) {
  const error = document.querySelector('[data-testid="error"]');
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  document.querySelector('[data-testid="error"]').hidden = true;
}

/* ---------- wiring ---------- */

/** The session's todos — or, with ?seed=N, N seeded ones in their place. */
async function load() {
  todos = config.seed > 0
    ? await request('POST', '/seed', { count: config.seed }, 'Could not seed todos')
    : await request('GET', '/todos', undefined, 'Could not load todos');
}

function init() {
  // /min/ and /min-nomap/ are the minified builds (ATT-75): the page says which.
  telemetry.start({ variant: config.bug, build: document.documentElement.dataset.build || 'plain' });
  document.querySelector('[data-testid="variant-banner"]').textContent =
    `bug=${config.bug}`;

  // Wired before the list arrives, so an early Add is never a native form
  // submit; it waits for the list, so the list never overwrites it.
  const loaded = load().catch((error) => {
    todos = [];
    showError(error.message);
  }).finally(render);
  applySelectorDefect();
  applySubmitDefect();

  document.querySelector('[data-testid="new-form"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('[data-testid="new-input"]');
    await loaded;
    clearError();
    try {
      await addTodo(input.value);
      input.value = '';
    } catch (error) {
      showError(error.message);
      // What Part 2 consumes: the error, with the request that caused it and
      // the trail of what the user did first.
      telemetry.report(error, {
        'api.path': error.apiPath,
        'api.status': error.apiStatus,
      });
    }
  });

  for (const button of document.querySelectorAll('.filters button')) {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  }

  render();
}

init();
