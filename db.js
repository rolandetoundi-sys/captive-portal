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
  await client.execute(`
    CREATE TABLE IF NOT EXISTS visits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id   INTEGER NOT NULL,
      phone      TEXT NOT NULL,
      mac        TEXT,
      visited_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await client.execute('CREATE INDEX IF NOT EXISTS visits_visited_at_idx ON visits (visited_at)');
  await client.execute(`
    INSERT INTO visits (guest_id, phone, mac, visited_at)
    SELECT guests.id, guests.phone, guests.last_mac, guests.first_seen_at
    FROM guests
    WHERE NOT EXISTS (SELECT 1 FROM visits WHERE visits.guest_id = guests.id)
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

// Crée un nouveau visiteur. Retourne la fiche créée.
async function createGuest({ name, email, phone, mac }) {
  const cleanPhone = normalizePhone(phone);
  await client.execute({
    sql: `INSERT INTO guests (name, email, phone, last_mac, visit_count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    args: [name.trim(), email.trim(), cleanPhone, mac || null],
  });
  const guest = await findByPhone(cleanPhone);
  await recordVisit(guest, mac);
  return guest;
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
  const guest = await findByPhone(cleanPhone);
  if (guest) await recordVisit(guest, mac);
  return guest;
}

async function recordVisit(guest, mac) {
  await client.execute({
    sql: 'INSERT INTO visits (guest_id, phone, mac) VALUES (?, ?, ?)',
    args: [guest.id, guest.phone, mac || null],
  });
}

async function getAdminSummary() {
  const [guests, today] = await Promise.all([
    client.execute('SELECT COUNT(*) AS user_count, COALESCE(SUM(visit_count), 0) AS visit_count FROM guests'),
    client.execute("SELECT COUNT(*) AS visit_count FROM visits WHERE date(visited_at) = date('now')"),
  ]);
  return {
    userCount: Number(guests.rows[0].user_count),
    visitCount: Number(guests.rows[0].visit_count),
    todayVisitCount: Number(today.rows[0].visit_count),
  };
}

async function getAdminDailyStats(days = 30) {
  const result = await client.execute({
    sql: `SELECT date(visited_at) AS day, COUNT(*) AS visits, COUNT(DISTINCT phone) AS visitors
          FROM visits
          WHERE visited_at >= datetime('now', ?)
          GROUP BY date(visited_at)
          ORDER BY day`,
    args: [`-${days} days`],
  });
  return result.rows.map((row) => ({
    day: row.day,
    visits: Number(row.visits),
    visitors: Number(row.visitors),
  }));
}

async function searchAdminGuests({ query = '', limit = 50, offset = 0 } = {}) {
  const pattern = `%${query.trim()}%`;
  const phonePattern = `%${normalizePhone(query)}%`;
  const [countResult, guestsResult] = await Promise.all([
    client.execute({
      sql: 'SELECT COUNT(*) AS total FROM guests WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?',
      args: [pattern, phonePattern, pattern],
    }),
    client.execute({
      sql: `SELECT name, email, phone, last_mac, visit_count, first_seen_at, last_seen_at
            FROM guests
            WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?
            ORDER BY last_seen_at DESC
            LIMIT ? OFFSET ?`,
      args: [pattern, phonePattern, pattern, limit, offset],
    }),
  ]);
  return { total: Number(countResult.rows[0].total), guests: guestsResult.rows };
}

async function getAdminExportGuests(startDate, endDate) {
  const result = await client.execute({
    sql: `SELECT guests.name,
                guests.phone,
                guests.email,
                COALESCE((
                  SELECT selected_visit.mac
                  FROM visits AS selected_visit
                  WHERE selected_visit.guest_id = guests.id
                    AND date(selected_visit.visited_at) BETWEEN ? AND ?
                    AND selected_visit.mac IS NOT NULL
                  ORDER BY selected_visit.visited_at DESC
                  LIMIT 1
                ), '') AS mac,
                COUNT(visits.id) AS visit_count,
                MAX(visits.visited_at) AS last_seen_at
         FROM visits
         JOIN guests ON guests.id = visits.guest_id
         WHERE date(visits.visited_at) BETWEEN ? AND ?
         GROUP BY guests.id
         ORDER BY last_seen_at DESC`,
    args: [startDate, endDate, startDate, endDate],
  });
  return result.rows.map((row) => ({ ...row, visit_count: Number(row.visit_count) }));
}

module.exports = {
  normalizePhone,
  findByPhone,
  createGuest,
  touchGuest,
  getAdminSummary,
  getAdminDailyStats,
  searchAdminGuests,
  getAdminExportGuests,
  init,
};
