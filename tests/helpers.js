/**
 * Shared test helpers.
 *
 * BASE_URL points at the deployed app; VARIANT selects the deliberate defect.
 * Both come from the environment so one suite covers every variant.
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const VARIANT = process.env.VARIANT || 'none';

/** Build the app URL for this run, plus any per-test parameters. */
function appUrl(extra = {}) {
  const url = new URL(BASE_URL);
  url.searchParams.set('bug', VARIANT);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Open the app with a clean store, optionally pre-seeded with `seed` todos. */
async function openApp(page, extra = {}) {
  await page.goto(appUrl(extra));
  if (!extra.seed) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  return page;
}

module.exports = { BASE_URL, VARIANT, appUrl, openApp };
