const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createDatabase, initializeDatabase } = require('./database');
const { createPlatform, DAY_MS } = require('./platform');
const {
  OTP_TTL_MS, OTP_RESEND_COOLDOWN_MS, OTP_MAX_ATTEMPTS, OTP_MAX_RESENDS,
  normalizeEmail, normalizeUsername, validatePassword, generateOtp, hashOtp,
  verifyOtp, validateRegistration
} = require('./auth-utils');
const { createEmailSender, missingEmailSettings, classifyEmailError } = require('./email-service');

const envFile = ['.env', '.env.local']
  .map(filename => path.join(__dirname, filename))
  .find(filename => fs.existsSync(filename));
if (envFile && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT || 3001);
const SESSION_MS = 7 * DAY_MS;
const COOKIE_NAME = 'enormico_session';
const trustProxyHops = process.env.TRUST_PROXY_HOPS ?? (process.env.VERCEL ? '1' : undefined);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function createApplication({ database = createDatabase(), initialEmailSender } = {}) {
  const db = database;
  const platform = createPlatform(db);
  const app = express();
  if (trustProxyHops !== undefined) {
    const parsedHops = Number(trustProxyHops);
    if (!/^\d+$/.test(trustProxyHops) || !Number.isSafeInteger(parsedHops)) {
      throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
    }
    app.set('trust proxy', parsedHops);
  }
  const loginAttempts = new Map();
  const authRateLimits = new Map();
  let emailSender = initialEmailSender === undefined ? createEmailSender() : initialEmailSender;
  let emailStatus = emailSender ? { state: 'checking' } : { state: 'unconfigured', missing: missingEmailSettings() };

  function emailUnavailableMessage(action = 'Email verification') {
    if (emailStatus.state === 'unconfigured') {
      return `${action} is unavailable. Missing server settings: ${emailStatus.missing.join(', ') || 'SMTP configuration'}.`;
    }
    if (emailStatus.state === 'checking') return `${action} is checking the SMTP connection. Try again in a few seconds.`;
    if (emailStatus.state === 'failed') {
      return `${action} is unavailable because the SMTP ${emailStatus.category} check failed (${emailStatus.code}). Check the server log and SMTP settings.`;
    }
    return `${action} is unavailable. Check the server email configuration.`;
  }

  async function verifyEmailTransport() {
    const sender = emailSender;
    if (!sender) return;
    if (typeof sender.verify !== 'function') {
      emailStatus = { state: 'failed', category: 'transporter initialization', code: 'VERIFY_UNAVAILABLE' };
      console.error(`SMTP verification unavailable (pid=${process.pid}, code=VERIFY_UNAVAILABLE).`);
      return;
    }
    emailStatus = { state: 'checking' };
    try {
      await sender.verify();
      if (sender !== emailSender) return;
      emailStatus = { state: 'verified' };
      console.log(`SMTP connection and authentication verified (pid=${process.pid}).`);
    } catch (error) {
      if (sender !== emailSender) return;
      const diagnostic = classifyEmailError(error);
      emailStatus = { state: 'failed', ...diagnostic };
      console.error(`SMTP verification failed (pid=${process.pid}, category=${diagnostic.category}, code=${diagnostic.code}).`);
    }
  }

  function logEmailUnavailable(action) {
    const details = emailStatus.state === 'unconfigured'
      ? `missing=${emailStatus.missing.join(',') || 'unknown'}`
      : `state=${emailStatus.state}${emailStatus.code ? ` category=${emailStatus.category} code=${emailStatus.code}` : ''}`;
    console.warn(`${action} rejected by SMTP state (pid=${process.pid}, ${details}).`);
  }

  function consumeRateLimit(key, limit, windowMs, now = Date.now()) {
    const current = authRateLimits.get(key);
    if (!current || current.expiresAt <= now) {
      authRateLimits.set(key, { count: 1, expiresAt: now + windowMs });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  function clientAddress(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  function authRateLimited(req, action, limit, windowMs) {
    return !consumeRateLimit(`${action}:${clientAddress(req)}`, limit, windowMs);
  }

  function purgeExpiredRateLimits(now = Date.now()) {
    for (const [key, limit] of authRateLimits) {
      if (limit.expiresAt <= now) authRateLimits.delete(key);
    }
    for (const [key, attempt] of loginAttempts) {
      if (attempt.expiresAt <= now) loginAttempts.delete(key);
    }
  }

  function fieldError(res, field, message, status = 400) {
    return res.status(status).json({ error: message, fieldErrors: { [field]: message } });
  }

  function requireIdempotencyKey(req, res) {
    const key = req.get('Idempotency-Key')?.trim();
    if (!key || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      res.status(400).json({ error: 'A valid Idempotency-Key header is required for this financial operation.' });
      return null;
    }
    return key;
  }

  function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  function passwordMatches(password, savedHash) {
    if (!savedHash || !savedHash.includes(':')) return false;
    const [salt, saved] = savedHash.split(':');
    const calculated = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(saved, 'hex');
    return expected.length === calculated.length && crypto.timingSafeEqual(expected, calculated);
  }

  async function ensureConfiguredAdmin() {
    const email = process.env.ENORMICO_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ENORMICO_ADMIN_PASSWORD;
    if (!email || !password) return;
    await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(?)').get(8274002);
      const user = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
      if (!user) {
        const username = email.split('@')[0].slice(0, 30) || 'admin';
        const result = await db.prepare(`INSERT INTO users (name, email, username, password_hash, role, created_at)
          VALUES (?, ?, ?, ?, 'ADMIN', ?) RETURNING id`)
          .run('Enormico Administrator', email, `${username}-admin`, passwordHash(password), Date.now());
        const userId = Number(result.lastInsertRowid);
        await db.prepare('INSERT INTO wallets (user_id, updated_at) VALUES (?, ?)').run(userId, Date.now());
        return;
      }
      if (user.role !== 'ADMIN') await db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").run(user.id);
    });
  }

  const ready = initializeDatabase(db).then(ensureConfiguredAdmin).then(verifyEmailTransport);

  app.disable('x-powered-by');
  app.use(async (req, res, next) => {
    await ready;
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'"
    ].join('; '));
    if (process.env.NODE_ENV === 'production' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request rejected.' });
      } catch {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    }
    next();
  });

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, username: user.username, role: user.role };
}

