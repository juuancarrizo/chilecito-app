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

  CREATE TABLE IF NOT EXISTS recurring_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recurring_id INTEGER NOT NULL REFERENCES recurring_slots(id) ON DELETE CASCADE,
    exception_date TEXT NOT NULL,
    UNIQUE(recurring_id, exception_date)
  );

  CREATE TABLE IF NOT EXISTS recurring_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    label TEXT DEFAULT 'Turno fijo',
    person_name TEXT,
    person_whatsapp TEXT,
    active INTEGER DEFAULT 1,
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

  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sport TEXT DEFAULT 'padel',
    description TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT DEFAULT 'upcoming',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tournament_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    partner_name TEXT,
    whatsapp TEXT,
    points INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    position INTEGER
  );

  CREATE TABLE IF NOT EXISTS tournament_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round_name TEXT DEFAULT 'Fase de grupos',
    player1_id INTEGER REFERENCES tournament_participants(id) ON DELETE SET NULL,
    player2_id INTEGER REFERENCES tournament_participants(id) ON DELETE SET NULL,
    player1_name TEXT,
    player2_name TEXT,
    score1 TEXT,
    score2 TEXT,
    match_date TEXT,
    match_time TEXT,
    status TEXT DEFAULT 'pending'
  );
`);

// Migraciones para tablas que pueden ya existir
try { db.exec(`ALTER TABLE owners ADD COLUMN is_superadmin INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE venues ADD COLUMN city TEXT DEFAULT 'Chilecito'`); } catch {}
try { db.exec(`ALTER TABLE occupied_slots ADD COLUMN person_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE occupied_slots ADD COLUMN person_whatsapp TEXT`); } catch {}

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
  // city va inmediatamente después de sport porque cityFilter se inserta tras v.active=1
  const params = city ? [sport, city, date, end_time, start_time] : [sport, date, end_time, start_time];

  const available = db.prepare(`
    SELECT c.*, v.name as venue_name, v.slug as venue_slug, v.city as venue_city,
           v.address as venue_address, v.phone as venue_phone, v.whatsapp as venue_whatsapp,
           v.cover_image as venue_cover
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE c.sport = ? AND c.active = 1 AND v.active = 1 ${cityFilter}
    AND NOT EXISTS (
      SELECT 1 FROM occupied_slots os
      WHERE os.court_id = c.id AND os.date = ? AND os.start_time < ? AND os.end_time > ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM recurring_slots rs
      WHERE rs.court_id = c.id AND rs.active = 1
      AND rs.day_of_week = CAST(strftime('%w', ?) AS INTEGER)
      AND rs.start_time < ? AND rs.end_time > ?
      AND NOT EXISTS (SELECT 1 FROM recurring_exceptions re WHERE re.recurring_id = rs.id AND re.exception_date = ?)
    )
    ORDER BY c.price_per_hour, c.name
  `).all(...(city ? [sport, city, date, end_time, start_time, date, end_time, start_time, date] : [sport, date, end_time, start_time, date, end_time, start_time, date]));

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
        AND NOT EXISTS (SELECT 1 FROM recurring_slots rs WHERE rs.court_id = c.id AND rs.active = 1 AND rs.day_of_week = CAST(strftime('%w',?) AS INTEGER) AND rs.start_time < ? AND rs.end_time > ? AND NOT EXISTS (SELECT 1 FROM recurring_exceptions re WHERE re.recurring_id=rs.id AND re.exception_date=?))
        LIMIT 5
      `).all(...(city ? [sport, city, date, eT, sT, date, eT, sT, date] : [sport, date, eT, sT, date, eT, sT, date]));
      if (courts.length) suggestions.push({ time: sT, delta, count: courts.length });
    }
    suggestions = suggestions.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 4);
  }

  // Canchas ocupadas en ese horario (para mostrarlas con otros horarios disponibles)
  const occupiedParams = city ? [sport, city, date, end_time, start_time, date, end_time, start_time, date] : [sport, date, end_time, start_time, date, end_time, start_time, date];
  const occupied = db.prepare(`
    SELECT c.*, v.name as venue_name, v.slug as venue_slug, v.city as venue_city,
           v.phone as venue_phone, v.whatsapp as venue_whatsapp, v.cover_image as venue_cover
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE c.sport = ? AND c.active = 1 AND v.active = 1 ${cityFilter}
    AND (
      EXISTS (
        SELECT 1 FROM occupied_slots os
        WHERE os.court_id = c.id AND os.date = ? AND os.start_time < ? AND os.end_time > ?
      ) OR EXISTS (
        SELECT 1 FROM recurring_slots rs
        WHERE rs.court_id = c.id AND rs.active = 1
        AND rs.day_of_week = CAST(strftime('%w', ?) AS INTEGER)
        AND rs.start_time < ? AND rs.end_time > ?
        AND NOT EXISTS (SELECT 1 FROM recurring_exceptions re WHERE re.recurring_id=rs.id AND re.exception_date=?)
      )
    )
    ORDER BY c.name
  `).all(...occupiedParams);

  const enrichCourt = (c) => {
    c.images = db.prepare('SELECT * FROM court_images WHERE court_id = ? ORDER BY order_num LIMIT 1').all(c.id);
    c.occupied_today = db.prepare('SELECT start_time, end_time FROM occupied_slots WHERE court_id = ? AND date = ? ORDER BY start_time').all(c.id, date);
  };
  for (const c of available) enrichCourt(c);
  for (const c of occupied)  enrichCourt(c);

  res.json({ available, occupied, suggestions, search: { sport, date, start_time, end_time, city } });
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
  const { court_id, date, start_time, end_time, label, person_name, person_whatsapp } = req.body;
  if (!court_id || !date || !start_time || !end_time) return res.status(400).json({ error: 'Faltan datos' });
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(court_id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  if (start_time >= end_time) return res.status(400).json({ error: 'Hora inicio debe ser menor a hora fin' });
  if (label === 'Torneo') {
    // Borra turnos comunes que pisen
    db.prepare(`DELETE FROM occupied_slots WHERE court_id=? AND date=? AND start_time<? AND end_time>? AND label!='Torneo'`).run(court_id, date, end_time, start_time);
    // Agrega excepción a turnos fijos que pisen
    const dow = db.prepare(`SELECT CAST(strftime('%w',?) AS INTEGER) as d`).get(date).d;
    const conflicting = db.prepare(`SELECT id FROM recurring_slots WHERE court_id=? AND day_of_week=? AND active=1 AND start_time<? AND end_time>?`).all(court_id, dow, end_time, start_time);
    for (const r of conflicting) db.prepare('INSERT OR IGNORE INTO recurring_exceptions (recurring_id, exception_date) VALUES (?,?)').run(r.id, date);
  }
  const r = db.prepare('INSERT INTO occupied_slots (court_id, date, start_time, end_time, label, person_name, person_whatsapp) VALUES (?,?,?,?,?,?,?)').run(court_id, date, start_time, end_time, label || 'Reservado', person_name || null, person_whatsapp || null);
  res.json({ id: r.lastInsertRowid });
});

