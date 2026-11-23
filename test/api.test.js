const test = require('node:test');
const assert = require('node:assert/strict');
const { emailConfiguration } = require('../email-service');
const { OTP_TTL_MS } = require('../auth-utils');
const { createApplication } = require('../user-api-sqlite');
const { createTestDatabase } = require('./helpers/postgres-database');

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

async function request(url, route, { method = 'GET', cookie = '', body, headers = {} } = {}) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

function validBody(overrides = {}) {
  return {
    name: 'Alice Example',
    email: 'alice@example.com',
    username: 'alice',
    password: 'Strong-pass1!',
    phone: '555-0100',
    dob: '1990-03-15',
    ...overrides
  };
}

function adultBirthday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

test('PostgreSQL-backed API supports verified signup, password reset, and simulated investments', async t => {
  const db = await createTestDatabase();
  const previousAdminEmail = process.env.ENORMICO_ADMIN_EMAIL;
  const previousAdminPassword = process.env.ENORMICO_ADMIN_PASSWORD;
  process.env.ENORMICO_ADMIN_EMAIL = 'tester-admin@example.com';
  process.env.ENORMICO_ADMIN_PASSWORD = 'Admin-strong-pass3!';
  const application = createApplication({ database: db, initialEmailSender: null });
  await application.ready;
  const { app } = application;
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sentCodes = [];
  const previousCronSecret = process.env.CRON_SECRET;
  t.after(async () => {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousAdminEmail === undefined) delete process.env.ENORMICO_ADMIN_EMAIL;
    else process.env.ENORMICO_ADMIN_EMAIL = previousAdminEmail;
    if (previousAdminPassword === undefined) delete process.env.ENORMICO_ADMIN_PASSWORD;
    else process.env.ENORMICO_ADMIN_PASSWORD = previousAdminPassword;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  });

  application.resetRateLimits();
  assert.equal(emailConfiguration({}), null);
  const health = await request(url, '/healthz');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.data, { status: 'ok' });
  assert.equal((await fetch(`${url}/favicon.ico`)).status, 204);
  const landing = await fetch(`${url}/`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Try the simulation/);
  assert.equal(landing.headers.get('x-frame-options'), 'DENY');
  process.env.CRON_SECRET = 'test-cron-secret';
  assert.equal((await request(url, '/api/cron/process')).response.status, 401);
  assert.equal((await request(url, '/api/cron/process', { headers: { authorization: 'Bearer test-cron-secret' } })).response.status, 200);

  const unavailable = await request(url, '/api/auth/register', { method: 'POST', body: validBody() });
  assert.equal(unavailable.response.status, 503);
  application.setEmailSender(async (email, code, purpose) => sentCodes.push({ email, code, purpose }));
  const body = validBody({ dob: adultBirthday() });
  let result = await request(url, '/api/auth/register', { method: 'POST', body });
  assert.equal(result.response.status, 202);
  assert.equal(result.data.resend_after - Date.now() <= 60_000, true);
  const pending = await db.prepare('SELECT * FROM pending_registrations WHERE email = ?').get(body.email);
  assert.equal(pending.otp_expires_at - pending.created_at, OTP_TTL_MS);
  assert.notEqual(pending.password_hash, body.password);
  const code = sentCodes.find(item => item.purpose === 'registration').code;

  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: body.email, code } });
  assert.equal(result.response.status, 201);
  const cookie = cookieFrom(result.response);
  assert.ok(cookie);
  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(body.email);
  assert.equal(user.email_verified, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(user.id)).n, 1);
  assert.equal((await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: body.email, code } })).response.status, 400);
  assert.equal((await request(url, '/api/wallet', { cookie })).response.status, 200);

  result = await request(url, '/api/auth/password-reset/request', { method: 'POST', body: { email: body.email } });
  assert.equal(result.response.status, 202);
  const resetCode = sentCodes.find(item => item.purpose === 'password-reset').code;
  result = await request(url, '/api/auth/password-reset/confirm', {
    method: 'POST', body: { email: body.email, code: resetCode, password: 'New-strong-pass2!' }
  });
  assert.equal(result.response.status, 200);
  assert.equal((await request(url, '/api/wallet', { cookie })).response.status, 401);
  const login = await request(url, '/api/auth/login', { method: 'POST', body: { identity: body.email, password: 'New-strong-pass2!' } });
  assert.equal(login.response.status, 200);
  const session = cookieFrom(login.response);

  const depositHeaders = { 'Idempotency-Key': 'wallet-deposit-attempt-0001' };
  const deposit = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: session, body: { amount: 600000 }, headers: depositHeaders });
  const replay = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: session, body: { amount: 600000 }, headers: depositHeaders });
  assert.equal(deposit.response.status, 201);
  assert.equal(replay.data.wallet.available_balance, 600000);
  assert.equal((await request(url, '/api/wallet/deposits', {
    method: 'POST', cookie: session, body: { amount: 700000 }, headers: depositHeaders
  })).response.status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND type = 'SIMULATED_DEPOSIT'").get(user.id)).n, 1);

  const investment = await request(url, '/api/investments', {
    method: 'POST', cookie: session, body: { plan_rate: 10, amount: 50000 },
    headers: { 'Idempotency-Key': 'investment-create-attempt-001' }
  });
  assert.equal(investment.response.status, 201);
  const cancel = await request(url, `/api/investments/${investment.data.investment.id}/cancel`, {
    method: 'POST', cookie: session, body: {},
    headers: { 'Idempotency-Key': 'investment-cancel-attempt-001' }
  });
  assert.equal(cancel.data.investment.status, 'CANCELLED');
  assert.equal((await request(url, '/api/admin/stats', { cookie: session })).response.status, 403);
  const adminLogin = await request(url, '/api/auth/login', {
    method: 'POST', body: { identity: 'tester-admin@example.com', password: 'Admin-strong-pass3!' }
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal((await request(url, '/api/admin/stats', { cookie: cookieFrom(adminLogin.response) })).response.status, 200);
  assert.equal((await request(url, '/api/auth/logout', { method: 'POST', cookie: session, body: {} })).response.status, 204);
  assert.equal((await request(url, '/api/wallet', { cookie: session })).response.status, 401);
});
