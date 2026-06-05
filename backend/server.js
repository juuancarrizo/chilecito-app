const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3003;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'chilecito.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SUPER_SECRET = process.env.SUPER_SECRET || 'chilecito2024admin';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS owners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    is_superadmin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    icon TEXT DEFAULT '🏟️',
    active INTEGER DEFAULT 1,
    order_num INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS venues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES owners(id),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    city TEXT DEFAULT 'Chilecito',
    address TEXT,
    phone TEXT,
    whatsapp TEXT,
    description TEXT,
    cover_image TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS courts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    sport TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    surface TEXT,
    covered INTEGER DEFAULT 0,
    wall_material TEXT,
    price_per_hour REAL,
    active INTEGER DEFAULT 1,
    order_num INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS court_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    order_num INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS venue_amenities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '✨',
    bookable INTEGER DEFAULT 0,
    price REAL
  );

  CREATE TABLE IF NOT EXISTS occupied_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    label TEXT DEFAULT 'Reservado',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS search_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT,
    city TEXT,
    date_searched TEXT,
    time_searched TEXT,
    results_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migraciones para tablas que pueden ya existir
try { db.exec(`ALTER TABLE owners ADD COLUMN is_superadmin INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE venues ADD COLUMN city TEXT DEFAULT 'Chilecito'`); } catch {}

// Seed deportes si la tabla está vacía
const sportsCount = db.prepare('SELECT COUNT(*) as c FROM sports').get().c;
if (!sportsCount) {
  const ins = db.prepare('INSERT OR IGNORE INTO sports (key, label, icon, active, order_num) VALUES (?,?,?,?,?)');
  [
    ['padel',    'Pádel',     '🎾', 1, 1],
    ['futbol5',  'Fútbol 5',  '⚽', 1, 2],
    ['futbol7',  'Fútbol 7',  '⚽', 1, 3],
    ['futbol11', 'Fútbol 11', '🏟️', 1, 4],
    ['hockey',   'Hockey',    '🏑', 1, 5],
    ['voley',    'Vóley',     '🏐', 1, 6],
  ].forEach(r => ins.run(...r));
}

// Actualizar city de venues existentes que no la tienen
db.prepare(`UPDATE venues SET city = 'Chilecito' WHERE city IS NULL OR city = ''`).run();

// Sessions
const sessions = new Map();
function createSession(ownerId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ownerId, created: Date.now() });
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.created > 7 * 24 * 60 * 60 * 1000) { sessions.delete(token); return null; }
  return s;
}
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'chilecito_salt_2024').digest('hex');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('Solo imágenes')); } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(UPLOADS_DIR));

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  const session = token ? getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'No autenticado' });
  req.ownerId = session.ownerId;
  next();
}
function requireSuper(req, res, next) {
  requireAuth(req, res, () => {
    const owner = db.prepare('SELECT * FROM owners WHERE id = ?').get(req.ownerId);
    if (!owner?.is_superadmin) return res.status(403).json({ error: 'Acceso solo para super admin' });
    req.owner = owner;
    next();
  });
}
function requireAuthAndVenue(req, res, next) {
  requireAuth(req, res, () => {
    const venue = db.prepare('SELECT * FROM venues WHERE owner_id = ?').get(req.ownerId);
    if (!venue) return res.status(404).json({ error: 'No tenés un complejo configurado' });
    req.venue = venue;
    next();
  });
}

// ── AUTH ──────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get((email || '').toLowerCase().trim());
  if (!owner || owner.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  res.json({ token: createSession(owner.id), owner: { id: owner.id, email: owner.email, name: owner.name, is_superadmin: owner.is_superadmin } });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const r = db.prepare('INSERT INTO owners (email, password_hash, name) VALUES (?,?,?)').run((email).toLowerCase().trim(), hashPassword(password), name || '');
    res.json({ token: createSession(r.lastInsertRowid), owner: { id: r.lastInsertRowid, email, name, is_superadmin: 0 } });
  } catch { res.status(409).json({ error: 'Ya existe una cuenta con ese email' }); }
});

