const fs = require('fs');
const base = require('@playwright/test');

/**
 * The DOM as it stood when the test failed, attached to the run.
 *
 * Triage needs this to tell a renamed selector from a broken app: an action
 * that timed out waiting for `getByTestId('add-button')` is only a TEST BUG
 * if that id really is gone from the page. Without the snapshot the verdict
 * rules correctly refuse to guess and return NEEDS HUMAN.
 *
 * Why the suite attaches it rather than the agent fetching it:
 *
 *  - Playwright writes no page-source artifact of its own. The trace holds DOM
 *    snapshots, but it is a zip the agent would have to unpack.
 *  - Re-fetching the URL afterwards is WRONG, and measurably so. This app
 *    renders its list client-side, so a freshly served page never contains
 *    `todo-item` even when the app is perfectly healthy — that mistake would
 *    label every APP BUG a TEST BUG. The snapshot has to be the live DOM at
 *    the moment of failure, which only the browser session has.
 *
 * Attached only on failure, so green runs carry no extra payload.
 */
const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
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
