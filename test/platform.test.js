const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform, DAY_MS } = require('../platform');
const { createTestDatabase } = require('./helpers/postgres-database');

async function fixture(t) {
  let now = Date.UTC(2026, 9, 8, 12);
  const db = await createTestDatabase();
  const platform = createPlatform(db, () => now);
  t.after(() => db.close());

  async function user(email, balance = 200000000) {
    const result = await db.prepare(`INSERT INTO users (name, email, username, password_hash, role, created_at)
      VALUES (?, ?, ?, 'test-hash', 'USER', ?) RETURNING id`)
      .run(email, email, email.split('@')[0], now);
    const id = Number(result.lastInsertRowid);
    await db.prepare(`INSERT INTO wallets (user_id, available_balance, updated_at) VALUES (?, ?, ?)`)
      .run(id, balance, now);
    return id;
  }

  return { db, platform, user, get now() { return now; }, advance(ms) { now += ms; } };
}

test('database seeding preserves the five investment tiers and their ranges', async t => {
  const f = await fixture(t);
  const plans = await f.db.prepare('SELECT rate, minimum, maximum, duration_days FROM investment_plans ORDER BY rate').all();
  assert.deepEqual(plans.map(row => Object.values(row)), [
    [10, 50000, 500000, 30], [12, 500001, 2000000, 60], [14, 2000001, 5000000, 90],
    [16, 5000001, 10000000, 120], [18, 10000001, 100000000, 180]
  ]);
  const userId = await f.user('tiers@example.com');
  await assert.rejects(f.platform.createInvestment(userId, 10, 49999), error => error.status === 400);
});

test('pending contributions and cancellations update balances and ledger exactly once', async t => {
  const f = await fixture(t);
  const userId = await f.user('cancel@example.com', 100000);
  const investment = await f.platform.createInvestment(userId, 10, 50000);
  const updated = await f.platform.addContribution(userId, investment.id, 20000, 'contribution-retry-key');
  const replay = await f.platform.addContribution(userId, investment.id, 20000, 'contribution-retry-key');
  assert.equal(updated.contribution, 70000);
  assert.equal(replay.contribution, 70000);
  await f.platform.cancelInvestment(userId, investment.id, 'cancel-retry-key');
  await f.platform.cancelInvestment(userId, investment.id, 'cancel-retry-key');
  const wallet = await f.platform.getWallet(userId);
  assert.equal(wallet.available_balance, 100000);
  assert.equal(wallet.pending_balance, 0);
  assert.equal((await f.platform.listTransactions(userId)).filter(row => row.type === 'ADDITIONAL_CONTRIBUTION').length, 1);
  assert.equal((await f.platform.listTransactions(userId)).filter(row => row.type === 'CANCELLATION_REFUND').length, 1);
  assert.equal((await f.platform.getInvestmentDetails(userId, investment.id)).status, 'CANCELLED');
});

test('pool activation moves pending balances and starts each investment maturity clock', async t => {
  const f = await fixture(t);
  const alice = await f.user('activation-a@example.com');
  const bob = await f.user('activation-b@example.com');
  const first = await f.platform.createInvestment(alice, 10, 450000);
  f.advance(5 * DAY_MS);
  const second = await f.platform.createInvestment(bob, 10, 100000, first.pool_id);
  assert.equal(second.total_amount, 550000);
  assert.equal(second.status, 'ACTIVE');
  assert.equal(second.activated_at, f.now);
  assert.equal((await f.platform.getWallet(bob)).invested_balance, 100000);
  assert.equal((await f.platform.getWallet(bob)).pending_balance, 0);

  f.advance(30 * DAY_MS);
  await f.platform.processDueEvents();
  const matured = await f.platform.getInvestmentDetails(alice, first.id);
  assert.equal(matured.status, 'MATURED');
  assert.equal(matured.roi_amount, 45000);
  assert.equal((await f.platform.getWallet(alice)).available_balance, 200045000);
  await f.platform.processDueEvents();
  assert.equal((await f.platform.listTransactions(alice)).filter(row => row.type === 'MATURITY_CREDIT').length, 1);
});

test('pool expiry refunds each pending investment once', async t => {
  const f = await fixture(t);
  const alice = await f.user('expiry-a@example.com', 100000);
  const bob = await f.user('expiry-b@example.com', 100000);
  const first = await f.platform.createInvestment(alice, 10, 50000);
  await f.platform.createInvestment(bob, 10, 50000, first.pool_id);
  f.advance(14 * DAY_MS);
  await f.platform.processDueEvents();
  await f.platform.processDueEvents();
  assert.equal((await f.db.prepare('SELECT status FROM pools WHERE id = ?').get(first.pool_id)).status, 'EXPIRED');
  assert.equal((await f.platform.getInvestmentDetails(alice, first.id)).status, 'REFUNDED');
  assert.equal((await f.platform.getWallet(alice)).available_balance, 100000);
  assert.equal((await f.platform.listTransactions(alice)).filter(row => row.type === 'POOL_EXPIRY_REFUND').length, 1);
});

test('ownership checks hide another user investment and wallet data', async t => {
  const f = await fixture(t);
  const alice = await f.user('owner-a@example.com');
  const bob = await f.user('owner-b@example.com');
  const investment = await f.platform.createInvestment(alice, 10, 50000);
  await assert.rejects(f.platform.getInvestmentDetails(bob, investment.id), error => error.status === 404);
  assert.deepEqual(await f.platform.listTransactions(bob), []);
  assert.notEqual((await f.platform.getWallet(alice)).user_id, (await f.platform.getWallet(bob)).user_id);
});

test('simulated deposits are idempotent and insufficient funds do not mutate balances', async t => {
  const f = await fixture(t);
  const userId = await f.user('deposit@example.com', 0);
  await f.platform.addSimulatedFunds(userId, 250000, 'deposit-retry-key');
  await f.platform.addSimulatedFunds(userId, 250000, 'deposit-retry-key');
  assert.equal((await f.platform.getWallet(userId)).available_balance, 250000);
  assert.equal((await f.platform.listTransactions(userId)).length, 1);
  await assert.rejects(f.platform.createInvestment(userId, 10, 300000), error => error.status === 409);
  assert.equal((await f.platform.getWallet(userId)).available_balance, 250000);
});
