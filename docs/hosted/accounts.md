<!-- Staged for the private mockdata-cloud repo (plan step 4); removed from the open README. -->

## Accounts and going public

For a site other people sign in to, set `MOCKDATA_PUBLIC_URL` and start the UI as usual. Accounts are an opt-in mode; without that variable nothing here applies.

| Mode | Turned on by | Who gets in |
|---|---|---|
| Local (default) | nothing | anyone on this machine; nothing is reachable from outside |
| Private network | `--allow ranges` | the listed private ranges, with a shared token |
| **Accounts** | `MOCKDATA_PUBLIC_URL` | everyone signs in, **including localhost**; no token, no allow list |

Localhost is not trusted in accounts mode because a reverse proxy that terminates https connects from localhost on behalf of the whole internet. To keep the no-login local workflow, run without `MOCKDATA_PUBLIC_URL`; to try accounts on your own machine, use `MOCKDATA_PUBLIC_URL=http://localhost:4747`.

**What you configure** (environment or `.env`; see `.env.example`):

| Variable | Meaning |
|---|---|
| `MOCKDATA_PUBLIC_URL` | `https://your-domain` (plain http is accepted only for localhost) |
| `MOCKDATA_DATA_DIR` or `--data-dir` | accounts database and every user's private folder (default `./mockdata-data`); back it up (see Backups below) |
| `MOCKDATA_ACCOUNTS_DB` | optional `postgres://` URL: keep the account database in Postgres instead of SQLite under the data folder. One server runs well on SQLite; Postgres is what lets [several servers](#running-several-servers) share accounts. The schema is created on first start. User files still live under `MOCKDATA_DATA_DIR/users` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | email for verification and password reset. **Resend:** `smtp.resend.com`, port `465`, secure `true`, user `resend`, password = your Resend API key; verify your sending domain in Resend first |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional Google sign-in; in Google Cloud add the redirect URI `<MOCKDATA_PUBLIC_URL>/api/auth/google/callback` |
| `MOCKDATA_TRUST_PROXY` | `1` or `0`. Rate limits need each visitor's address, which a reverse proxy on this machine supplies in `X-Forwarded-For` (the **last** entry is used, and only when the connection comes from localhost). Default: on for an `https` address, off for plain-http localhost. Set `0` if a CDN sits in front of your proxy, because the last entry would then be the CDN, not the visitor |
| `MOCKDATA_LLM_DAILY_ROWS`, `MOCKDATA_LLM_GLOBAL_DAILY_ROWS` | model-written rows per user per day (2000) and across all users per day (20000): the second is your overall spending ceiling |
| `MOCKDATA_MAX_ROWS`, `MOCKDATA_MAX_CELLS` | rows per run (200000) and rows x columns per run (500000, about one second of server time) |
| `MOCKDATA_USER_QUOTA_MB`, `MOCKDATA_USER_MAX_FILES`, `MOCKDATA_MAX_RUNS` | storage per user (50 MB), files per user (500), and runs at once across all users (4) |

It refuses to start unless people can sign up (email and/or Google) and the address is valid. The UI listens on 127.0.0.1; put a reverse proxy in front that provides https. With Caddy (certificates are automatic):

```
mockdata.example.com {
  reverse_proxy 127.0.0.1:4747
}
```

```
MOCKDATA_PUBLIC_URL=https://mockdata.example.com MOCKDATA_TRUST_PROXY=1 npm run ui -- /path/holding/.env
```

**Backups.** With `MOCKDATA_ACCOUNTS_DB` set, back the account database up with `pg_dump` or your provider's backups. Otherwise it is SQLite in WAL mode, so copying `accounts.db` on its own while the server runs can give you a broken copy (recent writes sit in `accounts.db-wal`). Use the built-in command, which is safe while the server is running and never changes the source:

```
npm run ui -- /path/holding/.env --backup /backups/accounts-$(date +%F).db    # or: node packages/server/dist/bin.js ... --backup <file>
```

It writes a consistent, owner-only copy and refuses to overwrite a file. Back up `<data-dir>/users/` (every user's files) with any file-level tool, and test a restore: stop the server, put the copy at `<data-dir>/accounts.db` (with no `-wal`/`-shm` files beside it) and start it again. For continuous copies, [Litestream](https://litestream.io) can stream `accounts.db` to object storage.

**How it behaves.** Sign-up needs a verified email (a link mailed to the address; Google accounts need Google to report the address as verified). Sessions are a random id in an `HttpOnly`, `SameSite=Lax` cookie (named `__Host-mockdata_session` and `Secure` over https, so a sibling subdomain cannot plant one), stored hashed on the server, sliding over 30 days and never longer than 90. Sign-up, sign-in and reset answer the same whether or not an address exists, and email is sent after the answer so a slow mail server does not show in response times. Confirming an address needs both proofs: the emailed link (the mailbox) **and** the password chosen at sign-up, typed on a confirm screen, so a stranger who signs up first with someone else's address cannot be handed that account when the real owner clicks. That owner recovers with "Forgot password?", which proves the mailbox, replaces the password and signs everyone else out. Signing up again with an address that is already registered changes nothing (not the password, not the sessions, not earlier links); an unverified one is mailed one more link, limited to five mails an hour per mailbox. Resetting or changing a password signs out the other sessions, and "Sign out everywhere" ends all of them. Emailed links keep their one-time token in the URL fragment, so it never reaches a proxy log, a Referer header or a mail scanner (verifying is a POST, not a link that does something when opened). Each user gets a private folder named by a random id; nobody can read or write outside their own, and the account database (kept private to the server's user) lives outside all of them.

**What users cannot do**, because the server's keys and databases are the operator's: infer a schema from a database variable, or choose a model, provider, address or key in a schema's `llm:` block (the operator's settings are used; batch size is at least 10, retries at most 2, context depth at most 1, and a column's instruction at most 500 characters). Schemas are limited to 50 tables, 100 columns per table and 64-character names, plus the row and cell limits above. Password hashing is the costly part of an anonymous request, so at most two run at once (a short queue, then a 503), every sign-in attempt is counted before it is hashed, and failed sign-ins are tracked per mailbox and address so a stranger cannot lock the owner out from elsewhere. Sign-ups, mail requests and Google starts are rate limited per visitor (an IPv6 visitor by its /64), and each signed-in user has a row, cell, storage, file, daily model-row and concurrent-run limit, at most 30 runs (generate, run, export, infer) and 120 schema checks a minute, and 5 password changes per 15 minutes. Every unauthenticated request that hashes a password, and every sign-in attempt, is counted before the hash runs.

**Known limits.** The same person signing in with email and with Google gets two separate accounts. Password hashing is bounded (two at once, a short queue), so a large distributed flood can still make sign-ins answer "busy" (503) for everyone until it stops; front the site with a CDN or firewall rate limit if you expect that. About 100 failed sign-ins a quarter-hour against one mailbox, spread over many addresses, will lock its owner out of password sign-in for a while (Forgot password still works). If the mail queue is full (a flood from many addresses) messages are dropped with a log line while the visitor is told to check their email. Model spend is charged per requested row up front (with the caps above), not per token, so the two daily row limits are the real ceiling; nothing stops someone making many accounts except those limits and the per-address sign-up limit (consider a verified-domain allowlist or a CAPTCHA if that matters to you). Empty folders are not counted against a user's limits. On SQLite, rate limits and run slots live in memory, so they reset on restart and assume a single server process; with `MOCKDATA_ACCOUNTS_DB` they live in Postgres (rate-limit keys stored only as hashes, run slots as leases that expire if a server dies) and are shared by every server. SMTP credentials and model keys sit in the operator's environment.

### Running several servers

One server on SQLite is the simple setup and handles a lot (see the measured numbers in CLAUDE.md). To run more than one `mockdata-ui` behind a load balancer (for availability or capacity), every server needs:

- **The same Postgres account database:** set `MOCKDATA_ACCOUNTS_DB` to the same `postgres://` URL on each. Accounts, sessions, API keys, daily model budgets, rate limits and run slots then live there and are shared, so a sign-in on one server works on all of them, and a limit is counted once across the fleet. The schema is created by whichever server starts first.
- **The same user files:** mount `<data-dir>/users` on shared storage (NFS, EFS or similar) at the same path on each server. Nothing else in the data folder is needed when the database is in Postgres.
- **The same environment:** `MOCKDATA_PUBLIC_URL`, SMTP, Google and model settings identical everywhere (the load balancer serves one public address).
- **MCP sessions routed consistently:** an MCP session lives in the memory of the server that opened it, and another server answers it with 404 (the client then reconnects). Route by the `Mcp-Session-Id` header so a session stays on one server:

```
mockdata.example.com {
  reverse_proxy 10.0.0.11:4747 10.0.0.12:4747 {
    lb_policy header Mcp-Session-Id
    health_uri /healthz
  }
}
```

Each server listens on its private address for the proxy (`--host 10.0.0.11` together with accounts mode). Per server and not shared, by design: the password-hashing queue (two at once, so sign-in capacity grows with servers), the outgoing mail queue, and the generation worker threads.

### Hosted MCP (accounts mode)

In accounts mode the web server also serves MCP (Streamable HTTP) at `<MOCKDATA_PUBLIC_URL>/mcp`, for example `https://mockdata.com/mcp`. Clients authenticate with a per-user **API key**: sign in, open the account menu, choose **API keys**, and create one. The key is shown once; only its SHA-256 is stored, and the list shows each key's name, first characters and when it was last used.

```
claude mcp add --transport http mockdata https://mockdata.com/mcp --header "Authorization: Bearer <your API key>"
```

- The key goes in the `Authorization` header only. The session cookie is not accepted at `/mcp`, so a web page cannot use a signed-in browser to call it.
- The tools work in that user's private folder, with everything in "What users cannot do" above: the operator's model settings, the row, cell, storage, file and daily model limits, and no inference from database variables. Generation runs in the worker pool, like the web UI's runs.
- A session belongs to the user who opened it; a request for it with another user's key is answered as if it did not exist. At most 5 open sessions per user and 500 in total; idle ones close after 30 minutes. Each user may send 240 requests a minute, and an address that sends 30 wrong keys in 15 minutes is refused for a while.
- Each user may hold 10 keys and revoke any of them at any time. Resetting a password through "Forgot password?" revokes all of that user's keys, because whoever knew the old password may have made one. Changing the password while signed in, or "Sign out everywhere", does not; revoke keys in the list if you need to.

The local `--http` server (above) is separate and keeps its no-login, localhost-only setup.