async function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_MS;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), userId, expiresAt, Date.now());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function sessionToken(req) {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1)) : null;
}

async function requireAuth(req, res, next) {
  const token = sessionToken(req);
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.prepare(`SELECT u.id, u.name, u.email, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(tokenHash, Date.now());
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  req.user = session;
  req.sessionHash = tokenHash;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

app.post('/api/auth/register', async (req, res) => {
  if (authRateLimited(req, 'register', 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
  const { errors, value } = validateRegistration(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Check the highlighted fields.', fieldErrors: errors });
  if (emailStatus.state !== 'verified') {
    logEmailUnavailable('Registration');
    return res.status(503).json({ error: emailUnavailableMessage() });
  }

  const now = Date.now();
  const code = generateOtp();
  const otp = hashOtp(code);
  try {
    await platform.transaction(async () => {
      await db.prepare('DELETE FROM pending_registrations WHERE otp_expires_at <= ?').run(now);
      if (await db.prepare('SELECT 1 FROM users WHERE lower(email) = ? OR lower(username) = ?').get(value.email, value.username)) {
        const conflict = await db.prepare('SELECT email, username FROM users WHERE lower(email) = ? OR lower(username) = ?').get(value.email, value.username);
        if (conflict.email.toLowerCase() === value.email) throw Object.assign(new Error('Email is already registered.'), { status: 409, field: 'email' });
        throw Object.assign(new Error('Username is already taken.'), { status: 409, field: 'username' });
      }
      const pending = await db.prepare('SELECT email, username FROM pending_registrations WHERE lower(email) = ? OR lower(username) = ?').get(value.email, value.username);
      if (pending) {
        if (pending.email.toLowerCase() === value.email) throw Object.assign(new Error('Email already has a pending verification.'), { status: 409, field: 'email' });
        throw Object.assign(new Error('Username is already reserved for verification.'), { status: 409, field: 'username' });
      }
      await db.prepare(`INSERT INTO pending_registrations
        (name, email, username, password_hash, phone, dob, otp_salt, otp_hash, otp_expires_at, otp_attempts, resend_after, resend_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`)
        .run(value.name, value.email, value.username, passwordHash(value.password), value.phone, value.dob,
          otp.salt, otp.hash, now + OTP_TTL_MS, now + OTP_RESEND_COOLDOWN_MS, now);
    });
  } catch (error) {
    if (error.status) return fieldError(res, error.field, error.message, error.status);
    if (error.code === '23505') return res.status(409).json({ error: 'Email or username is already registered.' });
    console.error('Registration could not be stored:', error.message);
    return res.status(500).json({ error: 'Registration could not be completed.' });
  }

  try {
    await emailSender(value.email, code, 'registration');
  } catch (error) {
    const diagnostic = classifyEmailError(error);
    console.error(`Registration OTP delivery failed (pid=${process.pid}, category=${diagnostic.category}, code=${diagnostic.code}).`);
    await db.prepare('DELETE FROM pending_registrations WHERE email = ? AND otp_hash = ?').run(value.email, otp.hash);
    return res.status(502).json({ error: 'Verification email could not be delivered. Check your address or try again later.' });
  }
  res.status(202).json({ message: 'A verification code has been sent to your email.', email: value.email, resend_after: now + OTP_RESEND_COOLDOWN_MS });
});

app.post('/api/auth/verify-otp', async (req, res) => {
  if (authRateLimited(req, 'verify-otp', 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many verification attempts. Try again later.' });
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit code sent to your email.' });
  const now = Date.now();
  const pending = await db.prepare('SELECT * FROM pending_registrations WHERE lower(email) = ?').get(email);
  if (!pending) return res.status(400).json({ error: 'This verification request is no longer active. Register again to receive a new code.' });
  if (pending.otp_expires_at <= now) return res.status(410).json({ error: 'This code has expired. Request a new code to continue.' });
  if (pending.otp_attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many incorrect codes. Request a new code to continue.' });
  if (!verifyOtp(code, pending.otp_salt, pending.otp_hash)) {
    const attempts = (await db.prepare(`UPDATE pending_registrations SET otp_attempts = otp_attempts + 1
      WHERE id = ? AND otp_attempts < ?`).run(pending.id, OTP_MAX_ATTEMPTS)).changes;
    return res.status(attempts ? 401 : 429).json({ error: attempts ? 'The verification code is incorrect.' : 'Too many incorrect codes. Request a new code to continue.' });
  }

  let userId;
  try {
    userId = await platform.transaction(async () => {
      const current = await db.prepare('SELECT * FROM pending_registrations WHERE id = ? FOR UPDATE').get(pending.id);
      if (!current || current.otp_hash !== pending.otp_hash || current.otp_expires_at <= Date.now()) {
        throw Object.assign(new Error('This verification code is no longer valid.'), { status: 410 });
      }
      const result = await db.prepare(`INSERT INTO users (name, email, username, password_hash, phone, dob, email_verified, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'USER', ?) RETURNING id`)
        .run(current.name, current.email, current.username, current.password_hash, current.phone, current.dob, Date.now());
      const id = Number(result.lastInsertRowid);
      await db.prepare('INSERT INTO wallets (user_id, updated_at) VALUES (?, ?)').run(id, Date.now());
      await db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(current.id);
      return id;
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Email or username is already registered.' });
    console.error('Account activation failed:', error.message);
    return res.status(500).json({ error: 'Account activation could not be completed.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  await issueSession(userId, res);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/resend-otp', async (req, res) => {
  if (authRateLimited(req, 'resend-otp', 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many code requests. Try again later.' });
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter the email address used to register.' });
  if (emailStatus.state !== 'verified') {
    logEmailUnavailable('OTP resend');
    return res.status(503).json({ error: emailUnavailableMessage() });
  }
  const pending = await db.prepare('SELECT * FROM pending_registrations WHERE lower(email) = ?').get(email);
  if (!pending) return res.status(202).json({ message: 'If a verification request is active, a new code will be sent.' });
  const now = Date.now();
  if (pending.resend_after > now) return res.status(429).json({ error: 'Please wait before requesting another code.', retry_after: pending.resend_after });
  if (pending.resend_count >= OTP_MAX_RESENDS) return res.status(429).json({ error: 'The resend limit has been reached. Start registration again later.' });

  const code = generateOtp();
  const otp = hashOtp(code);
  const changed = (await db.prepare(`UPDATE pending_registrations SET otp_salt = ?, otp_hash = ?, otp_expires_at = ?,
    otp_attempts = 0, resend_after = ?, resend_count = resend_count + 1
    WHERE id = ? AND resend_after <= ? AND resend_count < ?`)
    .run(otp.salt, otp.hash, now + OTP_TTL_MS, now + OTP_RESEND_COOLDOWN_MS, pending.id, now, OTP_MAX_RESENDS)).changes;
  if (!changed) return res.status(429).json({ error: 'A new code cannot be sent yet.' });
  try {
    await emailSender(email, code, 'registration');
  } catch (error) {
    const diagnostic = classifyEmailError(error);
    console.error(`OTP resend delivery failed (pid=${process.pid}, category=${diagnostic.category}, code=${diagnostic.code}).`);
    await db.prepare('DELETE FROM pending_registrations WHERE id = ? AND otp_hash = ?').run(pending.id, otp.hash);
    return res.status(502).json({ error: 'Verification email could not be delivered. Register again later.' });
  }
  res.status(202).json({ message: 'A new verification code has been sent.', resend_after: now + OTP_RESEND_COOLDOWN_MS });
});

app.post('/api/auth/password-reset/request', async (req, res) => {
  if (authRateLimited(req, 'password-reset-request', 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many reset requests. Try again later.' });
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter your account email address.' });
  if (emailStatus.state !== 'verified') {
    logEmailUnavailable('Password reset');
    return res.status(503).json({ error: emailUnavailableMessage('Password reset email') });
  }
  const generic = { message: 'If an account exists for that email, a reset code has been sent.' };
  const user = await db.prepare('SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1').get(email);
  if (!user) return res.status(202).json(generic);
  const now = Date.now();
  const code = generateOtp();
  const otp = hashOtp(code);
  const canSend = await platform.transaction(async () => {
    const existing = await db.prepare('SELECT * FROM password_resets WHERE user_id = ? FOR UPDATE').get(user.id);
    if (existing && (existing.resend_after > now || existing.resend_count >= OTP_MAX_RESENDS)) return false;
    if (existing) {
      const changed = (await db.prepare(`UPDATE password_resets SET otp_salt = ?, otp_hash = ?, otp_expires_at = ?, otp_attempts = 0,
        resend_after = ?, resend_count = resend_count + 1, created_at = ?
        WHERE user_id = ? AND resend_after <= ? AND resend_count < ?`)
        .run(otp.salt, otp.hash, now + OTP_TTL_MS, now + OTP_RESEND_COOLDOWN_MS, now, user.id, now, OTP_MAX_RESENDS)).changes;
      return changed === 1;
    }
    const inserted = await db.prepare(`INSERT INTO password_resets (user_id, otp_salt, otp_hash, otp_expires_at, otp_attempts, resend_after, resend_count, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 0, ?) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`)
      .run(user.id, otp.salt, otp.hash, now + OTP_TTL_MS, now + OTP_RESEND_COOLDOWN_MS, now);
    return inserted.changes === 1;
  });
  if (!canSend) return res.status(202).json(generic);
  try {
    await emailSender(email, code, 'password-reset');
  } catch (error) {
    const diagnostic = classifyEmailError(error);
    console.error(`Password reset email delivery failed (pid=${process.pid}, category=${diagnostic.category}, code=${diagnostic.code}).`);
    await db.prepare('DELETE FROM password_resets WHERE user_id = ? AND otp_hash = ?').run(user.id, otp.hash);
    return res.status(502).json({ error: 'Reset email could not be delivered. Try again later.' });
  }
  res.status(202).json(generic);
});

app.post('/api/auth/password-reset/confirm', async (req, res) => {
  if (authRateLimited(req, 'password-reset-confirm', 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many reset attempts. Try again later.' });
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  const password = req.body?.password;
  if (!validatePassword(password)) return fieldError(res, 'password', 'Use at least 8 characters with uppercase, lowercase, number, and special character.');
  const user = await db.prepare('SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1').get(email);
  if (!user) return res.status(400).json({ error: 'The reset code is invalid or expired.' });
  const reset = await db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(user.id);
  if (!reset || reset.otp_expires_at <= Date.now()) return res.status(410).json({ error: 'The reset code is invalid or expired. Request a new one.' });
  if (reset.otp_attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many incorrect codes. Request a new reset code.' });
  if (!verifyOtp(code, reset.otp_salt, reset.otp_hash)) {
    const changed = (await db.prepare(`UPDATE password_resets SET otp_attempts = otp_attempts + 1 WHERE user_id = ? AND otp_attempts < ?`)
      .run(user.id, OTP_MAX_ATTEMPTS)).changes;
    return res.status(changed ? 401 : 429).json({ error: changed ? 'The reset code is incorrect.' : 'Too many incorrect codes. Request a new reset code.' });
  }
  await platform.transaction(async () => {
    const current = await db.prepare('SELECT * FROM password_resets WHERE user_id = ? FOR UPDATE').get(user.id);
    if (!current || current.otp_hash !== reset.otp_hash || current.otp_expires_at <= Date.now()) {
      throw Object.assign(new Error('The reset code is invalid or expired.'), { status: 410 });
    }
    await db.prepare('UPDATE users SET password_hash = ?, password = NULL WHERE id = ?').run(passwordHash(password), user.id);
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  res.json({ message: 'Password updated. Sign in with your new password.' });
});

app.post('/api/auth/login', async (req, res) => {
  const rawIdentity = String(req.body?.identity || req.body?.username || '').trim();
  const identity = rawIdentity.includes('@') ? normalizeEmail(rawIdentity) : normalizeUsername(rawIdentity);
  const password = req.body?.password;
  if (!identity || typeof password !== 'string' || password.length > 200) return res.status(400).json({ error: 'Username/email and password are required.' });
  const remoteAddress = clientAddress(req);
  const attempt = loginAttempts.get(remoteAddress);
  if (attempt && attempt.expiresAt > Date.now() && attempt.count >= 10) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  if (!attempt || attempt.expiresAt <= Date.now()) loginAttempts.set(remoteAddress, { count: 1, expiresAt: Date.now() + LOGIN_WINDOW_MS });
  else attempt.count += 1;
  const user = await db.prepare('SELECT * FROM users WHERE (lower(username) = ? OR lower(email) = ?) AND email_verified = 1').get(identity, identity);
  if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username/email or password.' });
  loginAttempts.delete(remoteAddress);
  await issueSession(user.id, res);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/plans', requireAuth, async (req, res) => {
  res.json({ plans: await db.prepare(`SELECT id, rate, minimum, maximum, duration_days, pool_target
    FROM investment_plans WHERE active = 1 ORDER BY rate`).all() });
});
app.post('/api/plans/:rate/estimate', requireAuth, async (req, res) => {
  const plan = await db.prepare('SELECT * FROM investment_plans WHERE rate = ? AND active = 1').get(req.params.rate);
  if (!plan) return res.status(404).json({ error: 'Investment tier not found.' });
  const amount = platform.amountValue(req.body?.amount);
  if (amount < plan.minimum || amount > plan.maximum) return res.status(400).json({ error: 'Amount is outside this tier’s allowed range.' });
  const roi = Math.round(amount * plan.rate / 100);
  res.json({ estimate: { contribution: amount, rate: plan.rate, duration_days: plan.duration_days, roi, maturity_amount: amount + roi } });
});

app.get('/api/wallet', requireAuth, async (req, res) => res.json({ wallet: await platform.getWallet(req.user.id), demo: true }));
app.post('/api/wallet/deposits', requireAuth, async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  const wallet = await platform.addSimulatedFunds(req.user.id, req.body?.amount, key);
  res.status(201).json({ wallet, demo: true });
});
app.get('/api/wallet/transactions', requireAuth, async (req, res) => res.json({ transactions: await platform.listTransactions(req.user.id) }));

app.get('/api/pools', requireAuth, async (req, res) => res.json({ pools: await platform.listPools(req.user.id) }));
app.get('/api/pools/:poolId', requireAuth, async (req, res) => res.json({ pool: await platform.getPool(req.user.id, req.params.poolId) }));
app.post('/api/pools/:poolId/join', requireAuth, async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  const pool = await db.prepare(`SELECT po.id, po.plan_id, po.status, po.total_amount, po.target_amount, po.expires_at,
    p.rate FROM pools po JOIN investment_plans p ON p.id = po.plan_id WHERE po.id = ?`).get(req.params.poolId);
  if (!pool) return res.status(404).json({ error: 'Pool not found.' });
  if (pool.status !== 'FORMING' || pool.total_amount >= pool.target_amount || pool.expires_at <= Date.now()) return res.status(409).json({ error: 'This pool is not accepting investments.' });
  const investment = await platform.createInvestment(req.user.id, pool.rate, req.body?.amount, pool.id, key);
  res.status(201).json({ investment });
});

app.post('/api/investments', requireAuth, async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  const investment = await platform.createInvestment(req.user.id, req.body?.plan_rate, req.body?.amount, req.body?.pool_id || null, key);
  res.status(201).json({ investment });
});
app.get('/api/investments', requireAuth, async (req, res) => res.json({ investments: await platform.listInvestments(req.user.id) }));
app.get('/api/investments/:investmentId', requireAuth, async (req, res) => res.json({ investment: await platform.getInvestmentDetails(req.user.id, req.params.investmentId) }));
app.post('/api/investments/:investmentId/contributions', requireAuth, async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  res.json({ investment: await platform.addContribution(req.user.id, req.params.investmentId, req.body?.amount, key) });
});
app.post('/api/investments/:investmentId/cancel', requireAuth, async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  res.json({ investment: await platform.cancelInvestment(req.user.id, req.params.investmentId, key) });
});

app.get('/api/notifications', requireAuth, async (req, res) => res.json({ notifications: await platform.listNotifications(req.user.id) }));
app.post('/api/notifications/:notificationId/read', requireAuth, async (req, res) => res.json({ notification: await platform.markNotificationRead(req.user.id, req.params.notificationId) }));

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => res.json({ stats: await platform.adminOverview() }));
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => res.json({ users: await db.prepare(`SELECT id, name, email, username, role, created_at FROM users ORDER BY id DESC`).all() }));
app.get('/api/admin/plans', requireAuth, requireAdmin, async (req, res) => res.json({ plans: await db.prepare('SELECT * FROM investment_plans ORDER BY rate').all() }));
app.patch('/api/admin/plans/:planId', requireAuth, requireAdmin, async (req, res) => {
  const target = req.body?.pool_target === undefined ? undefined : Number(req.body.pool_target);
  const active = req.body?.active;
  if ((target === undefined && active === undefined) || (target !== undefined && (!Number.isSafeInteger(target) || target <= 0)) || (active !== undefined && typeof active !== 'boolean')) return res.status(400).json({ error: 'Provide a positive integer pool_target and/or boolean active.' });
  const existing = await db.prepare('SELECT * FROM investment_plans WHERE id = ?').get(req.params.planId);
  if (!existing) return res.status(404).json({ error: 'Plan not found.' });
  await db.prepare('UPDATE investment_plans SET pool_target = ?, active = ? WHERE id = ?')
    .run(target === undefined ? existing.pool_target : target, active === undefined ? existing.active : Number(active), existing.id);
  res.json({ plan: await db.prepare('SELECT * FROM investment_plans WHERE id = ?').get(existing.id) });
});
app.get('/api/admin/pools', requireAuth, requireAdmin, async (req, res) => res.json({ pools: await db.prepare(`SELECT po.*, p.rate FROM pools po JOIN investment_plans p ON p.id = po.plan_id ORDER BY po.created_at DESC`).all() }));
app.get('/api/admin/investments', requireAuth, requireAdmin, async (req, res) => res.json({ investments: await db.prepare(`SELECT i.*, u.email, p.rate FROM investments i JOIN users u ON u.id = i.user_id JOIN investment_plans p ON p.id = i.plan_id ORDER BY i.created_at DESC`).all() }));
app.get('/api/admin/transactions', requireAuth, requireAdmin, async (req, res) => res.json({ transactions: await db.prepare(`SELECT t.*, u.email FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 500`).all() }));

const pages = new Set(['landing.html', 'index.html', 'register.html', 'verify.html', 'reset-password.html', 'home.html', 'plans.html', 'dashboard.html', 'admin.html']);
const assets = new Set(['app-theme.css', 'client.js', 'signIn.css', 'signIn.js', 'register.css', 'register.js', 'verify.js', 'reset-password.js', 'home.css', 'home.js', 'landing.css', 'plans.css', 'plans.js', 'dashboard.css', 'dashboard.js', 'admin.css', 'admin.js', 'enormino.jpeg']);
app.get('/healthz', async (req, res) => {
  await db.prepare('SELECT 1').get();
  res.json({ status: 'ok' });
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/admin.html', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/:page', (req, res, next) => {
  if (!pages.has(req.params.page) || !fs.existsSync(path.join(__dirname, req.params.page))) return next();
  res.sendFile(path.join(__dirname, req.params.page));
});
app.get('/:asset', (req, res, next) => {
  if (!assets.has(req.params.asset)) return next();
  res.sendFile(path.join(__dirname, req.params.asset));
});

async function runScheduledProcessing() {
  await ready;
  const result = await platform.processDueEvents();
  const timestamp = Date.now();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp);
  await db.prepare('DELETE FROM pending_registrations WHERE otp_expires_at <= ?').run(timestamp);
  purgeExpiredRateLimits(timestamp);
  return result;
}

app.get('/api/cron/process', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authorization = req.get('authorization') || '';
  const expected = secret ? Buffer.from(`Bearer ${secret}`) : Buffer.alloc(0);
  const received = Buffer.from(authorization);
  if (!secret) return res.status(503).json({ error: 'Scheduled processing is not configured.' });
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  res.json(await runScheduledProcessing());
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'An internal error occurred.' : error.message });
});

if (require.main === module) {
  const application = createApplication();
  const { app, db, runScheduledProcessing } = application;
  application.ready.then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Enormico server running at http://localhost:${PORT} (pid=${process.pid})`);
      const emailState = application.getEmailStatus();
      if (emailState.state === 'unconfigured') {
        console.warn(`SMTP email delivery unavailable (pid=${process.pid}, missing=${missingEmailSettings().join(',') || 'unknown'}).`);
      } else if (emailState.state === 'verified') {
        console.log(`SMTP connection and authentication verified (pid=${process.pid}).`);
      } else {
        console.warn(`SMTP email delivery unavailable (pid=${process.pid}, state=${emailState.state}).`);
      }
    });
    const processor = setInterval(() => {
      runScheduledProcessing().catch(error => console.error('Scheduled investment processing failed:', error));
    }, 60 * 1000);
    processor.unref();
    runScheduledProcessing().catch(error => console.error('Scheduled investment processing failed:', error));
    const shutdown = signal => {
      console.log(`${signal} received; closing Enormico server (pid=${process.pid}).`);
      clearInterval(processor);
      server.close(error => {
        if (error) {
          console.error('Server shutdown failed:', error);
          process.exitCode = 1;
        }
        db.close().catch(closeError => {
          console.error('Database shutdown failed:', closeError);
          process.exitCode = 1;
        });
      });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }).catch(error => {
    console.error('Database initialization failed:', error);
    db.close().catch(closeError => console.error('Database shutdown failed:', closeError));
    process.exitCode = 1;
  });
}

return {
  app, db, platform, ready, passwordHash, passwordMatches, runScheduledProcessing,
  verifyEmailTransport,
  setEmailSender(sender) {
    emailSender = sender;
    emailStatus = sender ? { state: 'verified' } : { state: 'unconfigured', missing: missingEmailSettings() };
  },
  getEmailStatus() { return { ...emailStatus, pid: process.pid }; },
  authRateLimits,
  resetRateLimits() { authRateLimits.clear(); loginAttempts.clear(); }
};
}

module.exports = { createApplication };