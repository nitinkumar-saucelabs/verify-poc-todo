const { defineConfig, devices } = require('@playwright/test');
const { readQuarantineGrep } = require('./quarantine');

/**
 * One project per browser so saucectl's `params.project` can select it.
 *
 * Quarantine: tests the triage agent has ruled FLAKE are listed in
 * quarantine.json and excluded here, so a quarantine merge request takes
 * effect on the next run without touching the specs themselves.
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['json', { outputFile: 'report/results.json' }]],
  grepInvert: readQuarantineGrep(),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Required for triage, not just for speed. Without an actionTimeout a
    // click on a missing element hangs until the whole test times out, and
    // the error message is a bare "Test timeout of 30000ms exceeded" that
    // names no locator. The JSON reporter carries no per-step data to fall
    // back on, so the selector would be unrecoverable and TEST BUG could not
    // be told from APP BUG. With this set, the action itself fails and the
    // message names the locator it waited for.
    actionTimeout: 7_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
