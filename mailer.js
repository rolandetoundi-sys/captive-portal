// mailer.js
// Envoi de l'email contenant le code de vérification (OTP) à l'inscription.
// Si les variables SMTP_* ne sont pas configurées, le code est simplement
// affiché dans les logs serveur (pratique en développement local).

const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM = 'Portail Wi-Fi <no-reply@portail-wifi.local>',
} = process.env;

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: SMTP_SECURE === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

async function sendOtpEmail({ to, code, name }) {
  if (!isConfigured()) {
    // Repli développement : pas de SMTP configuré, on trace le code dans les logs.
    console.warn(`⚠️  SMTP non configuré : code OTP pour ${to} = ${code}`);
    return { sent: false };
  }

  const firstName = (name || '').trim().split(' ')[0] || '';
  await getTransporter().sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Votre code de connexion Wi-Fi',
    text: `Bonjour ${firstName},\n\nVotre code de vérification est : ${code}\n\nCe code est valable 10 minutes.`,
    html: `<p>Bonjour ${firstName},</p><p>Votre code de vérification est : <strong style="font-size:20px;letter-spacing:4px;">${code}</strong></p><p>Ce code est valable 10 minutes.</p>`,
  });

  return { sent: true };
}

module.exports = { isConfigured, sendOtpEmail };
