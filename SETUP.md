# Enormico | Local Setup

Enormico runs simulated investment activity only. It is not connected to a real investment vehicle or payment provider. Deposits, investments, returns, and refunds have no monetary value.

## Requirements

- Node.js 22.5 or newer
- npm
- A PostgreSQL database such as Neon

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Set `DATABASE_URL` in `.env` to a PostgreSQL connection string before starting. Open <http://localhost:3001>. Do not open the HTML files directly; the pages use same-origin authenticated API calls. The server initializes the schema and seeds the five tiers on first start.

If Neon CLI has pulled settings into `.env.local`, the app reads that file when `.env` is absent.

The application does not automatically seed a wallet balance. Sign in and use **Add funds** in the wallet; all balances remain simulated.

## Email verification and password reset

Registration and password reset require an SMTP provider. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` in the server environment or a local `.env` file; see `.env.example` for the variable names. A server environment variable takes precedence over its `.env` value. At startup the server logs its process ID, the names of any missing settings, and the actual SMTP connection/authentication verification result (never credential values). If settings are missing or verification fails, the API fails closed and does not create an account or claim an email was sent. OTP codes expire after 10 minutes, are stored as salted hashes, and are single-use. Verification and resend attempts are limited.

Tests inject a local mail sink and never send real email. Delivery through a real provider requires credentials and a manual end-to-end check.

## Administrator account

To bootstrap an administrator on first start, set both `ENORMICO_ADMIN_EMAIL` and `ENORMICO_ADMIN_PASSWORD` in the server environment. If the email already exists, startup promotes that account to the `ADMIN` role without changing its password. Keep these environment values private and use a strong password. Admin routes are protected by the authenticated server session and role.

## Investment simulation rules

The existing tiers retain their rates, ranges, and durations. A tier's initial pool target is its existing maximum; an administrator can adjust that target from the protected monitor. Pools expire after 14 days. A contribution that takes a pool to or above its target is accepted in full and activates the pool. ROI uses each investment's own total contribution and is rounded to the nearest whole naira. Maturity duration is measured as exact 24-hour days from pool activation.

The Vercel cron job calls the protected `/api/cron/process` endpoint every five minutes. Set `CRON_SECRET` in Vercel so cron requests are authenticated; Vercel sends it as a bearer token. Financial state transitions are transactional and idempotent.

## Tests

```powershell
npm run build
npm test
```

Tests use isolated PGlite databases. The configured local or hosted PostgreSQL database is not reset by the test suite.

## Deploying a tester build to Vercel

1. Push the repository to GitHub and import it into Vercel as a new project.
2. Create a Neon Postgres project and copy its pooled connection string into Vercel's `DATABASE_URL` environment variable. Use the same variable locally only if you intend to use that Neon database; tests use isolated PGlite instead.
3. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` in Vercel. Registration and password reset fail closed until SMTP verification succeeds.
4. Configure a long random `CRON_SECRET` in Vercel. Set `ENORMICO_ADMIN_EMAIL` and `ENORMICO_ADMIN_PASSWORD` if you want to bootstrap a protected admin account. Add all values as Vercel environment variables; never commit them.
5. Deploy and verify `/healthz`. Test signup and email verification, login, a simulated wallet deposit, a simulated investment, password reset, and logout. Confirm no real payment or payout is possible.

The Vercel function uses Neon for durable data; do not configure a local SQLite file or depend on function filesystem persistence. The existing local/Render data remains untouched and is not imported automatically. This product is a simulation only and must not accept real funds.