document.addEventListener('DOMContentLoaded', async () => {
  const user = await Enormico.guard();
  if (!user) return;
  document.getElementById('userName').textContent = user.name;
  const adminLink = document.getElementById('adminLink');
  if (adminLink) adminLink.hidden = user.role !== 'ADMIN';
  document.getElementById('logoutLink').addEventListener('click', async event => {
    event.preventDefault();
    try {
      await Enormico.api('/api/auth/logout', { method: 'POST', body: '{}' });
    } finally {
      location.href = 'index.html';
    }
  });
});