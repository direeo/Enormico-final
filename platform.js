const DAY_MS = 24 * 60 * 60 * 1000;

function createPlatform(db, now = () => Date.now()) {
  function transaction(work) {
    return db.transaction(work);
  }

  function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  function amountValue(value, label = 'Amount') {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0) fail(400, `${label} must be a positive whole number of naira.`);
    return amount;
  }

  async function walletFor(userId, lock = false) {
    const wallet = await db.prepare(`SELECT * FROM wallets WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`).get(userId);
    if (!wallet) fail(404, 'Wallet not found.');
    return wallet;
  }

  async function updateWallet(userId, { available = 0, pending = 0, invested = 0 }) {
    const wallet = await walletFor(userId, true);
    const next = {
      available_balance: wallet.available_balance + available,
      pending_balance: wallet.pending_balance + pending,
      invested_balance: wallet.invested_balance + invested
    };
    if (Object.values(next).some(balance => balance < 0 || !Number.isSafeInteger(balance))) {
      fail(409, 'Insufficient funds or invalid balance transition.');
    }
    await db.prepare(`UPDATE wallets SET available_balance = ?, pending_balance = ?, invested_balance = ?, updated_at = ?
      WHERE user_id = ?`).run(next.available_balance, next.pending_balance, next.invested_balance, now(), userId);
    return next;
  }

  async function recordTransaction({ userId, investmentId = null, poolId = null, type, direction, amount, description, idempotencyKey = null }) {
    const scopedKey = idempotencyKey ? `${userId}:${idempotencyKey}` : null;
    const result = await db.prepare(`INSERT INTO transactions
      (user_id, investment_id, pool_id, type, direction, amount, status, description, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?) RETURNING id`)
      .run(userId, investmentId, poolId, type, direction, amount, description, scopedKey, now());
    return Number(result.lastInsertRowid);
  }

  async function replayTransaction(userId, idempotencyKey, expectedType, amount = null, context = {}) {
    if (!idempotencyKey) return null;
    const existing = await db.prepare(`SELECT t.*, i.plan_id AS investment_plan_id FROM transactions t
      LEFT JOIN investments i ON i.id = t.investment_id
      WHERE t.user_id = ? AND t.idempotency_key = ?`)
      .get(userId, `${userId}:${idempotencyKey}`);
    if (!existing) return null;
    if (existing.type !== expectedType || (amount !== null && existing.amount !== amount) ||
      (context.investmentId !== undefined && existing.investment_id !== context.investmentId) ||
      (context.planId !== undefined && existing.investment_plan_id !== context.planId)) {
      fail(409, 'This request key was already used for a different financial operation.');
    }
    return existing;
  }

  async function notify(userId, type, message, { investmentId = null, poolId = null, eventKey = null } = {}) {
    const result = await db.prepare(`INSERT INTO notifications
      (user_id, type, message, related_investment_id, related_pool_id, event_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING RETURNING id`)
      .run(userId, type, message, investmentId, poolId, eventKey, now());
    return Number(result.lastInsertRowid || 0);
  }

  async function ensureFormingPool(plan) {
    await db.prepare('SELECT pg_advisory_xact_lock(?)').get(plan.id);
    let pool = await db.prepare(`SELECT * FROM pools WHERE plan_id = ? AND status = 'FORMING'
      AND total_amount < target_amount AND expires_at > ? ORDER BY created_at LIMIT 1 FOR UPDATE`).get(plan.id, now());
    if (!pool) {
      const createdAt = now();
      const result = await db.prepare(`INSERT INTO pools
        (plan_id, target_amount, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'FORMING') RETURNING id`)
        .run(plan.id, plan.pool_target, createdAt, createdAt + 14 * DAY_MS);
      pool = await db.prepare('SELECT * FROM pools WHERE id = ?').get(Number(result.lastInsertRowid));
    }
    return pool;
  }

  async function activatePool(poolId) {
    const pool = await db.prepare('SELECT * FROM pools WHERE id = ? FOR UPDATE').get(poolId);
    if (!pool || pool.status !== 'FORMING' || pool.total_amount < pool.target_amount) return false;
    const plan = await db.prepare('SELECT * FROM investment_plans WHERE id = ?').get(pool.plan_id);
    const activatedAt = now();
    const changed = await db.prepare(`UPDATE pools SET status = 'ACTIVE', activated_at = ?
      WHERE id = ? AND status = 'FORMING'`).run(activatedAt, poolId);
    if (!changed.changes) return false;

    const pending = await db.prepare(`SELECT user_id, SUM(contribution) AS amount FROM investments
      WHERE pool_id = ? AND status = 'PENDING' GROUP BY user_id`).all(poolId);
    await db.prepare(`UPDATE investments SET status = 'ACTIVE', activated_at = ?, maturity_at = ?
      WHERE pool_id = ? AND status = 'PENDING'`)
      .run(activatedAt, activatedAt + plan.duration_days * DAY_MS, poolId);
    for (const member of pending) {
      await updateWallet(member.user_id, { pending: -member.amount, invested: member.amount });
      await notify(member.user_id, 'POOL_ACTIVATED', `Pool #${poolId} is active. Your ${plan.rate}% investment duration has started.`, {
        poolId,
        eventKey: `pool-activated:${poolId}:${member.user_id}`
      });
    }
    await db.prepare(`UPDATE pools SET investor_count = (SELECT COUNT(DISTINCT user_id) FROM investments
      WHERE pool_id = ? AND status = 'ACTIVE') WHERE id = ?`).run(poolId, poolId);
    return true;
  }

  async function getInvestment(userId, investmentId, lock = false) {
    const investment = await db.prepare(`SELECT i.*, p.rate, p.minimum, p.maximum, p.duration_days,
      po.target_amount, po.total_amount, po.investor_count, po.status AS pool_status,
      po.expires_at AS pool_expires_at, po.activated_at AS pool_activated_at
      FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      JOIN pools po ON po.id = i.pool_id WHERE i.id = ? AND i.user_id = ?${lock ? ' FOR UPDATE OF i' : ''}`)
      .get(investmentId, userId);
    if (!investment) fail(404, 'Investment not found.');
    return investment;
  }

  async function getInvestmentDetails(userId, investmentId) {
    const investment = await getInvestment(userId, investmentId);
    const contributions = await db.prepare(`SELECT id, amount, created_at FROM investment_contributions
      WHERE investment_id = ? ORDER BY created_at`).all(investmentId);
    return { ...investment, contributions, progress_percent: Math.min(100, Math.round(investment.total_amount * 100 / investment.target_amount)) };
  }

  async function createInvestment(userId, planRate, rawAmount, requestedPoolId = null, idempotencyKey = null) {
    const amount = amountValue(rawAmount);
    return transaction(async () => {
      await processDueEventsInsideTransaction();
      const plan = await db.prepare('SELECT * FROM investment_plans WHERE rate = ? AND active = 1').get(Number(planRate));
      if (!plan) fail(404, 'Investment tier not found.');
      if (amount < plan.minimum || amount > plan.maximum) fail(400, `Amount must be between ₦${plan.minimum.toLocaleString()} and ₦${plan.maximum.toLocaleString()} for this tier.`);
      let replay = await replayTransaction(userId, idempotencyKey, 'INVESTMENT_CONTRIBUTION', amount, { planId: plan.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);

      let pool;
      if (requestedPoolId !== null && requestedPoolId !== undefined) {
        pool = await db.prepare('SELECT * FROM pools WHERE id = ? AND plan_id = ? FOR UPDATE')
          .get(Number(requestedPoolId), plan.id);
        if (!pool) fail(404, 'Forming pool not found for this investment tier.');
      } else {
        pool = await ensureFormingPool(plan);
      }

      const wallet = await walletFor(userId, true);
      replay = await replayTransaction(userId, idempotencyKey, 'INVESTMENT_CONTRIBUTION', amount, { planId: plan.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      if (pool.status !== 'FORMING' || pool.total_amount >= pool.target_amount || pool.expires_at <= now()) {
        fail(409, 'This pool is not accepting investments.');
      }
      if (wallet.available_balance < amount) fail(409, 'Insufficient available balance.');

      const createdAt = now();
      const investmentResult = await db.prepare(`INSERT INTO investments
        (user_id, pool_id, plan_id, contribution, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?) RETURNING id`)
        .run(userId, pool.id, plan.id, amount, createdAt);
      const investmentId = Number(investmentResult.lastInsertRowid);
      await db.prepare(`INSERT INTO investment_contributions (investment_id, user_id, amount, created_at)
        VALUES (?, ?, ?, ?)`).run(investmentId, userId, amount, createdAt);
      await updateWallet(userId, { available: -amount, pending: amount });
      await recordTransaction({ userId, investmentId, poolId: pool.id, type: 'INVESTMENT_CONTRIBUTION', direction: 'DEBIT', amount, description: `Initial contribution to tier ${plan.rate}% pool #${pool.id}.`, idempotencyKey });
      await db.prepare(`UPDATE pools SET total_amount = total_amount + ?, investor_count =
        (SELECT COUNT(DISTINCT user_id) FROM investments WHERE pool_id = ? AND status = 'PENDING') WHERE id = ?`)
        .run(amount, pool.id, pool.id);
      await notify(userId, 'INVESTMENT_CREATED', `Investment #${investmentId} created in forming pool #${pool.id}.`, { investmentId, poolId: pool.id });
      await activatePool(pool.id);
      return getInvestmentDetails(userId, investmentId);
    });
  }

  async function addContribution(userId, investmentId, rawAmount, idempotencyKey = null) {
    const amount = amountValue(rawAmount, 'Contribution');
    return transaction(async () => {
      await processDueEventsInsideTransaction();
      const snapshot = await getInvestment(userId, investmentId);
      let replay = await replayTransaction(userId, idempotencyKey, 'ADDITIONAL_CONTRIBUTION', amount, { investmentId: snapshot.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      const pool = await db.prepare('SELECT id FROM pools WHERE id = ? FOR UPDATE').get(snapshot.pool_id);
      if (!pool) fail(404, 'Investment not found.');
      const investment = await getInvestment(userId, investmentId, true);
      const wallet = await walletFor(userId, true);
      replay = await replayTransaction(userId, idempotencyKey, 'ADDITIONAL_CONTRIBUTION', amount, { investmentId: investment.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      if (investment.status !== 'PENDING' || investment.pool_status !== 'FORMING') {
        fail(409, 'Only pending investments in forming pools can receive additional funds.');
      }
      const updatedAmount = investment.contribution + amount;
      if (updatedAmount > investment.maximum) fail(400, `Total contribution cannot exceed ₦${investment.maximum.toLocaleString()} for this tier.`);
      if (wallet.available_balance < amount) fail(409, 'Insufficient available balance.');
      const createdAt = now();
      await updateWallet(userId, { available: -amount, pending: amount });
      await db.prepare('UPDATE investments SET contribution = ? WHERE id = ?').run(updatedAmount, investmentId);
      await db.prepare(`INSERT INTO investment_contributions (investment_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)`)
        .run(investmentId, userId, amount, createdAt);
      await db.prepare('UPDATE pools SET total_amount = total_amount + ? WHERE id = ?').run(amount, investment.pool_id);
      await recordTransaction({ userId, investmentId, poolId: investment.pool_id, type: 'ADDITIONAL_CONTRIBUTION', direction: 'DEBIT', amount, description: `Additional contribution to investment #${investmentId}.`, idempotencyKey });
      await notify(userId, 'CONTRIBUTION_ADDED', `₦${amount.toLocaleString()} added to pending investment #${investmentId}.`, { investmentId, poolId: investment.pool_id });
      await activatePool(investment.pool_id);
      return getInvestmentDetails(userId, investmentId);
    });
  }

  async function cancelInvestment(userId, investmentId, idempotencyKey = null) {
    return transaction(async () => {
      await processDueEventsInsideTransaction();
      const snapshot = await getInvestment(userId, investmentId);
      let replay = await replayTransaction(userId, idempotencyKey, 'CANCELLATION_REFUND', null, { investmentId: snapshot.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      const pool = await db.prepare('SELECT id FROM pools WHERE id = ? FOR UPDATE').get(snapshot.pool_id);
      if (!pool) fail(404, 'Investment not found.');
      const investment = await getInvestment(userId, investmentId, true);
      const wallet = await walletFor(userId, true);
      replay = await replayTransaction(userId, idempotencyKey, 'CANCELLATION_REFUND', null, { investmentId: investment.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      if (investment.status !== 'PENDING' || investment.pool_status !== 'FORMING') {
        fail(409, 'Only pending investments in forming pools can be cancelled.');
      }
      const changed = await db.prepare(`UPDATE investments SET status = 'CANCELLED', completed_at = ?
        WHERE id = ? AND status = 'PENDING'`).run(now(), investmentId);
      if (!changed.changes) fail(409, 'This investment can no longer be cancelled.');
      await db.prepare(`UPDATE pools SET total_amount = total_amount - ?, investor_count =
        (SELECT COUNT(DISTINCT user_id) FROM investments WHERE pool_id = ? AND status = 'PENDING') WHERE id = ?`)
        .run(investment.contribution, investment.pool_id, investment.pool_id);
      await updateWallet(userId, { available: investment.contribution, pending: -investment.contribution });
      await recordTransaction({ userId, investmentId, poolId: investment.pool_id, type: 'CANCELLATION_REFUND', direction: 'CREDIT', amount: investment.contribution, description: `Refund for cancelled investment #${investmentId}.`, idempotencyKey });
      await notify(userId, 'INVESTMENT_CANCELLED', `Investment #${investmentId} was cancelled and its funds were returned to your available balance.`, { investmentId, poolId: investment.pool_id });
      await notify(userId, 'CANCELLATION_REFUND', `₦${investment.contribution.toLocaleString()} from investment #${investmentId} is available in your wallet.`, {
        investmentId, poolId: investment.pool_id, eventKey: `cancellation-refund:${investmentId}`
      });
      return getInvestmentDetails(userId, investmentId);
    });
  }

  async function addSimulatedFunds(userId, rawAmount, idempotencyKey = null) {
    const amount = amountValue(rawAmount, 'Deposit');
    if (amount > 1000000000) fail(400, 'A single deposit cannot exceed ₦1,000,000,000.');
    return transaction(async () => {
      const wallet = await walletFor(userId, true);
      const replay = await replayTransaction(userId, idempotencyKey, 'SIMULATED_DEPOSIT', amount);
      if (replay) return walletFor(userId);
      await updateWallet(userId, { available: amount });
      await recordTransaction({ userId, type: 'SIMULATED_DEPOSIT', direction: 'CREDIT', amount, description: 'Simulated funds added to wallet. No real funds were received.', idempotencyKey });
      return walletFor(userId);
    });
  }

  async function processDueEventsInsideTransaction() {
    const timestamp = now();
    const expiringPools = await db.prepare(`SELECT * FROM pools WHERE status = 'FORMING' AND expires_at <= ?
      ORDER BY id FOR UPDATE`).all(timestamp);
    for (const pool of expiringPools) {
      const pending = await db.prepare(`SELECT * FROM investments WHERE pool_id = ? AND status = 'PENDING' ORDER BY id`)
        .all(pool.id);
      const changed = await db.prepare(`UPDATE pools SET status = 'EXPIRED', completed_at = ?
        WHERE id = ? AND status = 'FORMING'`).run(timestamp, pool.id);
      if (!changed.changes) continue;
      for (const investment of pending) {
        const refunded = await db.prepare(`UPDATE investments SET status = 'REFUNDED', completed_at = ?
          WHERE id = ? AND status = 'PENDING'`).run(timestamp, investment.id);
        if (!refunded.changes) continue;
        await updateWallet(investment.user_id, { available: investment.contribution, pending: -investment.contribution });
        await recordTransaction({ userId: investment.user_id, investmentId: investment.id, poolId: pool.id, type: 'POOL_EXPIRY_REFUND', direction: 'CREDIT', amount: investment.contribution, description: `Pool #${pool.id} expired; pending investment funds were refunded.`, idempotencyKey: `pool-expiry:${investment.id}` });
        await notify(investment.user_id, 'POOL_EXPIRED', `Pool #${pool.id} expired without reaching its target.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-expired:${investment.id}` });
        await notify(investment.user_id, 'POOL_EXPIRED_REFUND', `Pool #${pool.id} expired before reaching its target. ₦${investment.contribution.toLocaleString()} was refunded to your available balance.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-expiry-refund-notified:${investment.id}` });
        await notify(investment.user_id, 'POOL_REFUND_CREDITED', `₦${investment.contribution.toLocaleString()} from expired pool #${pool.id} is available in your wallet.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-refund:${investment.id}` });
      }
    }

    const approaching = await db.prepare(`SELECT * FROM investments WHERE status = 'ACTIVE' AND maturity_at > ? AND maturity_at <= ?`)
      .all(timestamp, timestamp + 3 * DAY_MS);
    for (const investment of approaching) {
      await notify(investment.user_id, 'MATURITY_APPROACHING', `Investment #${investment.id} is approaching maturity.`, {
        investmentId: investment.id,
        poolId: investment.pool_id,
        eventKey: `maturity-approaching:${investment.id}`
      });
    }

    const maturing = await db.prepare(`SELECT i.*, p.rate FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      WHERE i.status = 'ACTIVE' AND i.maturity_at <= ? ORDER BY i.id`).all(timestamp);
    for (const investment of maturing) {
      const roi = Math.round(investment.contribution * investment.rate / 100);
      const maturityAmount = investment.contribution + roi;
      const changed = await db.prepare(`UPDATE investments SET status = 'MATURED', roi_amount = ?, maturity_amount = ?, completed_at = ?
        WHERE id = ? AND status = 'ACTIVE'`).run(roi, maturityAmount, timestamp, investment.id);
      if (!changed.changes) continue;
      await updateWallet(investment.user_id, { available: maturityAmount, invested: -investment.contribution });
      await recordTransaction({ userId: investment.user_id, investmentId: investment.id, poolId: investment.pool_id, type: 'MATURITY_CREDIT', direction: 'CREDIT', amount: maturityAmount, description: `Matured principal ₦${investment.contribution.toLocaleString()} plus ROI ₦${roi.toLocaleString()}.`, idempotencyKey: `maturity:${investment.id}` });
      await notify(investment.user_id, 'INVESTMENT_MATURED', `Investment #${investment.id} matured. ₦${maturityAmount.toLocaleString()} was credited to your available balance.`, { investmentId: investment.id, poolId: investment.pool_id, eventKey: `investment-matured:${investment.id}` });
      await notify(investment.user_id, 'MATURITY_CREDITED', `₦${maturityAmount.toLocaleString()} from investment #${investment.id} is available in your wallet.`, { investmentId: investment.id, poolId: investment.pool_id, eventKey: `maturity-credited:${investment.id}` });
    }

    await db.prepare(`UPDATE pools SET status = 'MATURED', completed_at = ? WHERE status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM investments WHERE investments.pool_id = pools.id AND investments.status = 'ACTIVE')`)
      .run(timestamp);
  }

  async function processDueEvents() {
    return transaction(async () => {
      await processDueEventsInsideTransaction();
      return { processedAt: now() };
    });
  }

  function getWallet(userId) {
    return walletFor(userId);
  }

  async function listInvestments(userId) {
    return (await db.prepare(`SELECT i.*, p.rate, p.duration_days, po.target_amount, po.total_amount,
      po.investor_count, po.status AS pool_status, po.expires_at AS pool_expires_at,
      po.activated_at AS pool_activated_at
      FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      JOIN pools po ON po.id = i.pool_id WHERE i.user_id = ? ORDER BY i.created_at DESC`).all(userId))
      .map(item => ({ ...item, progress_percent: Math.min(100, Math.round(item.total_amount * 100 / item.target_amount)) }));
  }

  async function listPools(userId) {
    return db.prepare(`SELECT po.id, po.plan_id, p.rate, p.duration_days, po.target_amount, po.total_amount,
      po.investor_count, po.status, po.created_at, po.expires_at, po.activated_at,
      LEAST(100, FLOOR(po.total_amount * 100.0 / po.target_amount)::INTEGER) AS progress_percent,
      COALESCE((SELECT SUM(i.contribution) FROM investments i WHERE i.pool_id = po.id AND i.user_id = ?
        AND i.status IN ('PENDING', 'ACTIVE')), 0) AS my_contribution
      FROM pools po JOIN investment_plans p ON p.id = po.plan_id
      WHERE po.status IN ('FORMING', 'ACTIVE') ORDER BY po.status, po.created_at`).all(userId);
  }

  async function getPool(userId, poolId) {
    const pool = (await listPools(userId)).find(item => item.id === Number(poolId));
    if (!pool) fail(404, 'Pool not found.');
    return pool;
  }

  function listTransactions(userId, limit = 100) {
    return db.prepare(`SELECT id, investment_id, pool_id, type, direction, amount, status, description, created_at
      FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, limit);
  }

  function listNotifications(userId) {
    return db.prepare(`SELECT id, type, message, related_investment_id, related_pool_id, read_at, created_at
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).all(userId);
  }

  async function markNotificationRead(userId, notificationId) {
    const result = await db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(now(), notificationId, userId);
    if (!result.changes) {
      const existing = await db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(notificationId, userId);
      if (!existing) fail(404, 'Notification not found.');
    }
    return db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(notificationId, userId);
  }

  async function adminOverview() {
    const [users, pools, investments, transactions, wallets] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS count FROM users').get(),
      db.prepare('SELECT status, COUNT(*) AS count FROM pools GROUP BY status').all(),
      db.prepare('SELECT status, COUNT(*) AS count FROM investments GROUP BY status').all(),
      db.prepare('SELECT COUNT(*) AS count FROM transactions').get(),
      db.prepare(`SELECT COALESCE(SUM(available_balance), 0) AS available,
        COALESCE(SUM(pending_balance), 0) AS pending, COALESCE(SUM(invested_balance), 0) AS invested FROM wallets`).get()
    ]);
    return { users: users.count, pools, investments, transactions: transactions.count, wallets };
  }

  return {
    transaction, fail, amountValue, walletFor, recordTransaction, notify, createInvestment,
    addContribution, cancelInvestment, addSimulatedFunds, processDueEvents, getWallet,
    listInvestments, getInvestmentDetails, listPools, getPool, listTransactions,
    listNotifications, markNotificationRead, adminOverview
  };
}

module.exports = { createPlatform, DAY_MS };
