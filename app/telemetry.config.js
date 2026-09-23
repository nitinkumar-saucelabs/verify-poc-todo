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
  universe: 'sl-7fb25570b4064716b9b6daae1a846790',
  project: 'verify-poc-todo',
  submissionToken: '',
  version: '1.1.0',
};
