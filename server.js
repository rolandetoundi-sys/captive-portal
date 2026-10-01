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
const xlsx = require('./xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const adminDir = path.join(__dirname, 'admin');
const adminSessionTtl = 8 * 60 * 60 * 1000;

function matchesCredential(expected, actual) {
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

function getAdminSession(req) {
  const sessionId = (req.get('cookie') || '').split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('admin_session='))
    ?.slice('admin_session='.length);
  if (!sessionId) return null;

  const match = sessionId.match(/^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || Number(match[1]) <= Date.now()) return null;
  const username = process.env.ADMIN_USERNAME || '';
  const password = process.env.ADMIN_PASSWORD || '';
  const payload = `${match[1]}.${match[2]}`;
  const expectedSignature = crypto.createHmac('sha256', `${username}\0${password}`).update(payload).digest();
  const suppliedSignature = Buffer.from(match[3], 'hex');
  return crypto.timingSafeEqual(expectedSignature, suppliedSignature) ? sessionId : null;
}

function requireAdmin(req, res, next) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    return res.status(503).send('Accès administrateur indisponible : configurez ADMIN_USERNAME et ADMIN_PASSWORD.');
  }

  const sessionId = getAdminSession(req);
  if (sessionId) {
    req.adminSessionId = sessionId;
    return next();
  }

  if (req.baseUrl === '/api/admin') {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  return res.redirect('/admin/login');
}

app.use(express.json());
app.get('/admin/login', (req, res) => res.sendFile(path.join(adminDir, 'login.html')));
app.post('/api/admin/login', (req, res) => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    return res.status(503).json({ error: 'Accès administrateur indisponible.' });
  }

  const suppliedUsername = req.body?.username;
  const suppliedPassword = req.body?.password;
  if (typeof suppliedUsername !== 'string' || typeof suppliedPassword !== 'string'
      || !matchesCredential(username, suppliedUsername)
      || !matchesCredential(password, suppliedPassword)) {
    return res.status(401).json({ error: 'Nom d’utilisateur ou mot de passe incorrect.' });
  }

  const sessionTtl = req.body?.remember === true ? 30 * 24 * 60 * 60 * 1000 : adminSessionTtl;
  const payload = `${Date.now() + sessionTtl}.${crypto.randomBytes(16).toString('hex')}`;
  const signature = crypto.createHmac('sha256', `${username}\0${password}`).update(payload).digest('hex');
  const sessionId = `${payload}.${signature}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `admin_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtl / 1000}${secure}`);
  return res.json({ success: true });
});

app.use('/admin', requireAdmin, express.static(adminDir));
app.use('/api/admin', requireAdmin);
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
// Même portail que /, pour l'URL externe UniFi (ex. /guest/default/?id=...&ap=...).
app.use('/guest/s/default', express.static(publicDir));

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPhone = (phone) => /^\+?[0-9]{6,15}$/.test(db.normalizePhone(phone));

// --- Diagnostic simple, utile en phase d'installation ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health/unifi', async (req, res) => {
  const result = await unifi.healthCheck();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/api/admin/summary', async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const [summary, daily] = await Promise.all([
      db.getAdminSummary(),
      db.getAdminDailyStats(days),
    ]);
    res.json({ summary, daily });
  } catch (err) {
    console.error('Erreur statistiques administrateur:', err);
    res.status(500).json({ error: 'Impossible de charger les statistiques.' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const query = String(req.query.q || '').trim().slice(0, 120);
    const result = await db.searchAdminGuests({ query, limit: 50, offset: (page - 1) * 50 });
    res.json({ ...result, page, pageSize: 50 });
  } catch (err) {
    console.error('Erreur utilisateurs administrateur:', err);
    res.status(500).json({ error: 'Impossible de charger les utilisateurs.' });
  }
});

app.get('/api/admin/export.xlsx', async (req, res) => {
  const startDate = String(req.query.from || '');
  const endDate = String(req.query.to || '');
  const isValidDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };

  if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
    return res.status(400).json({ error: 'Choisissez une période valide.' });
  }

  try {
    const guests = await db.getAdminExportGuests(startDate, endDate);
    const workbook = xlsx.createWorkbook(guests);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="connexions-${startDate}-${endDate}.xlsx"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(workbook);
  } catch (err) {
    console.error('Erreur export administrateur:', err);
    res.status(500).json({ error: "Impossible de générer le fichier Excel." });
  }
});

// --- 1) L'utilisateur entre son numéro : a-t-on déjà sa fiche ? ---
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

// --- 2a) Nouveau visiteur : formulaire complet (nom, email, tél) ---
app.post('/api/register', async (req, res) => {
  const { name, email, phone, clientMac, apMac } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Le nom est requis.' });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!isValidPhone(phone || '')) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }

  let guest;
  try {
    const existing = await db.findByPhone(phone);
    guest = existing ? await db.touchGuest(phone, clientMac) : await db.createGuest({ name, email, phone, mac: clientMac });
  } catch (err) {
    console.error('Erreur base de données (register):', err);
    return res.status(500).json({ error: "Impossible d'enregistrer vos informations." });
  }

  let authorized = false;
  let authError = null;
  try {
    await unifi.authorizeGuestByMac(clientMac, { apMac });
    authorized = true;
  } catch (err) {
    authError = err.message;
    console.error('Erreur autorisation UniFi (register):', err.message);
  }

  res.json({
    success: true,
    authorized,
    authError: authorized ? undefined : authError,
    firstName: guest.name.split(' ')[0],
  });
});

// --- 2b) Visiteur connu : juste le téléphone -> "bon retour" ---
app.post('/api/checkin', async (req, res) => {
  const { phone, clientMac, apMac } = req.body || {};

  if (!isValidPhone(phone || '')) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }

  const existing = await db.findByPhone(phone);
  if (!existing) {
    // Cas limite (ex: fiche supprimée entre-temps) : le front doit basculer
    // sur le formulaire complet plutôt que d'afficher une erreur sèche.
    return res.status(404).json({ error: 'Aucune fiche trouvée pour ce numéro.' });
  }

  const guest = await db.touchGuest(phone, clientMac);

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
  });
}).catch((err) => {
  console.error('Erreur initialisation base de données:', err);
  process.exit(1);
});
