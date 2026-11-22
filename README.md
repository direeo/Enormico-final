# Enormico

Enormico is a web-based pooled-investing simulation for user testing. It does not connect to an investment vehicle or payment provider. All deposits, balances, investments, returns, and refunds are fictional; no real funds are accepted or paid out.

## Run locally

- Node.js 22.5 or newer
- npm
- A PostgreSQL database (Neon is supported)

```powershell
npm ci
Copy-Item .env.example .env
# Set DATABASE_URL and SMTP settings in .env
npm start
```

Open <http://localhost:3001>. Configure SMTP in `.env` before testing account registration or password reset; those flows fail closed without a verified mail service.

## Tests

```powershell
npm test
```

## Deployment

The app is configured for Vercel with Neon Postgres. Follow [`SETUP.md`](./SETUP.md) for project setup, environment variables, cron processing, and smoke checks.

Never commit `.env`, database credentials, or real user data.
