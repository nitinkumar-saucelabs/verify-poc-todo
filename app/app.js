/**
 * Todo app — the Sauce Verify POC target.
 *
 * A query parameter selects a deliberate defect so the correct triage verdict
 * is known in advance:
 *
 *   ?bug=none      everything works                        -> green
 *   ?bug=app       Add posts to an endpoint that rejects   -> APP BUG
 *   ?bug=flaky     Complete silently fails some of the time-> FLAKE
 *   ?bug=selector  Add button's data-testid is renamed     -> TEST BUG
 *   ?bug=submit    Add button removed; Enter submits       -> TEST BUG (needs a model)
 *   ?bug=render    a saved todo comes back with no title,  -> APP BUG, and the one
 *                  and the renderer assumes one               whose fix is a guard
 *
 * Support parameters:
 *   ?seed=N        pre-populate N todos without using the Add path, so specs
 *                  that are not about adding still run under ?bug=app.
 *   ?flakeRate=R   failure probability for ?bug=flaky (default 0.3).
 *   ?api=URL       endpoint the ?bug=app variant posts to. Default is a
 *                  relative path, which static hosting answers 405.
 */

import { telemetry } from './telemetry.js';

const STORAGE_KEY = 'verify-poc-todos';

const params = new URLSearchParams(location.search);
const config = {
  bug: params.get('bug') || 'none',
  seed: Number(params.get('seed') || 0),
  flakeRate: Number(params.get('flakeRate') ?? 0.3),
  api: params.get('api') || './api/todos',
};

let todos = [];
let filter = 'all';

/* ---------- persistence ---------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch {
    /* private mode: in-memory only */
  }
}

/* ---------- defects ---------- */

/** ?bug=app: the Add path calls a backend that rejects, so nothing is added. */
async function addRejectedByBackend(title) {
  const response = await fetch(config.api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    // Carried on the error so the report can name the request, the way the
    // triage rules name it from the HAR.
    const error = new Error(`Could not save todo (${response.status})`);
    error.apiPath = new URL(config.api, location.href).pathname;
    error.apiStatus = response.status;
    throw error;
  }
}

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
  if (config.bug === 'app') {
    await addRejectedByBackend(title); // throws; the item is never added
  }
  if (config.bug === 'render') {
    // The row the backend hands back is missing its title. The defect is the
    // DATA, so the honest fix is a guard where it is read — which leaves this
    // deliberate defect exactly where it is.
    todos.push({ id: crypto.randomUUID(), done: false });
    save();
    render(); // throws in the renderer, not here
    return;
  }
  todos.push({ id: crypto.randomUUID(), title: title.trim(), done: false });
  telemetry.crumb('todo added', { count: todos.length });
  save();
  render();
}

function toggleTodo(id) {
  if (completeSilentlyFails()) return; // no state change, no error shown
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  todo.done = !todo.done;
  telemetry.crumb(todo.done ? 'todo completed' : 'todo reopened', { testid: 'toggle', title: todo.title });
  save();
  render();
}

function deleteTodo(id) {
  const todo = todos.find((t) => t.id === id);
  todos = todos.filter((t) => t.id !== id);
  telemetry.crumb('todo deleted', { testid: 'delete', title: todo?.title });
  save();
  render();
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
      toggle.addEventListener('change', () => toggleTodo(todo.id));

      const title = document.createElement('span');
      title.className = 'title';
      title.dataset.testid = 'todo-title';
      // Assumes every todo has a title. Under ?bug=render one does not, and
      // this throws — an ordinary crash on unexpected data, and the kind whose
      // fix is a one-line guard rather than the removal of a feature.
      title.textContent = todo.title.trim();

      const remove = document.createElement('button');
      remove.dataset.testid = 'delete';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${todo.title}`);
      remove.addEventListener('click', () => deleteTodo(todo.id));

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

function seedTodos(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i + 1}`,
    title: `Seeded todo ${i + 1}`,
    done: false,
  }));
}

function init() {
  telemetry.start({ variant: config.bug });
  document.querySelector('[data-testid="variant-banner"]').textContent =
    `bug=${config.bug}`;

  if (config.seed > 0) {
    todos = seedTodos(config.seed);
    save();
  } else {
    todos = load();
  }
  applySelectorDefect();
  applySubmitDefect();

  document.querySelector('[data-testid="new-form"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('[data-testid="new-input"]');
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
