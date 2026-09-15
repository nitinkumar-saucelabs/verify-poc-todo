const fs = require('fs');
const base = require('@playwright/test');

/**
 * Two artefacts triage cannot work without, attached on failure only.
 *
 * 1. THE DOM AT FAILURE (`page-source.html`)
 *
 * Triage needs it to tell a renamed selector from a broken app: an action that
 * timed out waiting for `getByTestId('add-button')` is only a TEST BUG if that
 * id really is gone from the page. Without it the rules correctly refuse to
 * guess and return NEEDS HUMAN.
 *
 * Playwright writes no page-source artifact of its own, and re-fetching the URL
 * afterwards is WRONG and measurably so — this app renders its list
 * client-side, so a freshly served page never contains `todo-item` even when
 * the app is perfectly healthy. That mistake would label every APP BUG a TEST
 * BUG. The snapshot has to be the live DOM at the moment of failure, which
 * only the browser session has.
 *
 * 2. THE NETWORK LOG (`network.har`)
 *
 * Triage needs it for the opposite verdict: an assertion that saw the wrong
 * state is an APP BUG only if the network log shows the backend refusing the
 * request. Measured 15 Sept 2026 on a real Sauce job: `/v1/eds/{job}/network.har`
 * returns 404 and no HAR appears in the job's assets at all. Extended
 * Debugging is a WebDriver feature — Playwright jobs on Sauce capture no HAR.
 * So the suite records its own, exactly as it does the DOM.
 *
 * `content: 'omit'` keeps response bodies out: the rules only read each entry's
 * URL and status, and the bodies are both large and potentially sensitive.
 *
 * A HAR is only written when its context closes, so this has to live on the
 * `context` fixture rather than on `page` — by the time an afterEach hook runs
 * the file does not exist yet.
 */
const test = base.test.extend({
  context: async ({ browser }, use, testInfo) => {
    const harPath = testInfo.outputPath('network.har');
    const context = await browser.newContext({
      recordHar: { path: harPath, content: 'omit' },
    });

    await use(context);

    await context.close(); // flushes the HAR to disk

    if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(harPath)) {
      await testInfo.attach('network.har', {
        path: harPath,
        contentType: 'application/json',
      });
    }
  },

  page: async ({ context }, use, testInfo) => {
    const page = await context.newPage();

    await use(page);

    if (testInfo.status === testInfo.expectedStatus) return;

    try {
      // Written to a file and attached by PATH, not by `body`. A body
      // attachment is kept inline in the JSON report and never touches disk,
      // so saucectl has nothing to upload and the agent's asset fetch 404s.
      // Measured on 15 Sept: with `body` the report shows `path: null`.
      const file = testInfo.outputPath('page-source.html');
      fs.writeFileSync(file, await page.content(), 'utf8');
      await testInfo.attach('page-source.html', {
        path: file,
        contentType: 'text/html',
      });
    } catch (error) {
      // A page that crashed or closed has no DOM left to give. A missing
      // snapshot is a case triage already handles honestly, so swallowing
      // this is better than failing the run a second time on the way out.
    }
  },
});

module.exports = { test, expect: base.expect };
