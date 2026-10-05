/**
 * Does a rejected add reach Backtrace with everything Part 2 needs?
 *
 * Runs against a FAKE submission endpoint (the request is intercepted), so it
 * needs no token and sends nothing anywhere: `npm run test:telemetry`. It is
 * deliberately not in `.sauce/config.yml` — the Sauce suites are the triage
 * target; this proves the report's shape, which is a different question.
 */
const { test, expect } = require('@playwright/test');
const { BASE_URL } = require('./helpers');

const SUBMIT = 'https://submit.backtrace.io/**';
const UNIVERSE = 'saucelabs';

function appUrl(bug, token = 'test-token', universe = '') {
  const url = new URL(BASE_URL);
  url.searchParams.set('bug', bug);
  if (token) url.searchParams.set('bt', token);
  if (universe) url.searchParams.set('universe', universe);
  return url.toString();
}

/** Reject an add and return the URL the first report was submitted to. */
async function submittedTo(page, reports, url) {
  await page.goto(url);
  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('add-button').click();
  await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
  return reports[0].url;
}

/** Capture every report the page tries to submit, answering as Backtrace would. */
async function captureReports(page) {
  const reports = [];
  await page.route(SUBMIT, async (route) => {
    const request = route.request();
    reports.push({
      url: request.url(),
      body: request.postDataBuffer()?.toString('utf8') ?? '',
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ response: 'ok', _rxid: 'test' }),
    });
  });
  return reports;
}

test.describe('telemetry', () => {
  // ATT-64: the same deployed page can report into the ER team's `yolo`
  // universe, for their RCA, without changing the `saucelabs` demo.
  test('?universe= chooses the universe the report goes to', async ({ page }) => {
    const reports = await captureReports(page);
    const url = await submittedTo(page, reports, appUrl('app', 'test-token', 'yolo'));
    expect(url).toContain('submit.backtrace.io/yolo/test-token/json');
  });

  test('a universe that is not a plain name is ignored, never put in the URL', async ({ page }) => {
    const reports = await captureReports(page);
    const url = await submittedTo(page, reports, appUrl('app', 'test-token', 'evil.example/x'));
    expect(url).toContain(`submit.backtrace.io/${UNIVERSE}/test-token/json`);
  });

  test('a rejected add is reported with the request and the trail', async ({ page }) => {
    const reports = await captureReports(page);
    await page.goto(appUrl('app'));

    await page.getByTestId('new-input').fill('Buy milk');
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('error')).toBeVisible();

    await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const { url, body } = reports[0];
    expect(url).toContain(`submit.backtrace.io/${UNIVERSE}/test-token/json`);

    // The error, and the request that caused it — the same facts the triage
    // rules take from the HAR.
    expect(body).toContain('Could not save todo (405)');
    expect(body).toContain('api.status');
    expect(body).toContain('/api/todos');
    expect(body).toContain('"variant":"app"');

    // The trail is attached, and it carries what the automatic crumbs never
    // do: the typed value, the testid, and the page URL under the key the
    // compiler reads.
    expect(body).toContain('bt-breadcrumbs-0');
    expect(body).toContain('Buy milk');
    expect(body).toContain('new-form');
    expect(body).toContain('pageUrl');
  });

  test('a healthy app reports nothing', async ({ page }) => {
    const reports = await captureReports(page);
    await page.goto(appUrl('none'));

    await page.getByTestId('new-input').fill('Buy milk');
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('todo-item')).toHaveCount(1);
    await page.waitForTimeout(1500);

    expect(reports).toHaveLength(0);
  });

  test('without a token telemetry is off and says so once', async ({ page }) => {
    const reports = await captureReports(page);
    const messages = [];
    page.on('console', (message) => messages.push(message.text()));
    await page.goto(appUrl('app', null));

    await page.getByTestId('new-input').fill('Buy milk');
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('error')).toBeVisible();
    await page.waitForTimeout(1000);

    expect(messages.some((m) => m.includes('[telemetry] off'))).toBe(true);
    expect(reports).toHaveLength(0);
  });
});

test.describe('the submission token never reaches the crash data', () => {
  test('it is stripped from the page url, the trail and the report', async ({ page }) => {
    const reports = await captureReports(page);
    // The token arrives on the URL so it need not live in this public repo —
    // which puts it in location.href, and the SDK records that by itself.
    await page.goto(appUrl('app', 'super-secret-token'));

    await page.getByTestId('new-input').fill('Buy milk');
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('error')).toBeVisible();
    await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);

    const { url, body } = reports[0];
    // It is still the credential the report is SENT with — that is the point.
    expect(url).toContain('super-secret-token');
    // But it appears nowhere in what gets STORED, including the attributes the
    // SDK adds itself, which scrubbing our own fields cannot reach.
    expect(body).not.toContain('super-secret-token');
    expect(body).toContain('"location.href":"http://localhost:8080/?bug=app"');
    expect(body).toContain('"referrer":"http://localhost:8080/?bug=app"');
    expect(body).toContain('pageUrl');
    expect(body).toContain('Could not save todo (405)');
  });
});