// Crear super admin (requiere secret)
app.post('/api/auth/register-super', (req, res) => {
  const { email, password, name, secret } = req.body;
  if (secret !== SUPER_SECRET) return res.status(403).json({ error: 'Secret incorrecto' });
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const r = db.prepare('INSERT INTO owners (email, password_hash, name, is_superadmin) VALUES (?,?,?,1)').run((email).toLowerCase().trim(), hashPassword(password), name || 'Super Admin');
    res.json({ token: createSession(r.lastInsertRowid), owner: { id: r.lastInsertRowid, email, name, is_superadmin: 1 } });
  } catch {
    // Si ya existe, solo marcarlo como superadmin
    db.prepare('UPDATE owners SET is_superadmin = 1 WHERE email = ?').run((email).toLowerCase().trim());
    const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get((email).toLowerCase().trim());
    res.json({ token: createSession(owner.id), owner: { id: owner.id, email: owner.email, name: owner.name, is_superadmin: 1 } });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const owner = db.prepare('SELECT id, email, name, is_superadmin FROM owners WHERE id = ?').get(req.ownerId);
  const venue = db.prepare('SELECT * FROM venues WHERE owner_id = ?').get(req.ownerId);
  res.json({ owner, venue });
});

// ── PÚBLICO — SPORTS ──────────────────────────────────────────

app.get('/api/sports', (req, res) => {
  const sports = db.prepare('SELECT * FROM sports WHERE active = 1 ORDER BY order_num, label').all();
  res.json(sports);
});

// ── PÚBLICO — BÚSQUEDA ────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const { sport, date, start_time, duration = 60, city = '' } = req.query;
  if (!sport || !date || !start_time) return res.status(400).json({ error: 'sport, date y start_time requeridos' });

  const [h, m] = start_time.split(':').map(Number);
  const endMins = h * 60 + m + parseInt(duration);
  const end_time = `${String(Math.floor(endMins / 60)).padStart(2,'0')}:${String(endMins % 60).padStart(2,'0')}`;

  const cityFilter = city ? ' AND v.city = ?' : '';
  const params = city ? [sport, date, end_time, start_time, city] : [sport, date, end_time, start_time];

  const available = db.prepare(`
    SELECT c.*, v.name as venue_name, v.slug as venue_slug, v.city as venue_city,
           v.address as venue_address, v.phone as venue_phone, v.whatsapp as venue_whatsapp
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE c.sport = ? AND c.active = 1 AND v.active = 1 ${cityFilter}
    AND NOT EXISTS (
      SELECT 1 FROM occupied_slots os
      WHERE os.court_id = c.id AND os.date = ? AND os.start_time < ? AND os.end_time > ?
    )
    ORDER BY c.price_per_hour, c.name
  `).all(...params);

  // Log de búsqueda
  db.prepare('INSERT INTO search_logs (sport, city, date_searched, time_searched, results_count) VALUES (?,?,?,?,?)')
    .run(sport, city || 'Chilecito', date, start_time, available.length);

  // Sugerencias si no hay disponibles
  let suggestions = [];
  if (!available.length) {
    for (let delta = -180; delta <= 180; delta += 60) {
      if (delta === 0) continue;
      const baseM = h * 60 + m + delta;
      if (baseM < 6 * 60 || baseM > 23 * 60) continue;
      const sT = `${String(Math.floor(baseM / 60)).padStart(2,'0')}:${String(baseM % 60).padStart(2,'0')}`;
      const eM = baseM + parseInt(duration);
      const eT = `${String(Math.floor(eM / 60)).padStart(2,'0')}:${String(eM % 60).padStart(2,'0')}`;
      const courts = db.prepare(`
        SELECT c.id FROM courts c JOIN venues v ON v.id = c.venue_id
        WHERE c.sport = ? AND c.active = 1 AND v.active = 1 ${cityFilter}
        AND NOT EXISTS (SELECT 1 FROM occupied_slots os WHERE os.court_id = c.id AND os.date = ? AND os.start_time < ? AND os.end_time > ?)
        LIMIT 5
      `).all(...(city ? [sport, city, date, eT, sT] : [sport, date, eT, sT]));
      if (courts.length) suggestions.push({ time: sT, delta, count: courts.length });
    }
    suggestions = suggestions.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 4);
  }

  for (const c of available) {
    c.images = db.prepare('SELECT * FROM court_images WHERE court_id = ? ORDER BY order_num LIMIT 3').all(c.id);
  }

  res.json({ available, suggestions, search: { sport, date, start_time, end_time, city } });
});

