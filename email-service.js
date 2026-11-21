const nodemailer = require('nodemailer');

function emailConfiguration(env = process.env) {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  const from = env.EMAIL_FROM?.trim();
  const port = Number(env.SMTP_PORT || 587);
  if (!host || !user || !password || !from || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE.toLowerCase() === 'true' : port === 465,
    auth: { user, pass: password },
    from
  };
}

function missingEmailSettings(env = process.env) {
  return [
    ['SMTP_HOST', env.SMTP_HOST],
    ['SMTP_USER', env.SMTP_USER],
    ['SMTP_PASSWORD', env.SMTP_PASSWORD],
    ['EMAIL_FROM', env.EMAIL_FROM]
  ].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
}

function classifyEmailError(error) {
  const code = String(error?.code || '').toUpperCase();
  const responseCode = Number(error?.responseCode || 0);
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) return { category: 'authentication', code: code || String(responseCode) };
  if (code.includes('TLS') || code === 'ESOCKET' || code === 'ECERT') return { category: 'TLS/secure connection', code: code || 'ESOCKET' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return { category: 'SMTP connection', code };
  }
  return { category: 'SMTP transport', code: code || 'UNKNOWN' };
}

function createEmailSender(env = process.env, transportFactory = nodemailer.createTransport) {
  const config = emailConfiguration(env);
  if (!config) return null;
  const transport = transportFactory({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: config.auth
  });

  const sendOtpEmail = async function sendOtpEmail(to, code, purpose) {
    const isReset = purpose === 'password-reset';
    const result = await transport.sendMail({
      from: config.from,
      to,
      subject: isReset ? 'Enormico password reset code' : 'Verify your Enormico email',
      text: `Your Enormico ${isReset ? 'password reset' : 'email verification'} code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
    });
    if (Array.isArray(result?.accepted) && !result.accepted.some(recipient => String(recipient).toLowerCase() === to.toLowerCase())) {
      throw new Error('The email provider rejected the recipient.');
    }
  };
  sendOtpEmail.verify = () => transport.verify();
  return sendOtpEmail;
}

module.exports = { emailConfiguration, missingEmailSettings, classifyEmailError, createEmailSender };