// ATT-75: the app as a customer ships it. `scripts/build-min.sh` makes both
// bundles; the map is uploaded to Backtrace, which deobfuscates at ingest ONLY
// when the report names the build — so that naming is what is tested here.
test.describe('minified builds', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const debugId = fs.readFileSync(path.join(root, 'app/min/app.min.js'), 'utf8')
    .match(/debugId=([0-9a-f-]+)/)[1];

  async function reportFrom(page, build) {
    const reports = await captureReports(page);
    const url = new URL(appUrl('app'));
    url.pathname = url.pathname.replace(/\/?$/, `/${build}/`);
    await submittedTo(page, reports, url.toString());
    return reports[0].body;
  }

  test('/min/ names its debug id, so the uploaded map can be found', async ({ page }) => {
    const body = await reportFrom(page, 'min');
    expect(body).toContain('"symbolication":"sourcemap"');
    expect(body).toContain(`"debug_identifier":"${debugId}"`);
    expect(body).toContain('min/app.min.js');
    expect(body).toContain('"build":"min"');
    expect(body).toContain('Could not save todo (405)');
  });

  test('/min-nomap/ is the same bundle with nothing to deobfuscate it', async ({ page }) => {
    const body = await reportFrom(page, 'min-nomap');
    expect(body).not.toContain('"symbolication"');
    expect(body).not.toContain('debug_identifier');
    expect(body).toContain('min-nomap/app.min.js');
    expect(body).toContain('"build":"min-nomap"');
  });

  test('the committed bundle was built from the app as it is now', () => {
    // Edit app/ without re-running the build and the uploaded map describes
    // code nobody ships: the crash would deobfuscate to the wrong lines.
    const map = JSON.parse(fs.readFileSync(path.join(root, 'symbols/app.min.js.map'), 'utf8'));
    expect(map.debugId).toBe(debugId);
    map.sources.forEach((source, i) => {
      const file = path.join(root, 'app/min', source);
      expect(map.sourcesContent[i], `${source} changed since the build: run scripts/build-min.sh`)
        .toBe(fs.readFileSync(file, 'utf8'));
    });
  });
});

// crash-lifecycle: a page served by the lifecycle's deploy script has a
// `build-info.json` next to it ({environment, commit, deployed_at}). The page
// reads it BEFORE the app starts and reports `environment` and `commit` on every
// crash, which is how the agent tells a prod crash from a preprod one and which
// build it came from. Nitin's own Pages site has no such file, and for it nothing
// changes: a missing file means no attributes, not an error.
test.describe('environment and commit attributes', () => {
  const BUILD_INFO = '**/build-info.json';
  const info = { environment: 'preprod', commit: '3f2c9d0e8a1b4c5d6e7f8091a2b3c4d5e6f70812', deployed_at: '2026-10-05T10:00:00Z' };

  test('are reported when build-info.json is served', async ({ page }) => {
    const reports = await captureReports(page);
    await page.route(BUILD_INFO, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));

    await submittedTo(page, reports, appUrl('app'));

    expect(reports[0].body).toContain('"environment":"preprod"');
    expect(reports[0].body).toContain(`"commit":"${info.commit}"`);
  });

  test('are on the page before the app runs, for anything else that wants them', async ({ page }) => {
    await page.route(BUILD_INFO, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));
    await page.goto(appUrl('none'));

    await expect(page.locator('html')).toHaveAttribute('data-environment', 'preprod');
    await expect(page.locator('html')).toHaveAttribute('data-commit', info.commit);
  });

  // GUARD (green before the change, must stay green): Nitin's site must be untouched.
  test('guard: are absent when there is no build-info.json (Nitin\'s site)', async ({ page }) => {
    const reports = await captureReports(page);
    await page.route(BUILD_INFO, (route) => route.fulfill({ status: 404, body: 'not found' }));

    await submittedTo(page, reports, appUrl('app'));

    expect(reports[0].body).toContain('Could not save todo (405)');
    expect(reports[0].body).not.toContain('"environment"');
    expect(reports[0].body).not.toContain('"commit"');
  });

  // GUARD (green before the change, must stay green): a bad file is ignored, never an error.
  test('guard: a build-info.json that is not JSON is ignored, never an error', async ({ page }) => {
    const reports = await captureReports(page);
    await page.route(BUILD_INFO, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>not json</html>' }));

    await submittedTo(page, reports, appUrl('app'));

    expect(reports[0].body).toContain('Could not save todo (405)');
    expect(reports[0].body).not.toContain('"environment"');
  });

  test('build-info.json is asked for without a cache-buster', async ({ page }) => {
    // The page must see what a fresh visitor sees: Pages' edge caches app.js for
    // ten minutes, and build-info has to age with it, so a stale page reports
    // the commit it really is.
    const asked = [];
    page.on('request', (request) => { if (request.url().includes('build-info.json')) asked.push(request.url()); });
    await page.route(BUILD_INFO, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));

    await page.goto(appUrl('none'));

    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(new URL(url).search, url).toBe('');
  });
});