// ── PÚBLICO — VENUES ──────────────────────────────────────────

app.get('/api/venues', (req, res) => {
  res.json(db.prepare('SELECT id, name, slug, city, address, description, cover_image FROM venues WHERE active=1 ORDER BY name').all());
});

app.get('/api/venues/:slug', (req, res) => {
  const v = db.prepare('SELECT * FROM venues WHERE slug=? AND active=1').get(req.params.slug);
  if (!v) return res.status(404).json({ error: 'Complejo no encontrado' });

  // Log page view
  db.prepare('INSERT INTO page_views (venue_id) VALUES (?)').run(v.id);

  const courts = db.prepare('SELECT * FROM courts WHERE venue_id=? AND active=1 ORDER BY sport, order_num').all(v.id);
  for (const c of courts) c.images = db.prepare('SELECT * FROM court_images WHERE court_id=? ORDER BY order_num').all(c.id);
  const amenities = db.prepare('SELECT * FROM venue_amenities WHERE venue_id=? ORDER BY id').all(v.id);
  res.json({ ...v, courts, amenities });
});

// ── ADMIN — VENUE ─────────────────────────────────────────────

app.get('/api/admin/venue', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM venues WHERE owner_id=?').get(req.ownerId) || null);
});
app.post('/api/admin/venue', requireAuth, (req, res) => {
  const { name, slug, city, address, phone, whatsapp, description } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Nombre y slug requeridos' });
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  try {
    const r = db.prepare('INSERT INTO venues (owner_id, name, slug, city, address, phone, whatsapp, description) VALUES (?,?,?,?,?,?,?,?)').run(req.ownerId, name, cleanSlug, city || 'Chilecito', address, phone, whatsapp, description);
    res.json({ id: r.lastInsertRowid, slug: cleanSlug });
  } catch { res.status(409).json({ error: 'El slug ya está en uso' }); }
});
app.put('/api/admin/venue', requireAuthAndVenue, (req, res) => {
  const { name, slug, city, address, phone, whatsapp, description, active } = req.body;
  const cleanSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') : req.venue.slug;
  try {
    db.prepare('UPDATE venues SET name=?,slug=?,city=?,address=?,phone=?,whatsapp=?,description=?,active=? WHERE id=?').run(name || req.venue.name, cleanSlug, city || req.venue.city, address, phone, whatsapp, description, active ?? req.venue.active, req.venue.id);
    res.json({ ok: true, slug: cleanSlug });
  } catch { res.status(409).json({ error: 'El slug ya está en uso' }); }
});
app.post('/api/admin/venue/cover', requireAuthAndVenue, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin imagen' });
  if (req.venue.cover_image) { const old = path.join(UPLOADS_DIR, req.venue.cover_image); if (fs.existsSync(old)) fs.unlinkSync(old); }
  db.prepare('UPDATE venues SET cover_image=? WHERE id=?').run(req.file.filename, req.venue.id);
  res.json({ filename: req.file.filename });
});

// ── ADMIN — COURTS ────────────────────────────────────────────

