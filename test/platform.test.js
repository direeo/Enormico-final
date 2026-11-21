const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../database');
const { createPlatform, DAY_MS } = require('../platform');

function fixture(t) {
  let now = Date.UTC(2026, 9, 8, 12);
  const db = createDatabase(':memory:');
  const platform = createPlatform(db, () => now);
  t.after(() => db.close());
  function user(email, balance = 200000000) {
    const result = db.prepare(`INSERT INTO users (name, email, username, password_hash, role, created_at)
      VALUES (?, ?, ?, 'test-hash', 'USER', ?)`)
      .run(email, email, email.split('@')[0], now);
    const id = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO wallets (user_id, available_balance, updated_at) VALUES (?, ?, ?)`)
      .run(id, balance, now);
    return id;
  }
  return { db, platform, user, get now() { return now; }, advance(ms) { now += ms; } };
}

test('all existing tiers accept their minimum and maximum and reject out-of-range amounts', t => {
  const f = fixture(t);
  const userId = f.user('tier-tests@example.com');
  for (const plan of f.db.prepare('SELECT * FROM investment_plans ORDER BY rate').all()) {
    assert.doesNotThrow(() => f.platform.createInvestment(userId, plan.rate, plan.minimum));
    assert.throws(() => f.platform.createInvestment(userId, plan.rate, plan.minimum - 1), error => error.status === 400);
    assert.throws(() => f.platform.createInvestment(userId, plan.rate, plan.maximum + 1), error => error.status === 400);
  }
});

test('the five seeded tiers preserve their configured rates, durations, and highest-tier cap', t => {
  const f = fixture(t);
  assert.deepEqual(f.db.prepare('SELECT rate, minimum, maximum, duration_days FROM investment_plans ORDER BY rate').all().map(row => Object.values(row)), [
    [10, 50000, 500000, 30], [12, 500001, 2000000, 60], [14, 2000001, 5000000, 90],
    [16, 5000001, 10000000, 120], [18, 10000001, 100000000, 180]
  ]);
});

test('a user can hold multiple investments in one tier and across tiers', t => {
  const f = fixture(t);
  const userId = f.user('multi@example.com');
  const investments = [
    f.platform.createInvestment(userId, 10, 50000),
    f.platform.createInvestment(userId, 10, 60000),
    f.platform.createInvestment(userId, 12, 600000)
  ];
  assert.equal(f.platform.listInvestments(userId).length, 3);
  assert.equal(new Set(investments.map(item => item.plan_id)).size, 2);
});

test('pending additional contribution updates the investment and records a debit', t => {
  const f = fixture(t);
  const userId = f.user('add@example.com');
  const investment = f.platform.createInvestment(userId, 10, 50000);
  const updated = f.platform.addContribution(userId, investment.id, 20000);
  assert.equal(updated.contribution, 70000);
  assert.equal(f.platform.getWallet(userId).pending_balance, 70000);
  assert.equal(f.platform.listTransactions(userId).filter(tx => tx.type === 'ADDITIONAL_CONTRIBUTION')[0].amount, 20000);
});

test('pending additions cannot exceed the selected tier maximum', t => {
  const f = fixture(t);
  const userId = f.user('cap@example.com');
  const investment = f.platform.createInvestment(userId, 10, 450000);
  assert.throws(() => f.platform.addContribution(userId, investment.id, 50001), error => error.status === 400);
});

test('cancelling a pending investment refunds the available wallet and creates ledger and notice records', t => {
  const f = fixture(t);
  const userId = f.user('cancel@example.com', 100000);
  const investment = f.platform.createInvestment(userId, 10, 50000);
  f.platform.cancelInvestment(userId, investment.id);
  assert.equal(f.platform.getInvestmentDetails(userId, investment.id).status, 'CANCELLED');
  assert.equal(f.platform.getWallet(userId).available_balance, 100000);
  assert.equal(f.platform.getWallet(userId).pending_balance, 0);
  assert.equal(f.platform.listTransactions(userId).filter(tx => tx.type === 'CANCELLATION_REFUND').length, 1);
  assert.ok(f.platform.listNotifications(userId).some(item => item.type === 'INVESTMENT_CANCELLED'));
});

test('a pool activates exactly at target and retains the full over-target contribution', t => {
  const f = fixture(t);
  const alice = f.user('alice-activation@example.com');
  const bob = f.user('bob-activation@example.com');
  const first = f.platform.createInvestment(alice, 10, 450000);
  const second = f.platform.createInvestment(bob, 10, 100000, first.pool_id);
  assert.equal(second.total_amount, 550000);
  assert.equal(second.status, 'ACTIVE');
  assert.equal(second.pool_status, 'ACTIVE');
  assert.equal(second.activated_at, f.now);
  assert.equal(f.platform.getWallet(bob).invested_balance, 100000);
  assert.equal(f.platform.getWallet(bob).pending_balance, 0);
});

test('an investment joining an activated pool is rejected', t => {
  const f = fixture(t);
  const alice = f.user('full-a@example.com');
  const bob = f.user('full-b@example.com');
  const poolInvestment = f.platform.createInvestment(alice, 10, 500000);
  assert.equal(poolInvestment.pool_status, 'ACTIVE');
  assert.throws(() => f.platform.createInvestment(bob, 10, 50000, poolInvestment.pool_id), error => error.status === 409);
});

test('active investments cannot be increased or cancelled', t => {
  const f = fixture(t);
  const alice = f.user('active-a@example.com');
  const bob = f.user('active-b@example.com');
  const investment = f.platform.createInvestment(alice, 10, 300000);
  f.platform.createInvestment(bob, 10, 200000, investment.pool_id);
  assert.throws(() => f.platform.addContribution(alice, investment.id, 10000), error => error.status === 409);
  assert.throws(() => f.platform.cancelInvestment(alice, investment.id), error => error.status === 409);
});

test('maturity starts at pool activation and individual ROI ignores the pool total', t => {
  const f = fixture(t);
  const alice = f.user('maturity-a@example.com', 1000000);
  const bob = f.user('maturity-b@example.com', 1000000);
  const investment = f.platform.createInvestment(alice, 10, 300000);
  f.advance(5 * DAY_MS);
  const activated = f.platform.createInvestment(bob, 10, 250000, investment.pool_id);
  assert.equal(activated.total_amount, 550000);
  assert.equal(f.platform.getInvestmentDetails(alice, investment.id).maturity_at, f.now + 30 * DAY_MS);
  f.advance(30 * DAY_MS - 1);
  f.platform.processDueEvents();
  assert.equal(f.platform.getInvestmentDetails(alice, investment.id).status, 'ACTIVE');
  f.advance(1);
  f.platform.processDueEvents();
  f.platform.processDueEvents();
  const matured = f.platform.getInvestmentDetails(alice, investment.id);
  assert.equal(matured.status, 'MATURED');
  assert.equal(matured.roi_amount, 30000);
  assert.equal(matured.maturity_amount, 330000);
  assert.equal(f.platform.getWallet(alice).available_balance, 1030000);
  assert.equal(f.platform.getWallet(alice).invested_balance, 0);
  assert.equal(f.platform.listTransactions(alice).filter(tx => tx.type === 'MATURITY_CREDIT').length, 1);
});

test('a forming pool expires after 14 days and refunds every pending investment once', t => {
  const f = fixture(t);
  const alice = f.user('expiry-a@example.com', 100000);
  const bob = f.user('expiry-b@example.com', 100000);
  const first = f.platform.createInvestment(alice, 10, 50000);
  f.platform.createInvestment(bob, 10, 50000, first.pool_id);
  f.advance(14 * DAY_MS);
  f.platform.processDueEvents();
  f.platform.processDueEvents();
  assert.equal(f.db.prepare('SELECT status FROM pools WHERE id = ?').get(first.pool_id).status, 'EXPIRED');
  assert.equal(f.platform.getInvestmentDetails(alice, first.id).status, 'REFUNDED');
  assert.equal(f.platform.getWallet(alice).available_balance, 100000);
  assert.equal(f.platform.getWallet(bob).pending_balance, 0);
  assert.equal(f.platform.listTransactions(alice).filter(tx => tx.type === 'POOL_EXPIRY_REFUND').length, 1);
  assert.ok(f.platform.listNotifications(alice).some(item => item.type === 'POOL_EXPIRED_REFUND'));
});

test('ownership checks hide another user’s investments, notifications, wallet, and ledger data', t => {
  const f = fixture(t);
  const alice = f.user('owner-a@example.com');
  const bob = f.user('owner-b@example.com');
  const investment = f.platform.createInvestment(alice, 10, 50000);
  assert.throws(() => f.platform.getInvestmentDetails(bob, investment.id), error => error.status === 404);
  assert.deepEqual(f.platform.listTransactions(bob), []);
  assert.deepEqual(f.platform.listNotifications(bob), []);
  assert.notEqual(f.platform.getWallet(alice).user_id, f.platform.getWallet(bob).user_id);
});

test('pool listing exposes aggregates and only the requesting user’s contribution', t => {
  const f = fixture(t);
  const alice = f.user('privacy-a@example.com');
  const bob = f.user('privacy-b@example.com');
  const first = f.platform.createInvestment(alice, 10, 100000);
  f.platform.createInvestment(bob, 10, 100000, first.pool_id);
  const asAlice = f.platform.getPool(alice, first.pool_id);
  const asBob = f.platform.getPool(bob, first.pool_id);
  assert.equal(asAlice.total_amount, 200000);
  assert.equal(asAlice.investor_count, 2);
  assert.equal(asAlice.my_contribution, 100000);
  assert.equal(asBob.my_contribution, 100000);
  assert.equal('members' in asAlice, false);
});

test('simulated deposits are credited and recorded in the transaction ledger', t => {
  const f = fixture(t);
  const userId = f.user('deposit@example.com', 0);
  f.platform.addSimulatedFunds(userId, 250000);
  assert.equal(f.platform.getWallet(userId).available_balance, 250000);
  assert.equal(f.platform.listTransactions(userId)[0].type, 'SIMULATED_DEPOSIT');
});

test('insufficient available wallet funds prevent investments without changing ledger or balances', t => {
  const f = fixture(t);
  const userId = f.user('insufficient@example.com', 49999);
  assert.throws(() => f.platform.createInvestment(userId, 10, 50000), error => error.status === 409);
  assert.equal(f.platform.getWallet(userId).available_balance, 49999);
  assert.deepEqual(f.platform.listTransactions(userId), []);
});