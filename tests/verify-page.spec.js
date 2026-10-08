/**
 * The /verify/ page (ATT-91): the AI Authoring suite's fixed URL, whose
 * behaviour comes from a deployed variant.json rather than from the URL.
 * variant.json is intercepted here, so each variant is tested without a deploy.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { API_URL, BASE_URL } = require('./helpers');

const PAGE = new URL('verify/', BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/').toString();

async function openWithVariant(page, variant, api = API_URL) {
  const file = { bug: variant, ...(api ? { api } : {}) };
  await page.route('**/verify/variant.json*', (route) =>
    variant === null
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(file) }));
  // No file to name a backend in: a local run names its own on the URL.
  await page.goto(variant === null && api ? `${PAGE}?api=${encodeURIComponent(api)}` : PAGE);
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', /^[a-z]+$/);
}

test('the deployed variant is what the page runs, and the URL says so', async ({ page }) => {
  await openWithVariant(page, 'selector');
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', 'selector');
  expect(new URL(page.url()).searchParams.get('bug')).toBe('selector');
  await expect(page.getByTestId('add-button')).toHaveCount(0);
  await expect(page.getByTestId('submit-button')).toHaveCount(1);
});

test('the app variant breaks the add, as ?bug=app does', async ({ page }) => {
  await openWithVariant(page, 'app');
  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('add-button').click();
  await expect(page.getByTestId('error')).toContainText('Could not save todo (500)');
});

test('no variant file means the healthy app', async ({ page }) => {
  await openWithVariant(page, null);
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', 'none');
  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('add-button').click();
  await expect(page.getByTestId('todo-title')).toHaveText('Buy milk');
});

test('a preview names the backend it calls, and the page calls it', async ({ page }) => {
  // A fix to the backend is proved against that fix's own backend (8 Oct).
  const calls = [];
  await page.route('https://fixed-backend.example/preview/abc123/api/**', (route) => {
    calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]',
                           headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await openWithVariant(page, 'app', 'https://fixed-backend.example/preview/abc123/api');
  await expect.poll(() => calls).toContain('GET /preview/abc123/api/todos');
});

test('a backend that is not https is never called', async ({ page }) => {
  const called = [];
  page.on('request', (r) => called.push(r.url()));
  await openWithVariant(page, 'none', 'http://evil.example/api');
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', 'none');
  expect(called.some((u) => u.startsWith('http://evil.example'))).toBe(false);
});

test('the planted bug is never on screen: a failure screenshot must not give it away', async ({ page }) => {
  await openWithVariant(page, 'app');
  await expect(page.getByTestId('variant-banner')).toBeHidden();
  await expect(page.locator('body')).not.toContainText('bug=');
});

test('a variant that is not a plain name is ignored', async ({ page }) => {
  await openWithVariant(page, 'x"><script>');
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', 'none');
});

test('an explicit ?bug= on the URL wins over the file', async ({ page }) => {
  await page.route('**/verify/variant.json*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"bug":"selector"}' }));
  await page.goto(PAGE + '?bug=none');
  await expect(page.getByTestId('variant-banner')).toHaveAttribute('data-bug', 'none');
});

test('the page is the app: its markup matches index.html', () => {
  // Edit index.html and forget /verify/ and the recordings would replay against
  // a different page from the one the Playwright suite tests.
  const root = path.join(__dirname, '..', 'app');
  const main = (file) => fs.readFileSync(path.join(root, file), 'utf8').match(/<main[\s\S]*<\/main>/)[0];
  expect(main('verify/index.html')).toBe(main('index.html'));
});