// Turnos fijos (recurrentes)
app.get('/api/admin/recurring', requireAuthAndVenue, (req, res) => {
  const slots = db.prepare(`
    SELECT rs.*, c.name as court_name, c.sport FROM recurring_slots rs
    JOIN courts c ON c.id = rs.court_id
    WHERE c.venue_id = ? AND rs.active = 1
    ORDER BY rs.day_of_week, rs.start_time
  `).all(req.venue.id);
  res.json(slots);
});
app.get('/api/admin/recurring/exceptions', requireAuthAndVenue, (req, res) => {
  const { date } = req.query;
  if (!date) return res.json([]);
  const rows = db.prepare(`
    SELECT re.recurring_id FROM recurring_exceptions re
    JOIN recurring_slots rs ON rs.id = re.recurring_id
    JOIN courts c ON c.id = rs.court_id
    WHERE re.exception_date = ? AND c.venue_id = ?
  `).all(date, req.venue.id);
  res.json(rows.map(r => r.recurring_id));
});

app.post('/api/admin/recurring', requireAuthAndVenue, (req, res) => {
  const { court_id, day_of_week, start_time, end_time, label, person_name, person_whatsapp } = req.body;
  if (!court_id || day_of_week == null || !start_time || !end_time) return res.status(400).json({ error: 'Faltan datos' });
  const court = db.prepare('SELECT * FROM courts WHERE id=? AND venue_id=?').get(court_id, req.venue.id);
  if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
  if (start_time >= end_time) return res.status(400).json({ error: 'Hora inicio debe ser menor a hora fin' });
  // Validar que no haya overlap con otro turno fijo
  const overlap = db.prepare('SELECT id FROM recurring_slots WHERE court_id=? AND day_of_week=? AND active=1 AND start_time<? AND end_time>?').get(court_id, day_of_week, end_time, start_time);
  if (overlap) return res.status(409).json({ error: 'Ya existe un turno fijo en ese horario para esa cancha' });
  const r = db.prepare('INSERT INTO recurring_slots (court_id, day_of_week, start_time, end_time, label, person_name, person_whatsapp) VALUES (?,?,?,?,?,?,?)').run(court_id, day_of_week, start_time, end_time, label || 'Turno fijo', person_name || null, person_whatsapp || null);
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/admin/recurring/:id/free', requireAuthAndVenue, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Fecha requerida' });
  const slot = db.prepare(`SELECT rs.* FROM recurring_slots rs JOIN courts c ON c.id=rs.court_id WHERE rs.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  db.prepare('INSERT OR IGNORE INTO recurring_exceptions (recurring_id, exception_date) VALUES (?,?)').run(slot.id, date);
  res.json({ ok: true });
});
app.put('/api/admin/recurring/:id', requireAuthAndVenue, (req, res) => {
  const slot = db.prepare(`SELECT rs.* FROM recurring_slots rs JOIN courts c ON c.id=rs.court_id WHERE rs.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  const { start_time, end_time, person_name, person_whatsapp } = req.body;
  if (start_time && end_time && start_time >= end_time) return res.status(400).json({ error: 'Hora inicio debe ser menor a hora fin' });
  db.prepare('UPDATE recurring_slots SET start_time=?,end_time=?,person_name=?,person_whatsapp=? WHERE id=?')
    .run(start_time||slot.start_time, end_time||slot.end_time, person_name??slot.person_name, person_whatsapp??slot.person_whatsapp, slot.id);
  res.json({ ok: true });
});

