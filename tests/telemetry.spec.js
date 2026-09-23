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

function appUrl(bug, token = 'test-token') {
  const url = new URL(BASE_URL);
  url.searchParams.set('bug', bug);
  if (token) url.searchParams.set('bt', token);
  return url.toString();
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
