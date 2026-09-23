/**
 * Error reporting for the target app — what Part 2 of the design consumes.
 *
 * A production crash arrives at the crash compiler as an error plus a
 * BREADCRUMB TRAIL: what the user did before it broke. This module makes that
 * trail worth having. Two facts measured against the SDK (23 Sept) shape it:
 *
 *  1. The SDK's automatic breadcrumbs carry `{id, class, tagName}` and HTTP
 *     `{url, method, statusCode}` — never typed values, never `data-testid`.
 *     For this app, which identifies everything by data-testid, an automatic
 *     click reads `Clicked  BUTTON`. So the actions add MANUAL crumbs naming
 *     the testid and the value: those are what a generated test needs.
 *  2. The buffer is a ring of 100 and it floods during an error storm — the
 *     SDK's own submissions and the page's error pixel evicted every user
 *     action on a real site. So the ring is 500 deep, the SDK's own traffic is
 *     filtered out of it, and metrics pings are off entirely.
 *
 * The page URL is in neither the trail nor the object's attributes by default,
 * so the first crumb records it under `pageUrl` — the key the compiler reads.
 */

import { BacktraceClient } from './vendor/backtrace-browser.min.mjs';
import settings from './telemetry.config.js';

const OWN_TRAFFIC = ['submit.backtrace.io', 'events.backtrace.io', '.sp.backtrace.io'];

let client = null;

function submissionToken() {
  // `?bt=` wins, so a token can be tried without committing it and the
  // telemetry spec can run against a fake one.
  return new URLSearchParams(location.search).get('bt') || settings.submissionToken;
}

function isOwnTraffic(crumb) {
  const url = String(crumb?.attributes?.url ?? '');
  return OWN_TRAFFIC.some((host) => url.includes(host));
}

export const telemetry = {
  get enabled() {
    return client !== null;
  },

  /** Call once, as early as possible: everything before it is not recorded. */
  start(attributes = {}) {
    const token = submissionToken();
    if (!token) {
      console.info('[telemetry] off — no Backtrace submission token (telemetry.config.js or ?bt=)');
      return;
    }
    client = BacktraceClient.builder({
      url: `https://submit.backtrace.io/${settings.universe}/${token}/json`,
      name: settings.project,
      version: settings.version,
      userAttributes: {
        ...attributes,
        'page.url': location.href,
        'page.path': location.pathname,
      },
      breadcrumbs: {
        maximumBreadcrumbs: 500,
        intercept: (crumb) => (isOwnTraffic(crumb) ? undefined : crumb),
      },
      // Summed-event pings would show up as noise in the trail and in the HAR
      // the triage rules read. This app has nothing to count.
      metrics: { enable: false },
    }).build();
    this.crumb('page opened', { pageUrl: location.href, ...attributes });
  },

  /** A manual breadcrumb: the value and the testid the automatic ones omit. */
  crumb(message, attributes = {}) {
    client?.breadcrumbs?.info(message, attributes);
  },

  /** Report a handled error with the request that caused it. */
  report(error, attributes = {}) {
    if (!client) return;
    client
      .send(error, { ...attributes, 'page.url': location.href })
      .catch((problem) => console.warn('[telemetry] report failed', problem));
  },
};
