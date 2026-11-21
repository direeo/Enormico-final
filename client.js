(function () {
  async function api(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (method === 'POST' && /^\/api\/(wallet\/deposits|investments(?:\/[^/]+\/(?:contributions|cancel))?|pools\/[^/]+\/join)$/.test(url) && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      method,
      headers
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && !url.includes('/api/auth/')) location.href = 'index.html';
      const error = new Error(data.error || 'The request could not be completed.');
      error.fieldErrors = data.fieldErrors || {};
      error.status = response.status;
      error.retryAfter = data.retry_after || null;
      throw error;
    }
    return data;
  }

  async function currentUser() {
    return (await api('/api/auth/me')).user;
  }

  async function guard(admin = false) {
    try {
      const user = await currentUser();
      if (admin && user.role !== 'ADMIN') {
        location.href = 'dashboard.html';
        return null;
      }
      return user;
    } catch {
      location.href = 'index.html';
      return null;
    }
  }

  function money(value) {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function date(value) {
    if (!value) return 'Not started';
    return new Date(Number(value)).toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function showMessage(element, message, error = false) {
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('error', error);
    element.hidden = !message;
  }

  function setBusy(button, busy, busyText = 'Please wait...') {
    if (!button) return;
    if (busy) {
      button.dataset.originalContent = button.innerHTML;
      button.textContent = busyText;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.innerHTML = button.dataset.originalContent || button.textContent;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  window.Enormico = { api, currentUser, guard, money, date, showMessage, setBusy };
})();