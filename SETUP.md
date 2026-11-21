# Enormico | Local Setup

Enormico runs simulated investment activity only. It is not connected to a real investment vehicle or payment provider. Deposits, investments, returns, and refunds have no monetary value.

## Requirements

- Node.js 22.5 or newer (the application uses Node's built-in `node:sqlite` module)
- npm

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3001>. Do not open the HTML files directly; the pages use same-origin authenticated API calls. The server initializes or upgrades `users.db` and seeds the five existing tiers. Existing account rows are retained; legacy plaintext passwords are converted to scrypt hashes on server startup and cleared from the old column.

For a disposable database, set `DB_FILE` before starting the server. The application does not automatically seed a wallet balance. Sign in and use **Add funds** in the wallet.

## Email verification and password reset

Registration and password reset require an SMTP provider. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` in the server environment or a local `.env` file; see `.env.example` for the variable names. A server environment variable takes precedence over its `.env` value. At startup the server logs its process ID, the names of any missing settings, and the actual SMTP connection/authentication verification result (never credential values). If settings are missing or verification fails, the API fails closed and does not create an account or claim an email was sent. OTP codes expire after 10 minutes, are stored as salted hashes, and are single-use. Verification and resend attempts are limited.

Tests inject a local mail sink and never send real email. Delivery through a real provider requires credentials and a manual end-to-end check.

## Administrator account

To bootstrap an administrator on first start, set both `ENORMICO_ADMIN_EMAIL` and `ENORMICO_ADMIN_PASSWORD` in the server environment. If the email already exists, startup promotes that account to the `ADMIN` role without changing its password. Keep these environment values private and use a strong password. Admin routes are protected by the authenticated server session and role.

## Investment simulation rules

The existing tiers retain their rates, ranges, and durations. A tier's initial pool target is its existing maximum; an administrator can adjust that target from the protected monitor. Pools expire after 14 days. A contribution that takes a pool to or above its target is accepted in full and activates the pool. ROI uses each investment's own total contribution and is rounded to the nearest whole naira. Maturity duration is measured as exact 24-hour days from pool activation.

The server processes expiries and maturities on startup and once per minute. Each transition is guarded by a persisted state change and ledger idempotency key so repeated processing does not duplicate credits or refunds.

## Tests

```powershell
npm test
```

Tests use isolated in-memory or temporary SQLite databases. The local database is not reset by the test suite.

## Deploying a tester build to Render

The root `render.yaml` configures the service to run the test suite during deployment, use `npm start`, store SQLite at `/var/data/users.db`, and answer Render health checks at `/healthz`.

1. Create a Git repository and push the project. Check `git status` before committing; `.env`, `users.db`, and SQLite journal files must not be included. If a database file was already staged, remove it from the index before committing.
2. In Render, create a **Blueprint** and connect the repository. Keep the configured `starter` web-service plan: Render persistent disks require a paid web service.
3. Before the first deploy, set the SMTP secrets (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`) in Render. Set `SMTP_PORT` and `SMTP_SECURE` to match the provider. Registration and password reset intentionally remain unavailable until SMTP verification succeeds.
4. Set `ENORMICO_ADMIN_EMAIL` and `ENORMICO_ADMIN_PASSWORD` to bootstrap the first admin. Use a private, strong password. These values are secrets; do not put them in the Blueprint or Git.
5. Wait for the deployment and `/healthz` check to pass. Use the Render URL to test signup and email verification, login, a simulated wallet deposit, a simulated investment, password reset, and logout. Confirm no real payment or payout is possible.

The persistent disk keeps the SQLite database across deploys and restarts. Keep this app at one running instance: a local SQLite database on one disk is not a shared database for multiple instances. If the app needs horizontal scaling or higher availability, migrate persistence to a managed database before scaling. Back up user data before making schema or hosting changes.