app.get('/api/admin/courts', requireAuthAndVenue, (req, res) => {
  const courts = db.prepare('SELECT * FROM courts WHERE venue_id=? ORDER BY sport, order_num').all(req.venue.id);
  for (const c of courts) c.images = db.prepare('SELECT * FROM court_images WHERE court_id=? ORDER BY order_num').all(c.id);
  res.json(courts);
});
app.post('/api/admin/courts', requireAuthAndVenue, (req, res) => {
  const { sport, name, description, surface, covered, wall_material, price_per_hour } = req.body;
  if (!sport || !name) return res.status(400).json({ error: 'Deporte y nombre requeridos' });
  const r = db.prepare('INSERT INTO courts (venue_id, sport, name, description, surface, covered, wall_material, price_per_hour) VALUES (?,?,?,?,?,?,?,?)').run(req.venue.id, sport, name, description, surface, covered ? 1 : 0, wall_material, price_per_hour || null);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/admin/courts/:id', requireAuthAndVenue, (req, res) => {
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  const { sport, name, description, surface, covered, wall_material, price_per_hour, active } = req.body;
  db.prepare('UPDATE courts SET sport=?,name=?,description=?,surface=?,covered=?,wall_material=?,price_per_hour=?,active=? WHERE id=?').run(sport || court.sport, name || court.name, description, surface, covered ? 1 : 0, wall_material, price_per_hour, active ?? court.active, court.id);
  res.json({ ok: true });
});
app.delete('/api/admin/courts/:id', requireAuthAndVenue, (req, res) => {
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  const imgs = db.prepare('SELECT path FROM court_images WHERE court_id=?').all(court.id);
  for (const img of imgs) { const p = path.join(UPLOADS_DIR, img.path); if (fs.existsSync(p)) fs.unlinkSync(p); }
  db.prepare('DELETE FROM courts WHERE id=?').run(court.id);
  res.json({ ok: true });
});
app.post('/api/admin/courts/:id/images', requireAuthAndVenue, upload.array('images', 10), (req, res) => {
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  if (!req.files?.length) return res.status(400).json({ error: 'Sin imágenes' });
  const max = db.prepare('SELECT MAX(order_num) as m FROM court_images WHERE court_id=?').get(court.id).m || 0;
  const ins = db.prepare('INSERT INTO court_images (court_id, path, order_num) VALUES (?,?,?)');
  req.files.forEach((f, i) => ins.run(court.id, f.filename, max + i + 1));
  res.json({ ok: true });
});
app.delete('/api/admin/courts/:id/images/:imgId', requireAuthAndVenue, (req, res) => {
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  const img = db.prepare('SELECT * FROM court_images WHERE id=? AND court_id=?').get(req.params.imgId, court.id);
  if (!img) return res.status(404).json({ error: 'Imagen no encontrada' });
  const p = path.join(UPLOADS_DIR, img.path); if (fs.existsSync(p)) fs.unlinkSync(p);
  db.prepare('DELETE FROM court_images WHERE id=?').run(img.id);
  res.json({ ok: true });
});

// ── ADMIN — AMENIDADES ────────────────────────────────────────

