/**
 * The /verify/ page (ATT-91): the AI Authoring suite's fixed URL, whose
 * behaviour comes from a deployed variant.json rather than from the URL.
 * variant.json is intercepted here, so each variant is tested without a deploy.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { BASE_URL } = require('./helpers');

const PAGE = new URL('verify/', BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/').toString();

async function openWithVariant(page, variant) {
  await page.route('**/verify/variant.json*', (route) =>
    variant === null
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bug: variant }) }));
  await page.goto(PAGE);
  await expect(page.getByTestId('variant-banner')).toContainText('bug=');
}

test('the deployed variant is what the page runs, and the URL says so', async ({ page }) => {
  await openWithVariant(page, 'selector');
  await expect(page.getByTestId('variant-banner')).toHaveText('bug=selector');
  expect(new URL(page.url()).searchParams.get('bug')).toBe('selector');
  await expect(page.getByTestId('add-button')).toHaveCount(0);
  await expect(page.getByTestId('submit-button')).toHaveCount(1);
});

test('the app variant breaks the add, as ?bug=app does', async ({ page }) => {
  await openWithVariant(page, 'app');
  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('add-button').click();
  await expect(page.getByTestId('error')).toContainText('Could not save todo (405)');
});

test('no variant file means the healthy app', async ({ page }) => {
  await openWithVariant(page, null);
  await expect(page.getByTestId('variant-banner')).toHaveText('bug=none');
  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('add-button').click();
  await expect(page.getByTestId('todo-title')).toHaveText('Buy milk');
});

test('a variant that is not a plain name is ignored', async ({ page }) => {
  await openWithVariant(page, 'x"><script>');
  await expect(page.getByTestId('variant-banner')).toHaveText('bug=none');
});

test('an explicit ?bug= on the URL wins over the file', async ({ page }) => {
  await page.route('**/verify/variant.json*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"bug":"selector"}' }));
  await page.goto(PAGE + '?bug=none');
  await expect(page.getByTestId('variant-banner')).toHaveText('bug=none');
});

test('the page is the app: its markup matches index.html', () => {
  // Edit index.html and forget /verify/ and the recordings would replay against
  // a different page from the one the Playwright suite tests.
  const root = path.join(__dirname, '..', 'app');
  const main = (file) => fs.readFileSync(path.join(root, file), 'utf8').match(/<main[\s\S]*<\/main>/)[0];
  expect(main('verify/index.html')).toBe(main('index.html'));
});
