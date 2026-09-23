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
 *
 * ⚠️ AND IT IS SCRUBBED FIRST. The submission token arrives as `?bt=…` so it
 * need not sit in a public repository, which means it is in `location.href` —
 * and the SDK records `document.location` on every navigation. Left alone, the
 * token would be written into the crash data, then into the journey compiled
 * from it, then into whatever pull request or ticket quoted that journey. A
 * credential must not travel that way.
 *
 * Scrubbing only the fields this module sets is NOT enough, and the test that
 * says so is the reason this comment exists: the SDK adds `location.href`,
 * `referrer` and `document.baseURI` by itself. So the last word is
 * `beforeSend`, which sees the finished report — every attribute, whoever put
 * it there — and is the only place that can promise the token does not leave
 * the page inside the payload.
 */

import { BacktraceClient } from './vendor/backtrace-browser.min.mjs';
import settings from './telemetry.config.js';

const OWN_TRAFFIC = ['submit.backtrace.io', 'events.backtrace.io', '.sp.backtrace.io'];

/** Query parameters that must never reach the crash data. */
const SECRET_PARAMS = ['bt'];

/** A URL with its secrets removed, or the input unchanged if it is not one. */
function scrubUrl(value) {
  const text = String(value ?? '');
  if (!text.includes('bt=')) return text;
  try {
    const url = new URL(text, location.href);
    for (const name of SECRET_PARAMS) url.searchParams.delete(name);
    return url.toString();
  } catch {
    // Not a URL — a message with one embedded in it, most likely.
    return SECRET_PARAMS.reduce(
      (out, name) => out.replace(new RegExp(`([?&])${name}=[^&\\s"']*`, 'g'), '$1' + name + '=REDACTED'),
      text,
    );
  }
}

/** Every string anywhere in a report, scrubbed. Structure is left alone. */
function scrubDeep(node, depth = 6) {
  if (depth <= 0 || node == null) return node;
  if (typeof node === 'string') return scrubUrl(node);
  if (Array.isArray(node)) return node.map((item) => scrubDeep(item, depth - 1));
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const cleaned = scrubDeep(value, depth - 1);
      // Assign in place: the SDK hands us its own report object and expects
      // the same one back, not a copy that has lost its prototype.
      if (cleaned !== value) node[key] = cleaned;
    }
    return node;
  }
  return node;
}

/** The same, over every string in a breadcrumb: message and attributes alike. */
function scrubCrumb(crumb) {
  if (!crumb) return crumb;
  const scrubbed = { ...crumb };
  if (typeof scrubbed.message === 'string') scrubbed.message = scrubUrl(scrubbed.message);
  if (scrubbed.attributes) {
    scrubbed.attributes = Object.fromEntries(
      Object.entries(scrubbed.attributes).map(([key, value]) => [
        key,
        typeof value === 'string' ? scrubUrl(value) : value,
      ]),
    );
  }
  return scrubbed;
}

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
        'page.url': scrubUrl(location.href),
        'page.path': location.pathname,
      },
      breadcrumbs: {
        maximumBreadcrumbs: 500,
        intercept: (crumb) => (isOwnTraffic(crumb) ? undefined : scrubCrumb(crumb)),
      },
      // Summed-event pings would show up as noise in the trail and in the HAR
      // the triage rules read. This app has nothing to count.
      metrics: { enable: false },
      // The last gate before anything leaves the page. The SDK fills in
      // `location.href`, `referrer` and `document.baseURI` itself, so no
      // amount of care with our own attributes covers it.
      beforeSend: (report) => scrubDeep(report),
    }).build();
    this.crumb('page opened', { pageUrl: scrubUrl(location.href), ...attributes });
  },

  /** A manual breadcrumb: the value and the testid the automatic ones omit. */
  crumb(message, attributes = {}) {
    client?.breadcrumbs?.info(message, attributes);
  },

  /** Report a handled error with the request that caused it. */
  report(error, attributes = {}) {
    if (!client) return;
    client
      .send(error, { ...attributes, 'page.url': scrubUrl(location.href) })
      .catch((problem) => console.warn('[telemetry] report failed', problem));
  },
};
