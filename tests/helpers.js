/**
 * Shared test helpers.
 *
 * BASE_URL points at the deployed app; VARIANT selects the deliberate defect.
 * Both come from the environment so one suite covers every variant.
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const VARIANT = process.env.VARIANT || 'none';
/** The backend, when not the live one: a local `npm run server` for a local run. */
const API_URL = process.env.API_URL || '';

/** Build the app URL for this run, plus any per-test parameters. */
function appUrl(extra = {}) {
  const url = new URL(BASE_URL);
  url.searchParams.set('bug', VARIANT);
  if (API_URL) url.searchParams.set('api', API_URL);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Open the app, optionally pre-seeded with `seed` todos. A test's browser is
 * new, so its session — and its list on the backend — starts empty.
 */
async function openApp(page, extra = {}) {
  await page.goto(appUrl(extra));
  return page;
}

module.exports = { API_URL, BASE_URL, VARIANT, appUrl, openApp };