app.delete('/api/admin/recurring/:id', requireAuthAndVenue, (req, res) => {
  const slot = db.prepare(`SELECT rs.* FROM recurring_slots rs JOIN courts c ON c.id=rs.court_id WHERE rs.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  db.prepare('DELETE FROM recurring_slots WHERE id=?').run(slot.id);
  res.json({ ok: true });
});
app.put('/api/admin/slots/:id', requireAuthAndVenue, (req, res) => {
  const slot = db.prepare(`SELECT os.* FROM occupied_slots os JOIN courts c ON c.id=os.court_id WHERE os.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  const { label, person_name, person_whatsapp } = req.body;
  db.prepare('UPDATE occupied_slots SET label=?, person_name=?, person_whatsapp=? WHERE id=?')
    .run(label ?? slot.label, person_name ?? slot.person_name, person_whatsapp ?? slot.person_whatsapp, slot.id);
  res.json({ ok: true });
});

app.delete('/api/admin/slots/:id', requireAuthAndVenue, (req, res) => {
  const slot = db.prepare(`SELECT os.* FROM occupied_slots os JOIN courts c ON c.id=os.court_id WHERE os.id=? AND c.venue_id=?`).get(req.params.id, req.venue.id);
  if (!slot) return res.status(404).json({ error: 'Turno no encontrado' });
  db.prepare('DELETE FROM occupied_slots WHERE id=?').run(slot.id);
  res.json({ ok: true });
});

// ── SUPER ADMIN — OWNERS/CLUBES ───────────────────────────────

app.get('/api/super/owners', requireSuper, (req, res) => {
  const owners = db.prepare('SELECT id, email, name, is_superadmin, created_at FROM owners WHERE is_superadmin = 0 ORDER BY name').all();
  for (const o of owners) {
    o.venue = db.prepare('SELECT id, name, slug, city, active FROM venues WHERE owner_id = ?').get(o.id) || null;
  }
  res.json(owners);
});

app.post('/api/super/owners', requireSuper, (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  try {
    const r = db.prepare('INSERT INTO owners (email, password_hash, name) VALUES (?,?,?)').run(username.trim(), hashPassword(password), name || username);
    res.json({ id: r.lastInsertRowid });
  } catch { res.status(409).json({ error: 'Ese usuario ya existe' }); }
});

app.put('/api/super/owners/:id', requireSuper, (req, res) => {
  const owner = db.prepare('SELECT * FROM owners WHERE id = ? AND is_superadmin = 0').get(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { username, password, name } = req.body;
  const newEmail = username ? username.trim() : owner.email;
  const newHash  = password ? hashPassword(password) : owner.password_hash;
  const newName  = name || owner.name;
  try {
    db.prepare('UPDATE owners SET email=?, password_hash=?, name=? WHERE id=?').run(newEmail, newHash, newName, owner.id);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Ese usuario ya existe' }); }
});

app.delete('/api/super/owners/:id', requireSuper, (req, res) => {
  const owner = db.prepare('SELECT * FROM owners WHERE id = ? AND is_superadmin = 0').get(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });
  db.prepare('DELETE FROM owners WHERE id = ?').run(owner.id);
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

// ── PÚBLICO — TORNEOS ─────────────────────────────────────────

app.get('/api/tournaments', (req, res) => {
  const { sport = 'padel' } = req.query;
  const tournaments = db.prepare(`
    SELECT * FROM tournaments WHERE sport = ? AND status IN ('upcoming','active')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, start_date
  `).all(sport);
  for (const t of tournaments) {
    t.participants = db.prepare('SELECT * FROM tournament_participants WHERE tournament_id = ? ORDER BY position, points DESC, name').all(t.id);
    t.matches = db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY match_date, match_time').all(t.id);
  }
  res.json(tournaments);
});

app.get('/api/tournaments/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
  t.participants = db.prepare('SELECT * FROM tournament_participants WHERE tournament_id = ? ORDER BY position, points DESC, name').all(t.id);
  t.matches = db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY match_date, match_time').all(t.id);
  res.json(t);
});

// ── SUPER ADMIN — TORNEOS ─────────────────────────────────────

app.get('/api/super/tournaments', requireSuper, (req, res) => {
  const list = db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all();
  for (const t of list) {
    t.participants_count = db.prepare('SELECT COUNT(*) as c FROM tournament_participants WHERE tournament_id = ?').get(t.id).c;
    t.matches_count = db.prepare('SELECT COUNT(*) as c FROM tournament_matches WHERE tournament_id = ?').get(t.id).c;
  }
  res.json(list);
});

app.post('/api/super/tournaments', requireSuper, (req, res) => {
  const { name, sport = 'padel', description, start_date, end_date, status = 'upcoming' } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare('INSERT INTO tournaments (name, sport, description, start_date, end_date, status) VALUES (?,?,?,?,?,?)').run(name, sport, description, start_date, end_date, status);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/super/tournaments/:id', requireSuper, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
  const { name, description, start_date, end_date, status } = req.body;
  db.prepare('UPDATE tournaments SET name=?,description=?,start_date=?,end_date=?,status=? WHERE id=?')
    .run(name ?? t.name, description ?? t.description, start_date ?? t.start_date, end_date ?? t.end_date, status ?? t.status, t.id);
  res.json({ ok: true });
});

app.delete('/api/super/tournaments/:id', requireSuper, (req, res) => {
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Participantes
app.post('/api/super/tournaments/:id/participants', requireSuper, (req, res) => {
  const { name, partner_name, whatsapp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare('INSERT INTO tournament_participants (tournament_id, name, partner_name, whatsapp) VALUES (?,?,?,?)').run(req.params.id, name, partner_name, whatsapp);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/super/tournaments/:id/participants/:pid', requireSuper, (req, res) => {
  const p = db.prepare('SELECT * FROM tournament_participants WHERE id = ? AND tournament_id = ?').get(req.params.pid, req.params.id);
  if (!p) return res.status(404).json({ error: 'Participante no encontrado' });
  const { name, partner_name, whatsapp, points, wins, losses, position } = req.body;
  db.prepare('UPDATE tournament_participants SET name=?,partner_name=?,whatsapp=?,points=?,wins=?,losses=?,position=? WHERE id=?')
    .run(name ?? p.name, partner_name ?? p.partner_name, whatsapp ?? p.whatsapp, points ?? p.points, wins ?? p.wins, losses ?? p.losses, position ?? p.position, p.id);
  res.json({ ok: true });
});

app.delete('/api/super/tournaments/:id/participants/:pid', requireSuper, (req, res) => {
  db.prepare('DELETE FROM tournament_participants WHERE id = ? AND tournament_id = ?').run(req.params.pid, req.params.id);
  res.json({ ok: true });
});

// Partidos
app.post('/api/super/tournaments/:id/matches', requireSuper, (req, res) => {
  const { round_name, player1_id, player2_id, player1_name, player2_name, score1, score2, match_date, match_time, status } = req.body;
  const r = db.prepare('INSERT INTO tournament_matches (tournament_id, round_name, player1_id, player2_id, player1_name, player2_name, score1, score2, match_date, match_time, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(req.params.id, round_name || 'Fase de grupos', player1_id || null, player2_id || null, player1_name, player2_name, score1, score2, match_date, match_time, status || 'pending');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/super/tournaments/:id/matches/:mid', requireSuper, (req, res) => {
  const m = db.prepare('SELECT * FROM tournament_matches WHERE id = ? AND tournament_id = ?').get(req.params.mid, req.params.id);
  if (!m) return res.status(404).json({ error: 'Partido no encontrado' });
  const { round_name, player1_name, player2_name, score1, score2, match_date, match_time, status } = req.body;
  db.prepare('UPDATE tournament_matches SET round_name=?,player1_name=?,player2_name=?,score1=?,score2=?,match_date=?,match_time=?,status=? WHERE id=?')
    .run(round_name ?? m.round_name, player1_name ?? m.player1_name, player2_name ?? m.player2_name, score1 ?? m.score1, score2 ?? m.score2, match_date ?? m.match_date, match_time ?? m.match_time, status ?? m.status, m.id);
  res.json({ ok: true });
});

app.delete('/api/super/tournaments/:id/matches/:mid', requireSuper, (req, res) => {
  db.prepare('DELETE FROM tournament_matches WHERE id = ? AND tournament_id = ?').run(req.params.mid, req.params.id);
  res.json({ ok: true });
});

// ── RUTAS FRONTEND ────────────────────────────────────────────

app.get('/complejo/:slug', (req, res) => res.sendFile(path.join(__dirname, '../frontend/complejo.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/superadmin.html')));
app.get('/superadmin/torneos', (req, res) => res.sendFile(path.join(__dirname, '../frontend/superadmin.html')));

app.listen(PORT, () => console.log(`Cancha Libre corriendo en http://localhost:${PORT}`));