app.get('/api/admin/amenities', requireAuthAndVenue, (req, res) => res.json(db.prepare('SELECT * FROM venue_amenities WHERE venue_id=? ORDER BY id').all(req.venue.id)));
app.post('/api/admin/amenities', requireAuthAndVenue, (req, res) => {
  const { name, description, icon, bookable, price } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare('INSERT INTO venue_amenities (venue_id, name, description, icon, bookable, price) VALUES (?,?,?,?,?,?)').run(req.venue.id, name, description, icon || '✨', bookable ? 1 : 0, price || null);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/admin/amenities/:id', requireAuthAndVenue, (req, res) => {
  const am = db.prepare('SELECT * FROM venue_amenities WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!am) return res.status(404).json({ error: 'No encontrada' });
  const { name, description, icon, bookable, price } = req.body;
  db.prepare('UPDATE venue_amenities SET name=?,description=?,icon=?,bookable=?,price=? WHERE id=?').run(name || am.name, description, icon || am.icon, bookable ? 1 : 0, price, am.id);
  res.json({ ok: true });
});
app.delete('/api/admin/amenities/:id', requireAuthAndVenue, (req, res) => {
  const am = db.prepare('SELECT * FROM venue_amenities WHERE id=? AND venue_id=?').get(req.params.id, req.venue.id);
  if (!am) return res.status(404).json({ error: 'No encontrada' });
  db.prepare('DELETE FROM venue_amenities WHERE id=?').run(am.id);
  res.json({ ok: true });
});

// ── ADMIN — SLOTS ─────────────────────────────────────────────

app.get('/api/admin/slots', requireAuthAndVenue, (req, res) => {
  const { date, court_id } = req.query;
  let q = `SELECT os.*, c.name as court_name, c.sport FROM occupied_slots os JOIN courts c ON c.id = os.court_id WHERE c.venue_id = ?`;
  const params = [req.venue.id];
  if (date) { q += ' AND os.date = ?'; params.push(date); }
  if (court_id) { q += ' AND os.court_id = ?'; params.push(court_id); }
  q += ' ORDER BY os.date, os.start_time';
  res.json(db.prepare(q).all(...params));
});
app.post('/api/admin/slots', requireAuthAndVenue, (req, res) => {
  const { court_id, date, start_time, end_time, label } = req.body;
  if (!court_id || !date || !start_time || !end_time) return res.status(400).json({ error: 'Faltan datos' });
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(court_id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  if (start_time >= end_time) return res.status(400).json({ error: 'Hora inicio debe ser menor a hora fin' });
  const r = db.prepare('INSERT INTO occupied_slots (court_id, date, start_time, end_time, label) VALUES (?,?,?,?,?)').run(court_id, date, start_time, end_time, label || 'Reservado');
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/admin/slots/:id', requireAuthAndVenue, (req, res) => {
  const slot = db.prepare(`SELECT os.* FROM occupied_slots os JOIN courts c ON c.id=os.court_id WHERE os.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  db.prepare('DELETE FROM occupied_slots WHERE id=?').run(slot.id);
  res.json({ ok: true });
});

// ── SUPER ADMIN — SPORTS ──────────────────────────────────────

app.get('/api/super/sports', requireSuper, (req, res) => {
  res.json(db.prepare('SELECT * FROM sports ORDER BY order_num, label').all());
});
app.post('/api/super/sports', requireSuper, (req, res) => {
  const { key, label, icon, order_num } = req.body;
  if (!key || !label) return res.status(400).json({ error: 'Key y label requeridos' });
  const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    const r = db.prepare('INSERT INTO sports (key, label, icon, order_num) VALUES (?,?,?,?)').run(cleanKey, label, icon || '🏟️', order_num || 99);
    res.json({ id: r.lastInsertRowid, key: cleanKey });
  } catch { res.status(409).json({ error: 'Ese deporte ya existe' }); }
});
app.put('/api/super/sports/:id', requireSuper, (req, res) => {
  const { label, icon, active, order_num } = req.body;
  const sport = db.prepare('SELECT * FROM sports WHERE id=?').get(req.params.id);
  if (!sport) return res.status(404).json({ error: 'Deporte no encontrado' });
  db.prepare('UPDATE sports SET label=?,icon=?,active=?,order_num=? WHERE id=?').run(label || sport.label, icon || sport.icon, active ?? sport.active, order_num ?? sport.order_num, sport.id);
  res.json({ ok: true });
});
app.delete('/api/super/sports/:id', requireSuper, (req, res) => {
  db.prepare('DELETE FROM sports WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── SUPER ADMIN — MÉTRICAS ────────────────────────────────────

app.get('/api/super/metrics', requireSuper, (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const searchesBySport = db.prepare(`
    SELECT sport, COUNT(*) as total, AVG(results_count) as avg_results
    FROM search_logs WHERE created_at >= ? GROUP BY sport ORDER BY total DESC
  `).all(since);

  const searchesByDay = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as total
    FROM search_logs WHERE created_at >= ? GROUP BY day ORDER BY day DESC LIMIT 14
  `).all(since);

  const searchesByHour = db.prepare(`
    SELECT CAST(substr(time_searched, 1, 2) AS INTEGER) as hour, COUNT(*) as total
    FROM search_logs WHERE created_at >= ? GROUP BY hour ORDER BY hour
  `).all(since);

  const topVenues = db.prepare(`
    SELECT v.name, v.slug, v.city, COUNT(pv.id) as views
    FROM venues v LEFT JOIN page_views pv ON pv.venue_id = v.id AND pv.created_at >= ?
    GROUP BY v.id ORDER BY views DESC
  `).all(since);

  const totalSearches = db.prepare('SELECT COUNT(*) as c FROM search_logs WHERE created_at >= ?').get(since).c;
  const totalViews = db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?').get(since).c;
  const totalVenues = db.prepare('SELECT COUNT(*) as c FROM venues WHERE active=1').get().c;
  const totalCourts = db.prepare('SELECT COUNT(*) as c FROM courts WHERE active=1').get().c;

  res.json({ searchesBySport, searchesByDay, searchesByHour, topVenues, totalSearches, totalViews, totalVenues, totalCourts, days: parseInt(days) });
});

// ── RUTAS FRONTEND ────────────────────────────────────────────

app.get('/complejo/:slug', (req, res) => res.sendFile(path.join(__dirname, '../frontend/complejo.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/superadmin.html')));

app.listen(PORT, () => console.log(`Cancha Libre corriendo en http://localhost:${PORT}`));
