# @mockdata/auth-kit

Vendored copy of `auth-kit` from the itravelmap repo (`packages/auth-kit`, source commit `0371771`), the
storage-agnostic core of email/password and OAuth accounts: scrypt password hashing with rehash-on-login,
anti-enumeration timing padding, single-use expiring email-verification and password-reset tokens, input
validation, an SMTP mailer (nodemailer) and the `AuthAdapter` interface an app implements against its own
storage. mockdata's adapter is `SqliteAuthAdapter` in `packages/accounts`.

Changes from upstream: removed `middleware.ts` (Express/Passport only), `wechat.ts` and the WeChat config
helper, and the optional `express` peer dependency; tests moved to `test/`; imports adjusted to this repo's
NodeNext resolution. It contains no Google flow, sessions, cookies or rate limiting: those are host code and
live in `packages/server` / `packages/accounts`. `test/fakeAdapter.ts` is an in-memory `AuthAdapter` for tests.
