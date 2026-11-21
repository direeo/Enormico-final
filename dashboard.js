document.addEventListener('DOMContentLoaded', async () => {
  const message = document.getElementById('dashboardMessage');
  const investmentList = document.getElementById('investmentList');
  const transactionList = document.getElementById('transactionList');
  const notificationList = document.getElementById('notificationList');

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function actionButton(label, className, callback) {
    const button = node('button', className, label);
    button.type = 'button';
    button.addEventListener('click', callback);
    return button;
  }

  function renderInvestments(investments) {
    investmentList.replaceChildren();
    if (!investments.length) {
      investmentList.append(node('p', '', 'No investments yet. Choose a tier to join a forming pool.'));
      return;
    }
    for (const investment of investments) {
      const card = node('article', 'investment-card');
      const heading = node('div', 'investment-heading');
      heading.append(node('h3', '', `Tier ${investment.rate}% · Investment #${investment.id}`));
      heading.append(node('span', `status status-${investment.status.toLowerCase()}`, investment.status));
      card.append(heading);
      const facts = node('div', 'investment-facts');
      [
        ['Your contribution', Enormico.money(investment.contribution)],
        ['Pool', `#${investment.pool_id} · ${investment.pool_status}`],
        ['Pool progress', `${Enormico.money(investment.total_amount)} / ${Enormico.money(investment.target_amount)} (${investment.progress_percent}%)`],
        ['Investors', String(investment.investor_count)],
        ['Activation', Enormico.date(investment.activated_at)],
        ['Maturity', Enormico.date(investment.maturity_at)],
        ['Estimated ROI', Enormico.money(investment.roi_amount ?? Math.round(investment.contribution * investment.rate / 100))],
        ['Estimated maturity value', Enormico.money(investment.maturity_amount ?? investment.contribution + Math.round(investment.contribution * investment.rate / 100))]
      ].forEach(([label, value]) => {
        const item = node('div', 'fact');
        item.append(node('span', '', label), node('strong', '', value));
        facts.append(item);
      });
      card.append(facts);
      const progress = node('div', 'pool-track');
      const fill = node('span');
      fill.style.width = `${investment.progress_percent}%`;
      progress.append(fill);
      card.append(progress);

      if (investment.status === 'PENDING') {
        const controls = node('div', 'investment-actions');
        const form = node('form', 'inline-form');
        const input = node('input');
        input.type = 'number';
        input.min = '1';
        input.step = '1';
        input.placeholder = 'Additional contribution';
        input.setAttribute('aria-label', `Additional contribution for investment ${investment.id}`);
        const add = node('button', 'secondary-button', 'Add to pending');
        add.type = 'submit';
        form.append(input, add);
        form.addEventListener('submit', async event => {
          event.preventDefault();
          try {
            await Enormico.api(`/api/investments/${investment.id}/contributions`, { method: 'POST', body: JSON.stringify({ amount: Number(input.value) }) });
            await loadData();
          } catch (error) { Enormico.showMessage(message, error.message, true); }
        });
        controls.append(form, actionButton('Cancel and refund', 'danger-button', async () => {
          if (!confirm('Cancel this pending investment and return the contribution to your available balance?')) return;
          try {
            await Enormico.api(`/api/investments/${investment.id}/cancel`, { method: 'POST', body: '{}' });
            await loadData();
          } catch (error) { Enormico.showMessage(message, error.message, true); }
        }));
        card.append(controls, node('small', 'muted', `Pending pool expires ${Enormico.date(investment.pool_expires_at)}. ROI starts only when the pool activates.`));
      } else if (investment.status === 'ACTIVE') {
        card.append(node('p', 'locked-note', 'Locked while active. Additional contributions, cancellation, and early withdrawal are unavailable.'));
      }
      investmentList.append(card);
    }
  }

  function renderTransactions(transactions) {
    transactionList.replaceChildren();
    if (!transactions.length) {
      const row = node('tr');
      const cell = node('td', '', 'No transactions yet.');
      cell.colSpan = 4;
      row.append(cell);
      transactionList.append(row);
      return;
    }
    for (const transaction of transactions) {
      const row = node('tr');
      row.append(
        node('td', '', Enormico.date(transaction.created_at)),
        node('td', '', transaction.description),
        node('td', '', transaction.direction),
        node('td', '', `${transaction.direction === 'DEBIT' ? '−' : '+'}${Enormico.money(transaction.amount)}`)
      );
      transactionList.append(row);
    }
  }

  function renderNotifications(notifications) {
    notificationList.replaceChildren();
    const unread = notifications.filter(item => !item.read_at).length;
    document.getElementById('unreadCount').textContent = unread ? `(${unread})` : '';
    if (!notifications.length) {
      notificationList.append(node('li', '', 'No notifications yet.'));
      return;
    }
    for (const notification of notifications) {
      const item = node('li', notification.read_at ? 'notification read' : 'notification unread');
      const content = node('div');
      content.append(node('strong', '', notification.type.replaceAll('_', ' ')), node('p', '', notification.message), node('small', 'muted', Enormico.date(notification.created_at)));
      item.append(content);
      if (!notification.read_at) item.append(actionButton('Mark read', 'secondary-button', async () => {
        try {
          await Enormico.api(`/api/notifications/${notification.id}/read`, { method: 'POST', body: '{}' });
          await loadData();
        } catch (error) { Enormico.showMessage(message, error.message, true); }
      }));
      notificationList.append(item);
    }
  }

  async function loadData() {
    const [walletData, investmentsData, transactionsData, notificationData] = await Promise.all([
      Enormico.api('/api/wallet'),
      Enormico.api('/api/investments'),
      Enormico.api('/api/wallet/transactions'),
      Enormico.api('/api/notifications')
    ]);
    document.getElementById('availableBalance').textContent = Enormico.money(walletData.wallet.available_balance);
    document.getElementById('pendingBalance').textContent = Enormico.money(walletData.wallet.pending_balance);
    document.getElementById('investedBalance').textContent = Enormico.money(walletData.wallet.invested_balance);
    renderInvestments(investmentsData.investments);
    renderTransactions(transactionsData.transactions.slice(0, 20));
    renderNotifications(notificationData.notifications);
  }

  try {
    const user = await Enormico.guard();
    if (!user) return;
    document.getElementById('displayName').textContent = user.name;
    document.getElementById('adminLink').hidden = user.role !== 'ADMIN';
    document.getElementById('logoutButton').addEventListener('click', async () => {
      await Enormico.api('/api/auth/logout', { method: 'POST', body: '{}' });
      location.href = 'index.html';
    });
    document.getElementById('depositForm').addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await Enormico.api('/api/wallet/deposits', { method: 'POST', body: JSON.stringify({ amount: Number(document.getElementById('depositAmount').value) }) });
        document.getElementById('depositAmount').value = '';
        Enormico.showMessage(message, 'Simulated funds added to your available balance.');
        await loadData();
      } catch (error) { Enormico.showMessage(message, error.message, true); }
    });
    await loadData();
  } catch (error) {
    Enormico.showMessage(message, error.message, true);
  }
});