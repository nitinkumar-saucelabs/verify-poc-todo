# Vendored: `@backtrace/browser` 0.6.2 — `lib/bundle.min.mjs`

Copied verbatim from the npm package (self-contained ESM, no bare imports),
not loaded from a CDN, so the page under test has no third-party dependency
at test time: a grid run must not fail — or pass — because a CDN did.

Upgrade: `npm pack @backtrace/browser@<version>`, copy `lib/bundle.min.mjs`
here, update this line. What the SDK records is measured in the agent's notes:
click/navigation/HTTP breadcrumbs with `{id, class, tagName}` only — never
typed values or `data-testid` — which is why `telemetry.js` adds its own.
