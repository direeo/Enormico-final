const DAY_MS = 24 * 60 * 60 * 1000;

function createPlatform(db, now = () => Date.now()) {
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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

  function walletFor(userId) {
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    if (!wallet) fail(404, 'Wallet not found.');
    return wallet;
  }

  function updateWallet(userId, { available = 0, pending = 0, invested = 0 }) {
    const wallet = walletFor(userId);
    const next = {
      available_balance: wallet.available_balance + available,
      pending_balance: wallet.pending_balance + pending,
      invested_balance: wallet.invested_balance + invested
    };
    if (Object.values(next).some(balance => balance < 0 || !Number.isSafeInteger(balance))) {
      fail(409, 'Insufficient funds or invalid balance transition.');
    }
    db.prepare(`UPDATE wallets SET available_balance = ?, pending_balance = ?, invested_balance = ?, updated_at = ?
      WHERE user_id = ?`).run(next.available_balance, next.pending_balance, next.invested_balance, now(), userId);
    return next;
  }

  function recordTransaction({ userId, investmentId = null, poolId = null, type, direction, amount, description, idempotencyKey = null }) {
    const scopedKey = idempotencyKey ? `${userId}:${idempotencyKey}` : null;
    const result = db.prepare(`INSERT INTO transactions
      (user_id, investment_id, pool_id, type, direction, amount, status, description, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`)
      .run(userId, investmentId, poolId, type, direction, amount, description, scopedKey, now());
    return Number(result.lastInsertRowid);
  }

  function replayTransaction(userId, idempotencyKey, expectedType, amount = null, context = {}) {
    if (!idempotencyKey) return null;
    const existing = db.prepare(`SELECT t.*, i.plan_id AS investment_plan_id FROM transactions t
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

  function notify(userId, type, message, { investmentId = null, poolId = null, eventKey = null } = {}) {
    const result = db.prepare(`INSERT OR IGNORE INTO notifications
      (user_id, type, message, related_investment_id, related_pool_id, event_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, type, message, investmentId, poolId, eventKey, now());
    return Number(result.lastInsertRowid || 0);
  }

  function ensureFormingPool(plan) {
    let pool = db.prepare(`SELECT * FROM pools WHERE plan_id = ? AND status = 'FORMING'
      AND total_amount < target_amount AND expires_at > ? ORDER BY created_at LIMIT 1`).get(plan.id, now());
    if (!pool) {
      const createdAt = now();
      const result = db.prepare(`INSERT INTO pools
        (plan_id, target_amount, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'FORMING')`)
        .run(plan.id, plan.pool_target, createdAt, createdAt + 14 * DAY_MS);
      pool = db.prepare('SELECT * FROM pools WHERE id = ?').get(Number(result.lastInsertRowid));
    }
    return pool;
  }

  function activatePool(poolId) {
    const pool = db.prepare('SELECT * FROM pools WHERE id = ?').get(poolId);
    if (!pool || pool.status !== 'FORMING' || pool.total_amount < pool.target_amount) return false;
    const plan = db.prepare('SELECT * FROM investment_plans WHERE id = ?').get(pool.plan_id);
    const activatedAt = now();
    db.prepare(`UPDATE pools SET status = 'ACTIVE', activated_at = ? WHERE id = ? AND status = 'FORMING'`)
      .run(activatedAt, poolId);

    const pending = db.prepare(`SELECT user_id, SUM(contribution) AS amount FROM investments
      WHERE pool_id = ? AND status = 'PENDING' GROUP BY user_id`).all(poolId);
    db.prepare(`UPDATE investments SET status = 'ACTIVE', activated_at = ?, maturity_at = ?
      WHERE pool_id = ? AND status = 'PENDING'`)
      .run(activatedAt, activatedAt + plan.duration_days * DAY_MS, poolId);
    for (const member of pending) {
      updateWallet(member.user_id, { pending: -member.amount, invested: member.amount });
      notify(member.user_id, 'POOL_ACTIVATED', `Pool #${poolId} is active. Your ${plan.rate}% investment duration has started.`, {
        poolId,
        eventKey: `pool-activated:${poolId}:${member.user_id}`
      });
    }
    db.prepare(`UPDATE pools SET investor_count = (SELECT COUNT(DISTINCT user_id) FROM investments
      WHERE pool_id = ? AND status = 'ACTIVE') WHERE id = ?`).run(poolId, poolId);
    return true;
  }

  function getInvestment(userId, investmentId) {
    const investment = db.prepare(`SELECT i.*, p.rate, p.minimum, p.maximum, p.duration_days,
      po.target_amount, po.total_amount, po.investor_count, po.status AS pool_status,
      po.expires_at AS pool_expires_at, po.activated_at AS pool_activated_at
      FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      JOIN pools po ON po.id = i.pool_id WHERE i.id = ? AND i.user_id = ?`).get(investmentId, userId);
    if (!investment) fail(404, 'Investment not found.');
    return investment;
  }

  function getInvestmentDetails(userId, investmentId) {
    const investment = getInvestment(userId, investmentId);
    const contributions = db.prepare(`SELECT id, amount, created_at FROM investment_contributions
      WHERE investment_id = ? ORDER BY created_at`).all(investmentId);
    return { ...investment, contributions, progress_percent: Math.min(100, Math.round(investment.total_amount * 100 / investment.target_amount)) };
  }

  function createInvestment(userId, planRate, rawAmount, requestedPoolId = null, idempotencyKey = null) {
    const amount = amountValue(rawAmount);
    return transaction(() => {
      processDueEventsInsideTransaction();
      const plan = db.prepare('SELECT * FROM investment_plans WHERE rate = ? AND active = 1').get(Number(planRate));
      if (!plan) fail(404, 'Investment tier not found.');
      if (amount < plan.minimum || amount > plan.maximum) fail(400, `Amount must be between ₦${plan.minimum.toLocaleString()} and ₦${plan.maximum.toLocaleString()} for this tier.`);
      const replay = replayTransaction(userId, idempotencyKey, 'INVESTMENT_CONTRIBUTION', amount, { planId: plan.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      const wallet = walletFor(userId);
      if (wallet.available_balance < amount) fail(409, 'Insufficient available balance.');
      let pool;
      if (requestedPoolId !== null && requestedPoolId !== undefined) {
        pool = db.prepare('SELECT * FROM pools WHERE id = ? AND plan_id = ?').get(Number(requestedPoolId), plan.id);
        if (!pool) fail(404, 'Forming pool not found for this investment tier.');
        if (pool.status !== 'FORMING' || pool.total_amount >= pool.target_amount || pool.expires_at <= now()) fail(409, 'This pool is not accepting investments.');
      } else {
        pool = ensureFormingPool(plan);
      }
      const createdAt = now();
      const investmentResult = db.prepare(`INSERT INTO investments
        (user_id, pool_id, plan_id, contribution, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)`)
        .run(userId, pool.id, plan.id, amount, createdAt);
      const investmentId = Number(investmentResult.lastInsertRowid);
      db.prepare(`INSERT INTO investment_contributions (investment_id, user_id, amount, created_at)
        VALUES (?, ?, ?, ?)`).run(investmentId, userId, amount, createdAt);
      updateWallet(userId, { available: -amount, pending: amount });
      recordTransaction({ userId, investmentId, poolId: pool.id, type: 'INVESTMENT_CONTRIBUTION', direction: 'DEBIT', amount, description: `Initial contribution to tier ${plan.rate}% pool #${pool.id}.`, idempotencyKey });
      db.prepare(`UPDATE pools SET total_amount = total_amount + ?, investor_count =
        (SELECT COUNT(DISTINCT user_id) FROM investments WHERE pool_id = ? AND status = 'PENDING') WHERE id = ?`)
        .run(amount, pool.id, pool.id);
      notify(userId, 'INVESTMENT_CREATED', `Investment #${investmentId} created in forming pool #${pool.id}.`, { investmentId, poolId: pool.id });
      activatePool(pool.id);
      return getInvestmentDetails(userId, investmentId);
    });
  }

  function addContribution(userId, investmentId, rawAmount, idempotencyKey = null) {
    const amount = amountValue(rawAmount, 'Contribution');
    return transaction(() => {
      processDueEventsInsideTransaction();
      const investment = getInvestment(userId, investmentId);
      const replay = replayTransaction(userId, idempotencyKey, 'ADDITIONAL_CONTRIBUTION', amount, { investmentId: investment.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      if (investment.status !== 'PENDING' || investment.pool_status !== 'FORMING') fail(409, 'Only pending investments in forming pools can receive additional funds.');
      const updatedAmount = investment.contribution + amount;
      if (updatedAmount > investment.maximum) fail(400, `Total contribution cannot exceed ₦${investment.maximum.toLocaleString()} for this tier.`);
      if (walletFor(userId).available_balance < amount) fail(409, 'Insufficient available balance.');
      const createdAt = now();
      updateWallet(userId, { available: -amount, pending: amount });
      db.prepare('UPDATE investments SET contribution = ? WHERE id = ?').run(updatedAmount, investmentId);
      db.prepare(`INSERT INTO investment_contributions (investment_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)`)
        .run(investmentId, userId, amount, createdAt);
      db.prepare('UPDATE pools SET total_amount = total_amount + ? WHERE id = ?').run(amount, investment.pool_id);
      recordTransaction({ userId, investmentId, poolId: investment.pool_id, type: 'ADDITIONAL_CONTRIBUTION', direction: 'DEBIT', amount, description: `Additional contribution to investment #${investmentId}.`, idempotencyKey });
      notify(userId, 'CONTRIBUTION_ADDED', `₦${amount.toLocaleString()} added to pending investment #${investmentId}.`, { investmentId, poolId: investment.pool_id });
      activatePool(investment.pool_id);
      return getInvestmentDetails(userId, investmentId);
    });
  }

  function cancelInvestment(userId, investmentId, idempotencyKey = null) {
    return transaction(() => {
      processDueEventsInsideTransaction();
      const investment = getInvestment(userId, investmentId);
      const replay = replayTransaction(userId, idempotencyKey, 'CANCELLATION_REFUND', null, { investmentId: investment.id });
      if (replay) return getInvestmentDetails(userId, replay.investment_id);
      if (investment.status !== 'PENDING' || investment.pool_status !== 'FORMING') fail(409, 'Only pending investments in forming pools can be cancelled.');
      db.prepare(`UPDATE investments SET status = 'CANCELLED', completed_at = ? WHERE id = ?`).run(now(), investmentId);
      db.prepare(`UPDATE pools SET total_amount = total_amount - ?, investor_count =
        (SELECT COUNT(DISTINCT user_id) FROM investments WHERE pool_id = ? AND status = 'PENDING') WHERE id = ?`)
        .run(investment.contribution, investment.pool_id, investment.pool_id);
      updateWallet(userId, { available: investment.contribution, pending: -investment.contribution });
      recordTransaction({ userId, investmentId, poolId: investment.pool_id, type: 'CANCELLATION_REFUND', direction: 'CREDIT', amount: investment.contribution, description: `Refund for cancelled investment #${investmentId}.`, idempotencyKey });
      notify(userId, 'INVESTMENT_CANCELLED', `Investment #${investmentId} was cancelled and its funds were returned to your available balance.`, { investmentId, poolId: investment.pool_id });
      notify(userId, 'CANCELLATION_REFUND', `₦${investment.contribution.toLocaleString()} from investment #${investmentId} is available in your wallet.`, {
        investmentId, poolId: investment.pool_id, eventKey: `cancellation-refund:${investmentId}`
      });
      return getInvestmentDetails(userId, investmentId);
    });
  }

  function addSimulatedFunds(userId, rawAmount, idempotencyKey = null) {
    const amount = amountValue(rawAmount, 'Deposit');
    if (amount > 1000000000) fail(400, 'A single deposit cannot exceed ₦1,000,000,000.');
    return transaction(() => {
      const replay = replayTransaction(userId, idempotencyKey, 'SIMULATED_DEPOSIT', amount);
      if (replay) return walletFor(userId);
      updateWallet(userId, { available: amount });
      recordTransaction({ userId, type: 'SIMULATED_DEPOSIT', direction: 'CREDIT', amount, description: 'Simulated funds added to wallet. No real funds were received.', idempotencyKey });
      return walletFor(userId);
    });
  }

  function processDueEventsInsideTransaction() {
    const timestamp = now();
    const expiringPools = db.prepare(`SELECT * FROM pools WHERE status = 'FORMING' AND expires_at <= ?`).all(timestamp);
    for (const pool of expiringPools) {
      const pending = db.prepare(`SELECT * FROM investments WHERE pool_id = ? AND status = 'PENDING'`).all(pool.id);
      db.prepare(`UPDATE pools SET status = 'EXPIRED', completed_at = ? WHERE id = ? AND status = 'FORMING'`).run(timestamp, pool.id);
      for (const investment of pending) {
        db.prepare(`UPDATE investments SET status = 'REFUNDED', completed_at = ? WHERE id = ? AND status = 'PENDING'`).run(timestamp, investment.id);
        updateWallet(investment.user_id, { available: investment.contribution, pending: -investment.contribution });
        recordTransaction({ userId: investment.user_id, investmentId: investment.id, poolId: pool.id, type: 'POOL_EXPIRY_REFUND', direction: 'CREDIT', amount: investment.contribution, description: `Pool #${pool.id} expired; pending investment funds were refunded.`, idempotencyKey: `pool-expiry:${investment.id}` });
        notify(investment.user_id, 'POOL_EXPIRED', `Pool #${pool.id} expired without reaching its target.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-expired:${investment.id}` });
        notify(investment.user_id, 'POOL_EXPIRED_REFUND', `Pool #${pool.id} expired before reaching its target. ₦${investment.contribution.toLocaleString()} was refunded to your available balance.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-expiry-refund-notified:${investment.id}` });
        notify(investment.user_id, 'POOL_REFUND_CREDITED', `₦${investment.contribution.toLocaleString()} from expired pool #${pool.id} is available in your wallet.`, { investmentId: investment.id, poolId: pool.id, eventKey: `pool-refund:${investment.id}` });
      }
    }

    const approaching = db.prepare(`SELECT * FROM investments WHERE status = 'ACTIVE' AND maturity_at > ? AND maturity_at <= ?`)
      .all(timestamp, timestamp + 3 * DAY_MS);
    for (const investment of approaching) {
      notify(investment.user_id, 'MATURITY_APPROACHING', `Investment #${investment.id} is approaching maturity.`, {
        investmentId: investment.id,
        poolId: investment.pool_id,
        eventKey: `maturity-approaching:${investment.id}`
      });
    }

    const maturing = db.prepare(`SELECT i.*, p.rate FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      WHERE i.status = 'ACTIVE' AND i.maturity_at <= ?`).all(timestamp);
    for (const investment of maturing) {
      const roi = Math.round(investment.contribution * investment.rate / 100);
      const maturityAmount = investment.contribution + roi;
      const changed = db.prepare(`UPDATE investments SET status = 'MATURED', roi_amount = ?, maturity_amount = ?, completed_at = ?
        WHERE id = ? AND status = 'ACTIVE'`).run(roi, maturityAmount, timestamp, investment.id);
      if (!changed.changes) continue;
      updateWallet(investment.user_id, { available: maturityAmount, invested: -investment.contribution });
      recordTransaction({ userId: investment.user_id, investmentId: investment.id, poolId: investment.pool_id, type: 'MATURITY_CREDIT', direction: 'CREDIT', amount: maturityAmount, description: `Matured principal ₦${investment.contribution.toLocaleString()} plus ROI ₦${roi.toLocaleString()}.`, idempotencyKey: `maturity:${investment.id}` });
      notify(investment.user_id, 'INVESTMENT_MATURED', `Investment #${investment.id} matured. ₦${maturityAmount.toLocaleString()} was credited to your available balance.`, { investmentId: investment.id, poolId: investment.pool_id, eventKey: `investment-matured:${investment.id}` });
      notify(investment.user_id, 'MATURITY_CREDITED', `₦${maturityAmount.toLocaleString()} from investment #${investment.id} is available in your wallet.`, { investmentId: investment.id, poolId: investment.pool_id, eventKey: `maturity-credited:${investment.id}` });
    }

    db.prepare(`UPDATE pools SET status = 'MATURED', completed_at = ? WHERE status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM investments WHERE investments.pool_id = pools.id AND investments.status = 'ACTIVE')`)
      .run(timestamp);
  }

  function processDueEvents() {
    return transaction(() => {
      processDueEventsInsideTransaction();
      return { processedAt: now() };
    });
  }

  function getWallet(userId) {
    return walletFor(userId);
  }

  function listInvestments(userId) {
    return db.prepare(`SELECT i.*, p.rate, p.duration_days, po.target_amount, po.total_amount,
      po.investor_count, po.status AS pool_status, po.expires_at AS pool_expires_at,
      po.activated_at AS pool_activated_at
      FROM investments i JOIN investment_plans p ON p.id = i.plan_id
      JOIN pools po ON po.id = i.pool_id WHERE i.user_id = ? ORDER BY i.created_at DESC`).all(userId)
      .map(item => ({ ...item, progress_percent: Math.min(100, Math.round(item.total_amount * 100 / item.target_amount)) }));
  }

  function listPools(userId) {
    return db.prepare(`SELECT po.id, po.plan_id, p.rate, p.duration_days, po.target_amount, po.total_amount,
      po.investor_count, po.status, po.created_at, po.expires_at, po.activated_at,
      MIN(100, CAST(po.total_amount * 100.0 / po.target_amount AS INTEGER)) AS progress_percent,
      COALESCE((SELECT SUM(i.contribution) FROM investments i WHERE i.pool_id = po.id AND i.user_id = ?
        AND i.status IN ('PENDING', 'ACTIVE')), 0) AS my_contribution
      FROM pools po JOIN investment_plans p ON p.id = po.plan_id
      WHERE po.status IN ('FORMING', 'ACTIVE') ORDER BY po.status, po.created_at`).all(userId);
  }

  function getPool(userId, poolId) {
    const pool = listPools(userId).find(item => item.id === Number(poolId));
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

  function markNotificationRead(userId, notificationId) {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(now(), notificationId, userId);
    if (!result.changes) {
      const existing = db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(notificationId, userId);
      if (!existing) fail(404, 'Notification not found.');
    }
    return db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(notificationId, userId);
  }

  function adminOverview() {
    return {
      users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
      pools: db.prepare('SELECT status, COUNT(*) AS count FROM pools GROUP BY status').all(),
      investments: db.prepare('SELECT status, COUNT(*) AS count FROM investments GROUP BY status').all(),
      transactions: db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      wallets: db.prepare(`SELECT COALESCE(SUM(available_balance), 0) AS available,
        COALESCE(SUM(pending_balance), 0) AS pending, COALESCE(SUM(invested_balance), 0) AS invested FROM wallets`).get()
    };
  }

  return {
    transaction, fail, amountValue, walletFor, recordTransaction, notify, createInvestment,
    addContribution, cancelInvestment, addSimulatedFunds, processDueEvents, getWallet,
    listInvestments, getInvestmentDetails, listPools, getPool, listTransactions,
    listNotifications, markNotificationRead, adminOverview
  };
}

module.exports = { createPlatform, DAY_MS };