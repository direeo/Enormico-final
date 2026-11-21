document.addEventListener('DOMContentLoaded', async () => {
  const planSelect = document.getElementById('planSelect');
  const amountInput = document.getElementById('amount');
  const poolSelect = document.getElementById('poolSelect');
  const estimate = document.getElementById('estimate');
  const message = document.getElementById('actionMessage');
  const investButton = document.getElementById('investButton');
  let plans = [];
  let pools = [];
  let estimateTimer;

  async function loadPage() {
    const user = await Enormico.guard();
    if (!user) return;
    const [planData, walletData, poolData] = await Promise.all([
      Enormico.api('/api/plans'),
      Enormico.api('/api/wallet'),
      Enormico.api('/api/pools')
    ]);
    plans = planData.plans;
    pools = poolData.pools;
    document.getElementById('availableBalance').textContent = Enormico.money(walletData.wallet.available_balance);
    planSelect.innerHTML = '<option value="" selected disabled>Select a tier</option>' + plans.map(plan =>
      `<option value="${plan.rate}">Tier ${plan.rate}% · ${plan.duration_days} days · ${Enormico.money(plan.minimum)}–${Enormico.money(plan.maximum)}</option>`
    ).join('');
    renderPools();
  }

  function renderPools() {
    const selectedRate = Number(planSelect.value);
    const forming = pools.filter(pool => pool.status === 'FORMING' && pool.rate === selectedRate);
    poolSelect.innerHTML = '<option value="">Automatically choose or create a forming pool</option>' + forming.map(pool =>
      `<option value="${pool.id}">Pool #${pool.id} · ${Enormico.money(pool.total_amount)} / ${Enormico.money(pool.target_amount)}</option>`
    ).join('');

    const visible = pools;
    const list = document.getElementById('poolList');
    if (!visible.length) {
      list.innerHTML = '<li>No open pools yet. A pool will be created when you make an investment.</li>';
      return;
    }
    list.innerHTML = visible.map(pool => `<li class="pool-row">
      <div><strong>Pool #${pool.id} · Tier ${pool.rate}%</strong><span>${pool.status} · ${pool.investor_count} investors · ${pool.progress_percent}%</span></div>
      <div class="pool-track" aria-label="${pool.progress_percent}% full"><span style="width:${pool.progress_percent}%"></span></div>
      <div class="pool-facts"><span>${Enormico.money(pool.total_amount)} of ${Enormico.money(pool.target_amount)}</span><span>Your contribution: ${Enormico.money(pool.my_contribution)}</span></div>
      <small>${pool.status === 'FORMING' ? `Expires ${Enormico.date(pool.expires_at)}` : `Activated ${Enormico.date(pool.activated_at)}`}</small>
    </li>`).join('');
  }

  async function refreshPools() {
    pools = (await Enormico.api('/api/pools')).pools;
    renderPools();
  }

  async function updateEstimate() {
    clearTimeout(estimateTimer);
    const amount = Number(amountInput.value);
    const rate = Number(planSelect.value);
    investButton.disabled = true;
    if (!rate || !Number.isSafeInteger(amount) || amount <= 0) {
      estimate.textContent = 'Choose a tier and enter an amount to view your estimated return.';
      return;
    }
    estimateTimer = setTimeout(async () => {
      try {
        const { estimate: result } = await Enormico.api(`/api/plans/${rate}/estimate`, {
          method: 'POST', body: JSON.stringify({ amount })
        });
        estimate.textContent = `${result.rate}% ROI over ${result.duration_days} days · Estimated ROI ${Enormico.money(result.roi)} · Estimated maturity ${Enormico.money(result.maturity_amount)}. ROI starts only when the pool activates.`;
        investButton.disabled = false;
      } catch (error) {
        estimate.textContent = error.message;
      }
    }, 180);
  }

  planSelect.addEventListener('change', () => { renderPools(); updateEstimate(); });
  amountInput.addEventListener('input', updateEstimate);
  document.getElementById('refreshPools').addEventListener('click', async () => {
    try { await refreshPools(); } catch (error) { Enormico.showMessage(message, error.message, true); }
  });
  investButton.addEventListener('click', async () => {
    investButton.disabled = true;
    Enormico.showMessage(message, '');
    const poolId = poolSelect.value;
    const rate = Number(planSelect.value);
    const amount = Number(amountInput.value);
    try {
      const result = poolId
        ? await Enormico.api(`/api/pools/${poolId}/join`, { method: 'POST', body: JSON.stringify({ amount }) })
        : await Enormico.api('/api/investments', { method: 'POST', body: JSON.stringify({ plan_rate: rate, amount }) });
      Enormico.showMessage(message, `Investment #${result.investment.id} created. Current status: ${result.investment.status}.`);
      await Promise.all([refreshPools(), loadPage()]);
      amountInput.value = '';
      updateEstimate();
    } catch (error) {
      Enormico.showMessage(message, error.message, true);
      investButton.disabled = false;
    }
  });

  try {
    await loadPage();
  } catch (error) {
    Enormico.showMessage(message, error.message, true);
  }
});