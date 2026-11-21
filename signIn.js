document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('loginForm');
  const message = document.getElementById('loginError');
  const submit = form.querySelector('button[type="submit"]');

  try {
    const { user } = await Enormico.api('/api/auth/me');
    location.href = user.role === 'ADMIN' ? 'admin.html' : 'home.html';
    return;
  } catch {
    // A missing session is the normal signed-out state.
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    Enormico.showMessage(message, '');
    submit.disabled = true;
    try {
      const data = await Enormico.api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identity: document.getElementById('username').value.trim(),
          password: document.getElementById('loginPassword').value
        })
      });
      location.href = data.user.role === 'ADMIN' ? 'admin.html' : 'home.html';
    } catch (error) {
      Enormico.showMessage(message, error.message, true);
      submit.disabled = false;
    }
  });
});