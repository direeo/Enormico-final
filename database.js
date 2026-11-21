const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const PLAN_SEEDS = [
  { rate: 10, minimum: 50000, maximum: 500000, durationDays: 30 },
  { rate: 12, minimum: 500001, maximum: 2000000, durationDays: 60 },
  { rate: 14, minimum: 2000001, maximum: 5000000, durationDays: 90 },
  { rate: 16, minimum: 5000001, maximum: 10000000, durationDays: 120 },
  { rate: 18, minimum: 10000001, maximum: 100000000, durationDays: 180 }
];

function createDatabase(filePath = path.join(__dirname, 'users.db')) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username TEXT UNIQUE COLLATE NOCASE,
      password TEXT,
      password_hash TEXT,
      phone TEXT,
      dob TEXT,
      email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified IN (0, 1)),
      role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      phone TEXT,
      dob TEXT NOT NULL,
      otp_salt TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      otp_expires_at INTEGER NOT NULL,
      otp_attempts INTEGER NOT NULL DEFAULT 0,
      resend_after INTEGER NOT NULL,
      resend_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_registrations_expiry ON pending_registrations(otp_expires_at);
    CREATE TABLE IF NOT EXISTS password_resets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      otp_salt TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      otp_expires_at INTEGER NOT NULL,
      otp_attempts INTEGER NOT NULL DEFAULT 0,
      resend_after INTEGER NOT NULL,
      resend_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investment_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate INTEGER NOT NULL UNIQUE,
      minimum INTEGER NOT NULL,
      maximum INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      pool_target INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available_balance INTEGER NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
      pending_balance INTEGER NOT NULL DEFAULT 0 CHECK (pending_balance >= 0),
      invested_balance INTEGER NOT NULL DEFAULT 0 CHECK (invested_balance >= 0),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES investment_plans(id),
      target_amount INTEGER NOT NULL,
      total_amount INTEGER NOT NULL DEFAULT 0,
      investor_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'FORMING' CHECK (status IN ('FORMING', 'ACTIVE', 'MATURED', 'EXPIRED')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      activated_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pools_plan_status ON pools(plan_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_pools_expiry ON pools(status, expires_at);
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      pool_id INTEGER NOT NULL REFERENCES pools(id),
      plan_id INTEGER NOT NULL REFERENCES investment_plans(id),
      contribution INTEGER NOT NULL CHECK (contribution > 0),
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'MATURED', 'CANCELLED', 'REFUNDED')),
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      maturity_at INTEGER,
      roi_amount INTEGER,
      maturity_amount INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_investments_user ON investments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_investments_pool_status ON investments(pool_id, status);
    CREATE INDEX IF NOT EXISTS idx_investments_maturity ON investments(status, maturity_at);
    CREATE TABLE IF NOT EXISTS investment_contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL CHECK (amount > 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contributions_investment ON investment_contributions(investment_id);
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      investment_id INTEGER REFERENCES investments(id),
      pool_id INTEGER REFERENCES pools(id),
      type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      description TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      related_investment_id INTEGER REFERENCES investments(id),
      related_pool_id INTEGER REFERENCES pools(id),
      read_at INTEGER,
      event_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at DESC);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  migrateLegacyUsers(db);
  seedPlans(db);
  return db;
}

function migrateLegacyUsers(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!columns.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!columns.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER'");
  if (!columns.has('created_at')) db.exec('ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  if (!columns.has('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if (!columns.has('dob')) db.exec('ALTER TABLE users ADD COLUMN dob TEXT');
  if (!columns.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');

  const notificationColumns = new Set(db.prepare('PRAGMA table_info(notifications)').all().map(column => column.name));
  if (!notificationColumns.has('event_key')) db.exec('ALTER TABLE notifications ADD COLUMN event_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_key ON notifications(event_key) WHERE event_key IS NOT NULL');

  const duplicateEmail = db.prepare('SELECT lower(email) AS normalized FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 LIMIT 1').get();
  const duplicateUsername = db.prepare(`SELECT lower(username) AS normalized FROM users WHERE username IS NOT NULL
    GROUP BY lower(username) HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicateEmail || duplicateUsername) {
    throw new Error('Existing accounts contain case-insensitive duplicate identities. Resolve those records before applying normalized uniqueness indexes.');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(lower(email));');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized ON users(lower(username)) WHERE username IS NOT NULL;');

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
}

function seedPlans(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO investment_plans (rate, minimum, maximum, duration_days, pool_target)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const plan of PLAN_SEEDS) {
    insert.run(plan.rate, plan.minimum, plan.maximum, plan.durationDays, plan.maximum);
  }
}

module.exports = { createDatabase, PLAN_SEEDS };