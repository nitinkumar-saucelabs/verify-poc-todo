# verify-poc-todo

The target for the Sauce Verify POC: a small todo app whose defects are
switchable, plus the Playwright suite that runs against it on Sauce.

The app is not the point. It is a controllable target with **known correct
answers**, so the triage agent's accuracy can be measured instead of argued
about.

## The four variants

| URL | What the app does | Correct verdict | Which specs fail |
|---|---|---|---|
| `?bug=none` | Everything works | green | none |
| `?bug=app` | Add posts to an endpoint that rejects; the item never appears | **APP BUG** | `add` |
| `?bug=flaky` | Complete silently fails ~30% of the time | **FLAKE** | `complete`, sometimes `filter` |
| `?bug=selector` | The add button's `data-testid` is renamed | **TEST BUG** | `add` |

Support parameters: `?seed=N` pre-populates todos without using the Add path,
so non-add specs still run under `?bug=app`; `?flakeRate=R` tunes the flake
rate for calibrating the rerun cap; `?api=URL` points the app variant at a
real backend if you want a 500 instead of a 405.

`add` fails under both `?bug=app` and `?bug=selector` on purpose: one test,
two root causes, which is exactly the distinction triage has to make.

## Running it

```bash
npm install
npx playwright install chromium

npm run serve                      # http://localhost:8080
BASE_URL=http://localhost:8080 npm run test:none      # 6 pass
BASE_URL=http://localhost:8080 npm run test:app       # only add fails
BASE_URL=http://localhost:8080 npm run test:selector  # only add fails
BASE_URL=http://localhost:8080 npm run test:flaky     # complete is mixed

saucectl run                       # the whole matrix on Sauce
saucectl run --select-suite add-chromium   # one suite, as the agent reruns it
```

## `actionTimeout` is load-bearing

`playwright.config.js` sets `actionTimeout: 7000`. This is not a speed
setting. Without it, a click on a missing element hangs until the whole test
times out and the error message is a bare `Test timeout of 30000ms exceeded`
that names no locator. The JSON reporter carries no per-step data to fall back
on, so the selector is unrecoverable and TEST BUG cannot be told from APP BUG.
With it set, the action fails and the message names the locator it waited for.

This was found by running the thing, not by reading the docs. Do not remove it.

## Quarantine

`quarantine.json` lists tests the agent has ruled FLAKE.
`playwright.config.js` turns it into a `grepInvert`, so a quarantine pull
request takes effect on the next run without editing any spec. An empty list
skips nothing.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `pages.yml` | push to `main` | deploys `app/` to GitHub Pages |
| `nightly.yml` | cron 21:47 | runs the matrix across all four variants |
| `run-variant.yml` | manual | one variant, optionally one suite |

The suites deliberately do not fail the job when red: variants other than
`none` are supposed to fail, and the triage agent is the consumer of those
failures.

Every job is tagged with `commit:<sha>` and `variant:<name>`. That tagging is
the POC's miniature of HLD decision D9 — a rerun can only be replayed if the
original job recorded what it needs.

## Setup

Repository secrets: `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`.
Repository variable: `BASE_URL` (the Pages URL once `pages.yml` has run once).
