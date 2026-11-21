document.addEventListener('DOMContentLoaded', async () => {
  const message = document.getElementById('adminMessage');
  function cell(row, value) {
    const td = document.createElement('td');
    td.textContent = value ?? '—';
    row.append(td);
  }
  function row(parent, values) {
    const tr = document.createElement('tr');
    values.forEach(value => cell(tr, value));
    parent.append(tr);
    return tr;
  }
  function date(value) { return value ? Enormico.date(value) : '—'; }

  try {
    const user = await Enormico.guard(true);
    if (!user) return;
    document.getElementById('logoutButton').addEventListener('click', async () => {
      await Enormico.api('/api/auth/logout', { method: 'POST', body: '{}' });
      location.href = 'index.html';
    });
    const [statsResult, usersResult, plansResult, poolsResult, investmentsResult, transactionsResult] = await Promise.all([
      Enormico.api('/api/admin/stats'), Enormico.api('/api/admin/users'), Enormico.api('/api/admin/plans'),
      Enormico.api('/api/admin/pools'), Enormico.api('/api/admin/investments'), Enormico.api('/api/admin/transactions')
    ]);
    const stats = statsResult.stats;
    const statsGrid = document.getElementById('stats');
    statsGrid.replaceChildren();
    [
      ['Users', stats.users], ['Ledger entries', stats.transactions],
      ['Available balance', Enormico.money(stats.wallets.available)],
      ['Pending investments', Enormico.money(stats.wallets.pending)],
      ['Invested / locked', Enormico.money(stats.wallets.invested)],
      ...stats.pools.map(item => [`Pools · ${item.status}`, item.count]),
      ...stats.investments.map(item => [`Investments · ${item.status}`, item.count])
    ].forEach(([label, value]) => {
      const article = document.createElement('article');
      article.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('strong'), { textContent: value }));
      statsGrid.append(article);
    });

    const plansBody = document.getElementById('plans');
    plansResult.plans.forEach(plan => {
      const tr = document.createElement('tr');
      cell(tr, `${plan.rate}%`);
      cell(tr, `${Enormico.money(plan.minimum)}–${Enormico.money(plan.maximum)}`);
      cell(tr, `${plan.duration_days} days`);
      const targetCell = document.createElement('td');
      const target = document.createElement('input');
      target.type = 'number'; target.min = '1'; target.step = '1'; target.value = plan.pool_target;
      targetCell.append(target); tr.append(targetCell);
      const activeCell = document.createElement('td');
      const active = document.createElement('input'); active.type = 'checkbox'; active.checked = Boolean(plan.active); active.setAttribute('aria-label', `Tier ${plan.rate} active`);
      activeCell.append(active); tr.append(activeCell);
      const actionCell = document.createElement('td');
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
      save.addEventListener('click', async () => {
        try {
          await Enormico.api(`/api/admin/plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ pool_target: Number(target.value), active: active.checked }) });
          Enormico.showMessage(message, `Tier ${plan.rate}% updated.`);
        } catch (error) { Enormico.showMessage(message, error.message, true); }
      });
      actionCell.append(save); tr.append(actionCell); plansBody.append(tr);
    });

    usersResult.users.forEach(user => row(document.getElementById('users'), [user.id, user.name, user.email, user.role, date(user.created_at)]));
    poolsResult.pools.forEach(pool => row(document.getElementById('pools'), [pool.id, `${pool.rate}%`, pool.status, `${Enormico.money(pool.total_amount)} / ${Enormico.money(pool.target_amount)}`, pool.investor_count, `${date(pool.created_at)} · expires ${date(pool.expires_at)}`]));
    investmentsResult.investments.forEach(item => row(document.getElementById('investments'), [item.id, item.email, `${item.rate}%`, Enormico.money(item.contribution), item.status, `${date(item.activated_at)} · matures ${date(item.maturity_at)}`]));
    transactionsResult.transactions.forEach(item => row(document.getElementById('transactions'), [item.id, item.email, item.type, item.direction, Enormico.money(item.amount), item.status, date(item.created_at)]));
  } catch (error) {
    Enormico.showMessage(message, error.message, true);
  }
});