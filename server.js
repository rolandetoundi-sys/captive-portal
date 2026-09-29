// server.js
// Portail captif : sert la page statique (public/) et expose l'API utilisée
// par le formulaire (recherche visiteur, inscription, retour) qui déclenche
// l'autorisation réseau côté contrôleur UniFi.

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const unifi = require('./unifi');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
// Même portail que /, pour l'URL externe UniFi (ex. /guest/default/?id=...&ap=...).
app.use('/guest/s/default', express.static(publicDir));

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPhone = (phone) => /^\+?[0-9]{6,15}$/.test(db.normalizePhone(phone));

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

// Inscriptions en attente de validation OTP, en mémoire (le temps de saisir le code).
// clé = téléphone normalisé.
const pendingRegistrations = new Map();

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function cleanupExpiredOtps() {
  const now = Date.now();
  for (const [phone, entry] of pendingRegistrations) {
    if (entry.expiresAt < now) pendingRegistrations.delete(phone);
  }
}

// --- Diagnostic simple, utile en phase d'installation ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health/unifi', async (req, res) => {
  const result = await unifi.healthCheck();
  res.status(result.ok ? 200 : 503).json(result);
});

// --- Première connexion, étape 1 : le numéro est-il déjà enregistré ? ---
app.post('/api/lookup', async (req, res) => {
  const { phone } = req.body || {};

  if (!isValidPhone(phone || '')) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }

  const guest = await db.findByPhone(phone);
  if (guest) {
    return res.json({ found: true, firstName: guest.name.split(' ')[0] });
  }
  return res.json({ found: false });
});

// --- Première connexion, étape 2 : nom + email (requis) -> envoi du code OTP ---
app.post('/api/register/start', async (req, res) => {
  const { name, email, phone, clientMac, apMac } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Le nom est requis.' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Une adresse email valide est requise.' });
  }
  if (!isValidPhone(phone || '')) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }

  const cleanPhone = db.normalizePhone(phone);

  const existing = await db.findByPhone(cleanPhone);
  if (existing) {
    return res.status(409).json({ error: 'Ce numéro est déjà enregistré. Utilisez « Déjà enregistré ».' });
  }

  cleanupExpiredOtps();

  const code = generateOtp();
  pendingRegistrations.set(cleanPhone, {
    name: name.trim(),
    email: email.trim(),
    phone: cleanPhone,
    clientMac: clientMac || null,
    apMac: apMac || null,
    code,
    attempts: 0,
    expiresAt: Date.now() + OTP_TTL_MS,
  });

  try {
    await mailer.sendOtpEmail({ to: email.trim(), code, name: name.trim() });
  } catch (err) {
    console.error('Erreur envoi email OTP:', err.message);
    pendingRegistrations.delete(cleanPhone);
    return res.status(502).json({ error: "Impossible d'envoyer l'email de vérification. Vérifiez l'adresse saisie." });
  }

  res.json({ success: true });
});

// --- Première connexion, étape 3 : validation du code reçu par email ---
app.post('/api/register/verify', async (req, res) => {
  const { phone, code } = req.body || {};
  const cleanPhone = db.normalizePhone(phone || '');
  const pending = pendingRegistrations.get(cleanPhone);

  if (!pending) {
    return res.status(400).json({ error: "Aucune demande en cours pour ce numéro. Merci de recommencer." });
  }
  if (pending.expiresAt < Date.now()) {
    pendingRegistrations.delete(cleanPhone);
    return res.status(400).json({ error: 'Le code a expiré. Merci de redemander un code.' });
  }
  if (!code || String(code).trim() !== pending.code) {
    pending.attempts += 1;
    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      pendingRegistrations.delete(cleanPhone);
      return res.status(400).json({ error: 'Trop de tentatives. Merci de redemander un code.' });
    }
    return res.status(400).json({ error: 'Code incorrect.' });
  }

  pendingRegistrations.delete(cleanPhone);

  let guest;
  try {
    guest = await db.createGuest({
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      mac: pending.clientMac,
    });
  } catch (err) {
    console.error('Erreur base de données (register/verify):', err);
    return res.status(500).json({ error: "Impossible d'enregistrer vos informations." });
  }

  let authorized = false;
  let authError = null;
  try {
    await unifi.authorizeGuestByMac(pending.clientMac, { apMac: pending.apMac });
    authorized = true;
  } catch (err) {
    authError = err.message;
    console.error('Erreur autorisation UniFi (register/verify):', err.message);
  }

  res.json({
    success: true,
    authorized,
    authError: authorized ? undefined : authError,
    firstName: guest.name.split(' ')[0],
  });
});

// --- Première connexion : renvoyer un nouveau code ---
app.post('/api/register/resend', async (req, res) => {
  const { phone } = req.body || {};
  const cleanPhone = db.normalizePhone(phone || '');
  const pending = pendingRegistrations.get(cleanPhone);

  if (!pending) {
    return res.status(400).json({ error: "Aucune demande en cours pour ce numéro. Merci de recommencer." });
  }

  pending.code = generateOtp();
  pending.attempts = 0;
  pending.expiresAt = Date.now() + OTP_TTL_MS;

  try {
    await mailer.sendOtpEmail({ to: pending.email, code: pending.code, name: pending.name });
  } catch (err) {
    console.error('Erreur envoi email OTP (resend):', err.message);
    return res.status(502).json({ error: "Impossible d'envoyer l'email de vérification." });
  }

  res.json({ success: true });
});

// --- Déjà enregistré : identification par nom OU email, sans téléphone ---
app.post('/api/checkin', async (req, res) => {
  const { identifier, clientMac, apMac } = req.body || {};

  if (!identifier || !identifier.trim()) {
    return res.status(400).json({ error: 'Merci de saisir votre numéro de téléphone ou votre email.' });
  }

  const { guest: existing } = await db.findByIdentifier(identifier);

  if (!existing) {
    return res.status(404).json({ error: 'Aucun compte trouvé. Utilisez « Première connexion » si c\'est votre première visite.' });
  }

  const guest = await db.touchGuest(existing.phone, clientMac);

  let authorized = false;
  let authError = null;
  try {
    await unifi.authorizeGuestByMac(clientMac, { apMac });
    authorized = true;
  } catch (err) {
    authError = err.message;
    console.error('Erreur autorisation UniFi (checkin):', err.message);
  }

  res.json({
    success: true,
    authorized,
    authError: authorized ? undefined : authError,
    firstName: guest.name.split(' ')[0],
  });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Portail captif démarré sur le port ${PORT}`);
    if (!unifi.isConfigured()) {
      console.warn('⚠️  Variables UNIFI_* non configurées : les visiteurs seront enregistrés mais pas autorisés automatiquement.');
    }
    if (!mailer.isConfigured()) {
      console.warn('⚠️  Variables SMTP_* non configurées : les codes OTP seront seulement affichés dans les logs.');
    }
  });
}).catch((err) => {
  console.error('Erreur initialisation base de données:', err);
  process.exit(1);
});

