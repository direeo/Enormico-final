# Enormico

Enormico is a web-based pooled-investing simulation for user testing. It does not connect to an investment vehicle or payment provider. All deposits, balances, investments, returns, and refunds are fictional; no real funds are accepted or paid out.

## Run locally

- Node.js 22.5 or newer
- npm

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Open <http://localhost:3001>. Configure SMTP in `.env` before testing account registration or password reset; those flows fail closed without a verified mail service.

## Tests

```powershell
npm test
```

## Deployment

The repository includes a Render Blueprint in [`render.yaml`](./render.yaml). It configures a Node web service, a persistent disk for SQLite, and a health check. Follow [`SETUP.md`](./SETUP.md) for deployment, environment variables, smoke checks, and operational limits.

Never commit `.env`, database files, or real user data. The local SQLite database is excluded by `.gitignore`.
