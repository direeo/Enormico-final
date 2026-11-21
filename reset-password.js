document.addEventListener('DOMContentLoaded', () => {
  const requestForm = document.getElementById('resetRequestForm');
  const confirmForm = document.getElementById('resetConfirmForm');
  const email = document.getElementById('resetEmail');
  const password = document.getElementById('newPassword');
  const confirmation = document.getElementById('confirmNewPassword');
  const checks = {
    length: value => value.length >= 8,
    upper: value => /[A-Z]/.test(value),
    lower: value => /[a-z]/.test(value),
    number: value => /[0-9]/.test(value),
    special: value => /[^A-Za-z0-9]/.test(value)
  };
  document.querySelectorAll('[data-toggle-password]').forEach(toggle => toggle.addEventListener('click', () => {
    const input = document.getElementById(toggle.dataset.togglePassword);
    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    toggle.textContent = showing ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(showing));
    input.focus();
  }));

  password.addEventListener('input', () => {
    for (const [rule, check] of Object.entries(checks)) {
      const item = document.querySelector(`[data-rule="${rule}"]`);
      const valid = check(password.value);
      item.classList.toggle('valid', valid);
      item.classList.toggle('invalid', password.value.length > 0 && !valid);
    }
  });
  email.value = new URLSearchParams(location.search).get('email') || '';

  requestForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = requestForm.querySelector('button[type="submit"]');
    Enormico.setBusy(button, true, 'Sending...');
    try {
      const result = await Enormico.api('/api/auth/password-reset/request', {
        method: 'POST', body: JSON.stringify({ email: email.value.trim() })
      });
      Enormico.showMessage(document.getElementById('resetRequestMessage'), result.message);
      confirmForm.hidden = false;
      document.getElementById('resetCode').focus();
      Enormico.setBusy(button, false);
    } catch (error) {
      Enormico.showMessage(document.getElementById('resetRequestMessage'), error.message, true);
      Enormico.setBusy(button, false);
    }
  });

  confirmForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = confirmForm.querySelector('button[type="submit"]');
    const message = document.getElementById('resetConfirmMessage');
    const validPassword = Object.values(checks).every(check => check(password.value));
    if (!validPassword) {
      Enormico.showMessage(message, 'Meet all password requirements before continuing.', true);
      password.focus();
      return;
    }
    if (password.value !== confirmation.value) {
      Enormico.showMessage(message, 'Passwords do not match.', true);
      confirmation.focus();
      return;
    }
    Enormico.setBusy(button, true, 'Updating...');
    try {
      const result = await Enormico.api('/api/auth/password-reset/confirm', {
        method: 'POST', body: JSON.stringify({ email: email.value.trim(), code: document.getElementById('resetCode').value.trim(), password: password.value })
      });
      Enormico.showMessage(message, result.message);
      button.disabled = true;
      setTimeout(() => { location.href = 'index.html'; }, 1200);
    } catch (error) {
      Enormico.showMessage(message, error.message, true);
      Enormico.setBusy(button, false);
    }
  });
});
