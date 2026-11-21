document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('registerForm');
  const submit = form.querySelector('button[type="submit"]');
  const password = document.getElementById('password');
  const confirmation = document.getElementById('confirmPassword');
  const requirementChecks = [
    ['requireLength', value => value.length >= 8],
    ['requireUpper', value => /[A-Z]/.test(value)],
    ['requireLower', value => /[a-z]/.test(value)],
    ['requireNumber', value => /[0-9]/.test(value)],
    ['requireSpecial', value => /[^A-Za-z0-9]/.test(value)]
  ];
  const fieldIds = { name: 'fullName', email: 'email', username: 'newUsername', password: 'password', dob: 'dob' };
  const fieldErrorIds = { name: 'nameError', email: 'emailError', username: 'usernameError', password: 'passwordError', dob: 'dobError', confirmPassword: 'confirmPasswordError' };

  function showFieldError(field, message) {
    const input = document.getElementById(fieldIds[field] || field);
    const error = document.getElementById(fieldErrorIds[field] || `${field}Error`);
    if (error) error.textContent = message || '';
    if (input) {
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${error?.id || ''}`.trim());
    }
  }

  function passwordStatus(value) {
    return requirementChecks.every(([id, check]) => {
      const valid = check(value);
      const item = document.getElementById(id);
      item.classList.toggle('valid', valid);
      item.classList.toggle('invalid', value.length > 0 && !valid);
      item.setAttribute('aria-label', `${valid ? 'Satisfied' : 'Not yet satisfied'}: ${item.textContent}`);
      return valid;
    });
  }

  function validatePasswordFields() {
    const validPassword = passwordStatus(password.value);
    const matches = confirmation.value.length > 0 && confirmation.value === password.value;
    showFieldError('password', password.value && !validPassword ? 'Meet all five password requirements.' : '');
    showFieldError('confirmPassword', confirmation.value && !matches ? 'Passwords do not match.' : '');
    return validPassword && matches;
  }

  function validateDob() {
    const value = document.getElementById('dob').value;
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      showFieldError('dob', 'Enter a valid date of birth.');
      return false;
    }
    const [year, month, day] = value.split('-').map(Number);
    const birth = new Date(Date.UTC(year, month - 1, day));
    if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) {
      showFieldError('dob', 'Enter a valid date of birth.');
      return false;
    }
    const today = new Date();
    const currentYear = today.getUTCFullYear();
    const currentMonth = today.getUTCMonth() + 1;
    const currentDay = today.getUTCDate();
    if (year > currentYear || (year === currentYear && (month > currentMonth || (month === currentMonth && day > currentDay)))) {
      showFieldError('dob', 'Date of birth cannot be in the future.');
      return false;
    }
    const age = currentYear - year - (currentMonth < month || (currentMonth === month && currentDay < day) ? 1 : 0);
    showFieldError('dob', age < 18 ? 'You must be at least 18 years old to register.' : '');
    return age >= 18;
  }

  document.querySelectorAll('[data-toggle-password]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.dataset.togglePassword);
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      toggle.textContent = showing ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(showing));
      toggle.setAttribute('aria-label', `${showing ? 'Hide' : 'Show'} ${input.id === 'password' ? 'password' : 'confirmation password'}`);
      input.focus();
    });
  });

  password.addEventListener('input', validatePasswordFields);
  confirmation.addEventListener('input', validatePasswordFields);
  document.getElementById('dob').addEventListener('change', validateDob);
  Object.values(fieldIds).forEach(id => document.getElementById(id).addEventListener('input', () => showFieldError(id === 'fullName' ? 'name' : id === 'newUsername' ? 'username' : id, '')));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    Enormico.showMessage(document.getElementById('registerError'), '');
    document.querySelectorAll('.field-error').forEach(element => { element.textContent = ''; });
    if (!validatePasswordFields()) {
      if (!passwordStatus(password.value)) password.focus();
      else confirmation.focus();
      return;
    }
    if (!validateDob()) {
      document.getElementById('dob').focus();
      return;
    }

    Enormico.setBusy(submit, true, 'Sending verification code...');
    try {
      const result = await Enormico.api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: form.elements.name.value.trim(),
          email: form.elements.email.value.trim(),
          username: form.elements.username.value.trim(),
          password: password.value,
          phone: form.elements.phone.value.trim(),
          dob: form.elements.dob.value
        })
      });
      location.href = `verify.html?email=${encodeURIComponent(result.email)}&resend_after=${result.resend_after}`;
    } catch (error) {
      for (const [field, detail] of Object.entries(error.fieldErrors || {})) showFieldError(field, detail);
      Enormico.showMessage(document.getElementById('registerError'), error.message, true);
      Enormico.setBusy(submit, false);
    }
  });
});