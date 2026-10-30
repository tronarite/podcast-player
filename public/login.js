const form = document.getElementById('form');
const error = document.getElementById('error');
const submit = document.getElementById('submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    if (r.ok) { location.replace('/'); return; }
    error.textContent = (await r.json().catch(() => ({}))).error || 'No se pudo iniciar sesión';
    form.password.value = '';
    form.password.focus();
  } catch {
    error.textContent = 'No se pudo conectar con el servidor';
  }
  submit.disabled = false;
});
