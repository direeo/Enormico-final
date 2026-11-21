const crypto = require('node:crypto');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_RESENDS = 5;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return false;
  return /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

function parseDateOfBirth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function ageOnDateOfBirth(value, now = new Date()) {
  const birth = parseDateOfBirth(value);
  if (!birth) return { valid: false, age: null, future: false };
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  const future = birth.year > year || (birth.year === year && (birth.month > month || (birth.month === month && birth.day > day)));
  if (future) return { valid: true, age: null, future: true };
  let age = year - birth.year;
  if (month < birth.month || (month === birth.month && day < birth.day)) age -= 1;
  return { valid: true, age, future: false };
}

function generateOtp() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashOtp(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(code, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyOtp(code, salt, expectedHex) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(code, salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateRegistration(body, now = new Date()) {
  const errors = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = normalizeEmail(body.email);
  const username = normalizeUsername(body.username);

  if (name.length < 2 || name.length > 100) errors.name = 'Enter a name between 2 and 100 characters.';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) errors.username = 'Use 3–30 letters, numbers, dots, underscores, or hyphens.';
  if (!validatePassword(body.password)) errors.password = 'Use at least 8 characters with uppercase, lowercase, number, and special character.';
  const age = ageOnDateOfBirth(body.dob, now);
  if (!body.dob || !age.valid) errors.dob = 'Enter a valid date of birth.';
  else if (age.future) errors.dob = 'Date of birth cannot be in the future.';
  else if (age.age < 18) errors.dob = 'You must be at least 18 years old to register.';

  return {
    errors,
    value: {
      name,
      email,
      username,
      password: body.password,
      phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '',
      dob: body.dob
    }
  };
}

module.exports = {
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_RESENDS,
  normalizeEmail,
  normalizeUsername,
  validatePassword,
  parseDateOfBirth,
  ageOnDateOfBirth,
  generateOtp,
  hashOtp,
  verifyOtp,
  validateRegistration
};