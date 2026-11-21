const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDatabase } = require('../database');
const {
  ageOnDateOfBirth, normalizeEmail, normalizeUsername, validatePassword,
  generateOtp, hashOtp, verifyOtp, validateRegistration
} = require('../auth-utils');
const { emailConfiguration } = require('../email-service');

test('password policy requires length, uppercase, lowercase, number, and special character', () => {
  for (const password of [
    'lowercase1!', 'UPPERCASE1!', 'NoNumber!!', 'NoSpecial1', 'Aa1!', 'A'.repeat(201)
  ]) assert.equal(validatePassword(password), false, password);
  assert.equal(validatePassword('Valid-pass1!'), true);
});

test('email and username normalization is consistent', () => {
  assert.equal(normalizeEmail('  USER.Name@Example.COM '), 'user.name@example.com');
  assert.equal(normalizeUsername('  Mixed.Name_1 '), 'mixed.name_1');
});

test('date of birth handles exactly 18, birthdays still to come, invalid days, and future dates', () => {
  const today = new Date(Date.UTC(2026, 9, 14, 12));
  assert.deepEqual(ageOnDateOfBirth('2008-10-14', today), { valid: true, age: 18, future: false });
  assert.deepEqual(ageOnDateOfBirth('2008-10-15', today), { valid: true, age: 17, future: false });
  assert.deepEqual(ageOnDateOfBirth('2008-12-01', today), { valid: true, age: 17, future: false });
  assert.deepEqual(ageOnDateOfBirth('2008-02-31', today), { valid: false, age: null, future: false });
  assert.deepEqual(ageOnDateOfBirth('2026-10-15', today), { valid: true, age: null, future: true });
  assert.deepEqual(ageOnDateOfBirth('not-a-date', today), { valid: false, age: null, future: false });
});

test('registration validation returns field errors and rejects incomplete direct payloads', () => {
  const result = validateRegistration({
    name: 'X', email: 'not-an-email', username: 'Bad Name', password: 'weak', dob: '2008-10-15'
  }, new Date(Date.UTC(2026, 9, 14)));
  assert.ok(result.errors.name);
  assert.ok(result.errors.email);
  assert.ok(result.errors.username);
  assert.ok(result.errors.password);
  assert.ok(result.errors.dob);
});

test('OTP generation is six digits and stored verifier never contains the plaintext code', () => {
  const code = generateOtp();
  assert.match(code, /^\d{6}$/);
  const hashed = hashOtp(code);
  assert.notEqual(hashed.hash, code);
  assert.equal(verifyOtp(code, hashed.salt, hashed.hash), true);
  assert.equal(verifyOtp(code === '000000' ? '000001' : '000000', hashed.salt, hashed.hash), false);
  assert.equal(verifyOtp('bad', hashed.salt, hashed.hash), false);
});

test('email transport configuration fails closed when credentials are missing', () => {
  assert.equal(emailConfiguration({}), null);
  assert.equal(emailConfiguration({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'user', SMTP_PASSWORD: 'secret' }), null);
  assert.deepEqual(emailConfiguration({
    SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'user', SMTP_PASSWORD: 'secret', EMAIL_FROM: 'Enormico <no-reply@example.com>'
  }), {
    host: 'smtp.example.com', port: 465, secure: true,
    auth: { user: 'user', pass: 'secret' }, from: 'Enormico <no-reply@example.com>'
  });
});

test('SQLite normalized unique indexes reject case-variant identities', t => {
  const db = createDatabase(':memory:');
  t.after(() => db.close());
  db.prepare(`INSERT INTO users (name, email, username, password_hash, created_at)
    VALUES ('First', 'first@example.com', 'normalized-user', 'hash', ?)`)
    .run(Date.now());
  assert.throws(() => db.prepare(`INSERT INTO users (name, email, username, password_hash, created_at)
    VALUES ('Second', 'FIRST@example.com', 'another-user', 'hash', ?)`)
    .run(Date.now()), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO users (name, email, username, password_hash, created_at)
    VALUES ('Third', 'third@example.com', 'NORMALIZED-USER', 'hash', ?)`)
    .run(Date.now()), /UNIQUE constraint failed/);
});

test('SQLite schema upgrade preserves existing users and adds verified identity columns', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'enormico-legacy-'));
  const filePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE,
    username TEXT UNIQUE, password TEXT, phone TEXT, dob TEXT
  )`);
  legacy.prepare(`INSERT INTO users (name, email, username, password, phone, dob)
    VALUES ('Existing User', 'Legacy@Example.com', 'LegacyUser', 'legacy-plain-text', '555', '1990-01-01')`).run();
  legacy.close();
  const upgraded = createDatabase(filePath);
  t.after(() => {
    upgraded.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const user = upgraded.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(user.email, 'Legacy@Example.com');
  assert.equal(user.username, 'LegacyUser');
  assert.equal(user.email_verified, 1);
  assert.equal(user.password_hash, null);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});
