/**
 * Where this app reports errors (HLD Part 2: a production crash becomes a test).
 *
 * The submission token is the kind that ships in every browser bundle that
 * uses Backtrace — it can only POST reports. Leaving it empty keeps telemetry
 * OFF, which the page says once in the console. `?bt=<token>` on the URL
 * overrides it for a single page load, so a token can be tried before it is
 * committed, and the telemetry spec can run against a fake one.
 */
export default {
  // The Sauce-internal Backtrace tenant, not our org's `sl-{orgId}` universe.
  // Proven 23 Sept: a Sauce SSO token carries `universe: saucelabs`, which is
  // the cohort sauce-mcp's Error Reporting allowlist enables — so the agent can
  // read these errors, and their breadcrumbs, with no credential to paste and
  // nothing to have switched on for us. Reporting into the `sl-` universe would
  // put the crashes somewhere the agent cannot reach.
  universe: 'saucelabs',
  project: 'verify-poc-todo',
  submissionToken: '',
  version: '1.1.0',
};
