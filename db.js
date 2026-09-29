// db.js
// Accès à la base de données via @libsql/client.
// En local : fichier SQLite (TURSO_DATABASE_URL=file:./data/guests.db)
// En production Vercel : base Turso cloud (libsql://....turso.io)

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

const dbUrl = process.env.TURSO_DATABASE_URL || 'file:./data/guests.db';

// En mode fichier local, s'assure que le dossier existe.
if (dbUrl.startsWith('file:')) {
  const filePath = dbUrl.slice('file:'.length);
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

const client = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function init() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS guests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL DEFAULT '',
      phone         TEXT NOT NULL UNIQUE,
      last_mac      TEXT,
      visit_count   INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// Normalise un numéro de téléphone pour la comparaison / le stockage :
// on retire espaces, points, tirets et parenthèses, mais on garde le "+".
function normalizePhone(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/[\s().-]/g, '');
}

async function findByPhone(phone) {
  const result = await client.execute({
    sql: 'SELECT * FROM guests WHERE phone = ?',
    args: [normalizePhone(phone)],
  });
  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await client.execute({
    sql: 'SELECT * FROM guests WHERE lower(email) = lower(?)',
    args: [(email || '').trim()],
  });
  return result.rows[0] || null;
}

// Retrouve un visiteur déjà enregistré à partir de son numéro de téléphone
// OU de son email (utilisé par le flux "déjà enregistré").
async function findByIdentifier(identifier) {
  const value = (identifier || '').trim();
  if (!value) return { guest: null, ambiguous: false };

  if (value.includes('@')) {
    return { guest: await findByEmail(value), ambiguous: false };
  }

  return { guest: await findByPhone(value), ambiguous: false };
}

// Crée un nouveau visiteur. Retourne la fiche créée.
async function createGuest({ name, email, phone, mac }) {
  const cleanPhone = normalizePhone(phone);
  await client.execute({
    sql: `INSERT INTO guests (name, email, phone, last_mac, visit_count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    args: [name.trim(), email.trim(), cleanPhone, mac || null],
  });
  return findByPhone(cleanPhone);
}

// Met à jour un visiteur existant (nouvelle visite). Retourne la fiche à jour.
async function touchGuest(phone, mac) {
  const cleanPhone = normalizePhone(phone);
  await client.execute({
    sql: `UPDATE guests
          SET visit_count = visit_count + 1,
              last_seen_at = datetime('now'),
              last_mac = COALESCE(?, last_mac)
          WHERE phone = ?`,
    args: [mac || null, cleanPhone],
  });
  return findByPhone(cleanPhone);
}

module.exports = { normalizePhone, findByPhone, findByEmail, findByIdentifier, createGuest, touchGuest, init };
