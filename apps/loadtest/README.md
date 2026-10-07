# @mockdata/loadtest

Dev-only load test for accounts mode. `npm run loadtest` (from the repo root) builds it, starts a real accounts-mode
server in this process (a real SQLite file in a temp folder, a mailer that discards mail, no network), seeds users, and
ramps three scenarios with a step-ramp load tester until the error rate or the 95th-percentile latency crosses a
threshold:

| Scenario | What it stresses |
|---|---|
| `session` | `GET /api/files` with a session cookie: the per-request cost of a signed-in user (session lookup, folder, listing) |
| `login` | `POST /api/auth/login`: password hashing (two at once, then a short queue, then 503) |
| `generate` | `POST /api/generate` on a large schema: CPU on the single event loop, with a probe that shows how long *other* visitors wait meanwhile |

The harness switches off the per-user rate limiters (`runUser`, `validateUser`, and the per-address ones) so it measures
capacity, not the limiters; everything else is the real server. Options: `--accounts-db <postgres://...>` (an empty, throwaway database: measure the account database on Postgres instead of SQLite), `--scenarios session,login,generate`,
`--users 60`, `--step-secs 4`, `--rows 20000` (rows in the generate schema).

`src/kit/` is a vendored copy of `load-test-kit` from the itravelmap repo (`packages/load-test-kit`, commit `0371771`):
a generic step-ramp runner that knows nothing about what a request is. Everything here runs on your machine, so treat
the numbers as that machine's, and as a comparison between scenarios, not as production capacity.
