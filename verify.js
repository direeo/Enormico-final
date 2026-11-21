document.addEventListener('DOMContentLoaded', () => {
  const email = new URLSearchParams(location.search).get('email')?.trim().toLowerCase() || '';
  const form = document.getElementById('verifyForm');
  const submit = form.querySelector('button[type="submit"]');
  const resend = document.getElementById('resendCode');
  const message = document.getElementById('verifyMessage');
  document.getElementById('verificationEmail').textContent = email;
  let resendAt = Number(new URLSearchParams(location.search).get('resend_after')) || 0;
  let countdown;

  function updateResend() {
    const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    resend.disabled = seconds > 0;
    resend.textContent = seconds ? `Resend code in ${seconds}s` : 'Resend code';
    if (!seconds && countdown) {
      clearInterval(countdown);
      countdown = null;
    }
  }

  function startCountdown(timestamp) {
    resendAt = Number(timestamp) || 0;
    updateResend();
    if (!countdown && resend.disabled) countdown = setInterval(updateResend, 1000);
  }

  startCountdown(resendAt);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    Enormico.showMessage(message, '');
    Enormico.setBusy(submit, true, 'Verifying...');
    try {
      await Enormico.api('/api/auth/verify-otp', {
        method: 'POST', body: JSON.stringify({ email, code: form.elements.code.value.trim() })
      });
      Enormico.showMessage(message, 'Email verified. Your account is ready.');
      location.href = 'home.html';
    } catch (error) {
      Enormico.showMessage(message, error.message, true);
      Enormico.setBusy(submit, false);
    }
  });

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    Enormico.showMessage(message, 'Sending a new code...');
    try {
      const result = await Enormico.api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email }) });
      Enormico.showMessage(message, result.message);
      startCountdown(result.resend_after || Date.now());
    } catch (error) {
      Enormico.showMessage(message, error.message, true);
      startCountdown(error.retryAfter || Date.now());
    }
  });
});
