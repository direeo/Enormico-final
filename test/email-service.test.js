const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailSender } = require('../email-service');

const config = {
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'mailer',
  SMTP_PASSWORD: 'smtp-secret-for-test', EMAIL_FROM: 'Enormico <no-reply@example.test>'
};

test('SMTP email sender sends verification and reset messages through configured transport', async () => {
  const messages = [];
  const sender = createEmailSender(config, transportOptions => ({
    options: transportOptions,
    async sendMail(message) { messages.push(message); return { accepted: [message.to] }; }
  }));
  await sender('person@example.test', '123456', 'registration');
  await sender('person@example.test', '654321', 'password-reset');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].to, 'person@example.test');
  assert.match(messages[0].subject, /verify/i);
  assert.match(messages[0].text, /123456/);
  assert.match(messages[1].subject, /reset/i);
  assert.match(messages[1].text, /654321/);
});

test('SMTP email sender reports a provider recipient rejection as delivery failure', async () => {
  const sender = createEmailSender(config, () => ({ async sendMail() { return { accepted: [], rejected: ['person@example.test'] }; } }));
  await assert.rejects(sender('person@example.test', '123456', 'registration'), /rejected/);
});

test('SMTP sender exposes transporter verification and propagates a connection/auth failure', async () => {
  let verified = false;
  const sender = createEmailSender(config, () => ({
    async verify() { verified = true; },
    async sendMail(message) { return { accepted: [message.to] }; }
  }));
  await sender.verify();
  assert.equal(verified, true);

  const broken = createEmailSender(config, () => ({
    async verify() { throw Object.assign(new Error('secret-bearing provider response'), { code: 'EAUTH' }); },
    async sendMail() { throw new Error('not used'); }
  }));
  await assert.rejects(broken.verify(), /secret-bearing/);
});
