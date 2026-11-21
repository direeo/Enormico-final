const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emailConfiguration } = require('../email-service');
const { OTP_MAX_ATTEMPTS, OTP_MAX_RESENDS, OTP_TTL_MS, validatePassword } = require('../auth-utils');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'enormico-api-'));
process.env.DB_FILE = path.join(tempDirectory, 'api.sqlite');
const serverModule = require('../user-api-sqlite');
const { app, db, setEmailSender, resetRateLimits } = serverModule;
const server = app.listen(0);
const baseUrl = new Promise(resolve => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const sentCodes = [];

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

function codeFor(email, purpose = 'registration', start = 0) {
  const match = sentCodes.slice(start).reverse().find(item => item.email === email.toLowerCase() && item.purpose === purpose);
  assert.ok(match, `expected ${purpose} email for ${email}`);
  return match.code;
}

function eighteenBirthday(offsetDays = 0) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate() + offsetDays));
  return date.toISOString().slice(0, 10);
}

test('registration, OTP, reset, authentication, authorization, and financial retries', async t => {
  const url = await baseUrl;
  resetRateLimits();
  setEmailSender(async (email, code, purpose) => { sentCodes.push({ email, code, purpose }); });
  t.after(() => {
    setEmailSender(null);
    server.close();
    db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  const health = await request(url, '/healthz');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.data, { status: 'ok' });
  assert.equal(health.response.headers.get('cache-control'), null);
  const landing = await fetch(`${url}/`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Try the simulation/);
  assert.equal(landing.headers.get('x-frame-options'), 'DENY');
  assert.match(landing.headers.get('content-security-policy'), /script-src 'self'/);

  assert.equal(emailConfiguration({}), null);
  setEmailSender(null);
  assert.equal(serverModule.getEmailStatus().state, 'unconfigured');
  let result = await request(url, '/api/auth/register', { method: 'POST', body: validBody() });
  assert.equal(result.response.status, 503);
  const resetWithoutEmail = await request(url, '/api/auth/password-reset/request', { method: 'POST', body: { email: 'someone@example.com' } });
  assert.equal(resetWithoutEmail.response.status, 503);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  setEmailSender(async (email, code, purpose) => { sentCodes.push({ email, code, purpose }); });

  const invalidPasswords = ['lowercase1!', 'UPPERCASE1!', 'NoNumber!!', 'NoSpecial1', 'Aa1!', 'Aa1!'.repeat(60)];
  for (let i = 0; i < invalidPasswords.length; i += 1) {
    const body = validBody({ email: `bad-password-${i}@example.com`, username: `badpassword${i}`, password: invalidPasswords[i] });
    const response = await request(url, '/api/auth/register', { method: 'POST', body });
    assert.equal(response.response.status, 400);
    assert.ok(response.data.fieldErrors.password);
  }
  assert.equal(validatePassword('Strong-pass1!'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 0);

  for (const [label, dob] of [
    ['underage', eighteenBirthday(1)],
    ['invalid-date', '2008-02-31'],
    ['future-date', '2999-01-01']
  ]) {
    const response = await request(url, '/api/auth/register', {
      method: 'POST', body: validBody({ email: `${label}@example.com`, username: label, dob })
    });
    assert.equal(response.response.status, 400);
    assert.ok(response.data.fieldErrors.dob);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);

  const adultEmail = 'adult@example.com';
  const adultBody = validBody({ email: adultEmail, username: 'adult', dob: eighteenBirthday(0) });
  const parallel = await Promise.all([
    request(url, '/api/auth/register', { method: 'POST', body: adultBody }),
    request(url, '/api/auth/register', { method: 'POST', body: { ...adultBody, email: 'ADULT@example.com', username: 'ADULT' } })
  ]);
  assert.deepEqual(parallel.map(item => item.response.status).sort(), [202, 409]);
  const registration = parallel.find(item => item.response.status === 202);
  assert.equal(registration.data.email, adultEmail);
  result = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'adult', password: adultBody.password } });
  assert.equal(result.response.status, 401);
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: 'ADULT@example.com', username: 'a-different-name', dob: adultBody.dob }) });
  assert.equal(result.response.status, 409);
  assert.ok(result.data.fieldErrors.email);
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: 'another@example.com', username: 'ADULT', dob: adultBody.dob }) });
  assert.equal(result.response.status, 409);
  assert.ok(result.data.fieldErrors.username);
  assert.equal(JSON.stringify(registration.data).includes(codeFor(adultEmail)), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE email = ?').get(adultEmail);
  assert.ok(pending.password_hash);
  assert.notEqual(pending.password_hash, adultBody.password);
  assert.equal(pending.otp_hash.includes(codeFor(adultEmail)), false);
  assert.equal(pending.otp_expires_at - pending.created_at, OTP_TTL_MS);

  let otp = codeFor(adultEmail);
  result = await request(url, '/api/auth/resend-otp', { method: 'POST', body: { email: adultEmail } });
  assert.equal(result.response.status, 429);
  db.prepare('UPDATE pending_registrations SET resend_after = 0 WHERE email = ?').run(adultEmail);
  result = await request(url, '/api/auth/resend-otp', { method: 'POST', body: { email: adultEmail } });
  assert.equal(result.response.status, 202);
  const resentOtp = codeFor(adultEmail);
  assert.notEqual(resentOtp, otp);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: adultEmail, code: otp } });
  assert.equal(result.response.status, 401);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: adultEmail, code: resentOtp } });
  assert.equal(result.response.status, 201);
  const aliceCookie = cookieFrom(result.response);
  assert.ok(aliceCookie);
  const alice = db.prepare('SELECT * FROM users WHERE email = ?').get(adultEmail);
  assert.equal(alice.email_verified, 1);
  assert.equal(alice.password, null);
  assert.notEqual(alice.password_hash, adultBody.password);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(alice.id).n, 1);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: adultEmail, code: resentOtp } });
  assert.equal(result.response.status, 400);

  const expirationEmail = 'expiration@example.com';
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: expirationEmail, username: 'expiration', dob: '1992-02-02' }) });
  assert.equal(result.response.status, 202);
  const expiredCode = codeFor(expirationEmail);
  db.prepare('UPDATE pending_registrations SET otp_expires_at = ?, resend_after = 0 WHERE email = ?').run(Date.now() - 1, expirationEmail);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: expirationEmail, code: expiredCode } });
  assert.equal(result.response.status, 410);
  result = await request(url, '/api/auth/resend-otp', { method: 'POST', body: { email: expirationEmail } });
  assert.equal(result.response.status, 202);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: expirationEmail, code: codeFor(expirationEmail) } });
  assert.equal(result.response.status, 201);

  const limitedEmail = 'limited@example.com';
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: limitedEmail, username: 'limited', dob: '1993-02-02' }) });
  assert.equal(result.response.status, 202);
  const correctLimitedCode = codeFor(limitedEmail);
  const wrongCode = correctLimitedCode === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
    result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: limitedEmail, code: wrongCode } });
    assert.equal(result.response.status, 401);
  }
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: limitedEmail, code: correctLimitedCode } });
  assert.equal(result.response.status, 429);
  db.prepare('UPDATE pending_registrations SET resend_after = 0 WHERE email = ?').run(limitedEmail);
  result = await request(url, '/api/auth/resend-otp', { method: 'POST', body: { email: limitedEmail } });
  assert.equal(result.response.status, 202);
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: limitedEmail, code: codeFor(limitedEmail) } });
  assert.equal(result.response.status, 201);

  const cappedEmail = 'resendcap@example.com';
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: cappedEmail, username: 'resendcap', dob: '1994-02-02' }) });
  assert.equal(result.response.status, 202);
  db.prepare('UPDATE pending_registrations SET resend_count = ?, resend_after = 0 WHERE email = ?').run(OTP_MAX_RESENDS, cappedEmail);
  result = await request(url, '/api/auth/resend-otp', { method: 'POST', body: { email: cappedEmail } });
  assert.equal(result.response.status, 429);

  const failedEmail = 'mail-failure@example.com';
  setEmailSender(async () => { throw new Error('provider down'); });
  result = await request(url, '/api/auth/register', { method: 'POST', body: validBody({ email: failedEmail, username: 'mailfailure', dob: '1995-02-02' }) });
  assert.equal(result.response.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_registrations WHERE email = ?').get(failedEmail).n, 0);
  setEmailSender(async (email, code, purpose) => { sentCodes.push({ email, code, purpose }); });

  result = await request(url, '/api/auth/password-reset/request', { method: 'POST', body: { email: adultEmail } });
  assert.equal(result.response.status, 202);
  const originalResetCode = codeFor(adultEmail, 'password-reset');
  assert.equal(JSON.stringify(result.data).includes(originalResetCode), false);
  let reset = db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(alice.id);
  assert.equal(reset.otp_expires_at - reset.created_at, OTP_TTL_MS);
  const wrongReset = originalResetCode === '000000' ? '000001' : '000000';
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: wrongReset, password: 'New-strong-pass2!' } });
  assert.equal(result.response.status, 401);
  db.prepare('UPDATE password_resets SET otp_expires_at = ?, resend_after = 0 WHERE user_id = ?').run(Date.now() - 1, alice.id);
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: originalResetCode, password: 'New-strong-pass2!' } });
  assert.equal(result.response.status, 410);
  result = await request(url, '/api/auth/password-reset/request', { method: 'POST', body: { email: adultEmail } });
  assert.equal(result.response.status, 202);
  const newResetCode = codeFor(adultEmail, 'password-reset');
  assert.notEqual(newResetCode, originalResetCode);
  const cooldownReset = await request(url, '/api/auth/password-reset/request', { method: 'POST', body: { email: adultEmail } });
  assert.equal(cooldownReset.response.status, 202);
  assert.equal(codeFor(adultEmail, 'password-reset'), newResetCode);
  reset = db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(alice.id);
  const wrongResetCode = newResetCode === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
    result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: wrongResetCode, password: 'New-strong-pass2!' } });
    assert.equal(result.response.status, 401);
  }
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: newResetCode, password: 'New-strong-pass2!' } });
  assert.equal(result.response.status, 429);
  db.prepare('UPDATE password_resets SET otp_attempts = 0 WHERE user_id = ?').run(alice.id);
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: originalResetCode, password: 'New-strong-pass2!' } });
  assert.equal(result.response.status, 401);
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: newResetCode, password: 'New-strong-pass2!' } });
  assert.equal(result.response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(alice.id).n, 0);
  assert.equal((await request(url, '/api/wallet', { cookie: aliceCookie })).response.status, 401);
  result = await request(url, '/api/auth/password-reset/confirm', { method: 'POST', body: { email: adultEmail, code: newResetCode, password: 'Other-strong-pass3!' } });
  assert.equal(result.response.status, 410);

  result = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'ADULT', password: adultBody.password } });
  assert.equal(result.response.status, 401);
  const aliceLogin = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'ADULT', password: 'New-strong-pass2!' } });
  assert.equal(aliceLogin.response.status, 200);
  const aliceSession = cookieFrom(aliceLogin.response);

  const bobBody = validBody({ name: 'Bob Example', email: 'bob@example.com', username: 'bob', password: 'Another-pass2!', dob: '1991-03-15' });
  result = await request(url, '/api/auth/register', { method: 'POST', body: bobBody });
  assert.equal(result.response.status, 202);
  const bobVerification = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: bobBody.email, code: codeFor(bobBody.email) } });
  assert.equal(bobVerification.response.status, 201);
  const bobCookie = cookieFrom(bobVerification.response);

  result = await request(url, '/api/wallet');
  assert.equal(result.response.status, 401);
  const missingKey = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: aliceSession, body: { amount: 600000 } });
  assert.equal(missingKey.response.status, 400);
  const depositHeaders = { 'Idempotency-Key': 'wallet-deposit-attempt-0001' };
  const firstDeposit = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: aliceSession, body: { amount: 600000 }, headers: depositHeaders });
  const replayDeposit = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: aliceSession, body: { amount: 600000 }, headers: depositHeaders });
  assert.equal(firstDeposit.response.status, 201);
  assert.equal(replayDeposit.data.wallet.available_balance, 600000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND type = 'SIMULATED_DEPOSIT'").get(alice.id).n, 1);
  const keyConflict = await request(url, '/api/wallet/deposits', { method: 'POST', cookie: aliceSession, body: { amount: 700000 }, headers: depositHeaders });
  assert.equal(keyConflict.response.status, 409);

  const created = await request(url, '/api/investments', {
    method: 'POST', cookie: aliceSession, body: { plan_rate: 10, amount: 50000 }, headers: { 'Idempotency-Key': 'investment-create-attempt-001' }
  });
  assert.equal(created.response.status, 201);
  const duplicateInvestment = await request(url, '/api/investments', {
    method: 'POST', cookie: aliceSession, body: { plan_rate: 10, amount: 50000 }, headers: { 'Idempotency-Key': 'investment-create-attempt-001' }
  });
  assert.equal(duplicateInvestment.data.investment.id, created.data.investment.id);
  const deniedOtherInvestment = await request(url, `/api/investments/${created.data.investment.id}`, { cookie: bobCookie });
  assert.equal(deniedOtherInvestment.response.status, 404);
  const contributionHeaders = { 'Idempotency-Key': 'contribution-request-attempt-001' };
  const contribution = await request(url, `/api/investments/${created.data.investment.id}/contributions`, {
    method: 'POST', cookie: aliceSession, body: { amount: 10000 }, headers: contributionHeaders
  });
  const replayContribution = await request(url, `/api/investments/${created.data.investment.id}/contributions`, {
    method: 'POST', cookie: aliceSession, body: { amount: 10000 }, headers: contributionHeaders
  });
  assert.equal(contribution.data.investment.contribution, 60000);
  assert.equal(replayContribution.data.investment.contribution, 60000);
  const cancelHeaders = { 'Idempotency-Key': 'cancel-request-attempt-0001' };
  const cancellation = await request(url, `/api/investments/${created.data.investment.id}/cancel`, {
    method: 'POST', cookie: aliceSession, body: {}, headers: cancelHeaders
  });
  const replayCancellation = await request(url, `/api/investments/${created.data.investment.id}/cancel`, {
    method: 'POST', cookie: aliceSession, body: {}, headers: cancelHeaders
  });
  assert.equal(cancellation.data.investment.status, 'CANCELLED');
  assert.equal(replayCancellation.data.investment.status, 'CANCELLED');
  const aliceTransactions = await request(url, '/api/wallet/transactions', { cookie: aliceSession });
  const bobTransactions = await request(url, '/api/wallet/transactions', { cookie: bobCookie });
  assert.equal(aliceTransactions.data.transactions.length, 4);
  assert.equal(bobTransactions.data.transactions.length, 0);
  assert.equal(aliceTransactions.data.transactions.filter(item => item.type === 'ADDITIONAL_CONTRIBUTION').length, 1);
  assert.equal(aliceTransactions.data.transactions.filter(item => item.type === 'CANCELLATION_REFUND').length, 1);
  const aliceWallet = await request(url, '/api/wallet', { cookie: aliceSession });
  assert.equal(aliceWallet.data.wallet.available_balance, 600000);
  assert.equal(aliceWallet.data.wallet.pending_balance, 0);

  const forbiddenAdmin = await request(url, '/api/admin/stats', { cookie: aliceSession });
  assert.equal(forbiddenAdmin.response.status, 403);
  const adminInsert = db.prepare(`INSERT INTO users (name, email, username, password_hash, role, created_at)
    VALUES ('Admin User', 'admin@example.com', 'admin', ?, 'ADMIN', ?)`)
    .run(serverModule.passwordHash('Admin-strong-pass2!'), Date.now());
  db.prepare('INSERT INTO wallets (user_id, updated_at) VALUES (?, ?)').run(Number(adminInsert.lastInsertRowid), Date.now());
  const adminLogin = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'admin', password: 'Admin-strong-pass2!' } });
  assert.equal((await request(url, '/api/admin/stats', { cookie: cookieFrom(adminLogin.response) })).response.status, 200);

  const logout = await request(url, '/api/auth/logout', { method: 'POST', cookie: aliceSession, body: {} });
  assert.equal(logout.response.status, 204);
  assert.equal((await request(url, '/api/wallet', { cookie: aliceSession })).response.status, 401);

  for (let i = 0; i < 10; i += 1) {
    result = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'nobody', password: 'Wrong-pass1!' } });
    assert.equal(result.response.status, 401);
  }
  result = await request(url, '/api/auth/login', { method: 'POST', body: { identity: 'nobody', password: 'Wrong-pass1!' } });
  assert.equal(result.response.status, 429);
  resetRateLimits();
  for (let i = 0; i < 20; i += 1) {
    result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: 'unknown@example.com', code: '000000' } });
    assert.equal(result.response.status, 400);
  }
  result = await request(url, '/api/auth/verify-otp', { method: 'POST', body: { email: 'unknown@example.com', code: '000000' } });
  assert.equal(result.response.status, 429);
  assert.equal((await fetch(`${url}/api.sqlite`)).status, 404);
});