/**
 * Where this app reports errors (HLD Part 2: a production crash becomes a test).
 *
 * `submissionToken` is DELIBERATELY EMPTY and should stay that way.
 *
 * A Backtrace submission token is the kind that normally ships in a browser
 * bundle — it can only POST reports. Two things make this one different: the
 * repository is PUBLIC, and the project lives in Sauce's *internal* Backtrace
 * tenant, so a committed token would let anyone on the internet write into an
 * internal system, permanently, via git history. The cost of keeping it out is
 * one CI secret; the cost of putting it in cannot be undone.
 *
 * So the token arrives on the URL instead — `?bt=<token>` — supplied by the
 * workflows from `secrets.BACKTRACE_SUBMISSION_TOKEN`, or by hand for a local
 * run. With no token telemetry is simply OFF and the page says so once, which
 * is also the right default for anyone who stumbles across the Pages site.
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
