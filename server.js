'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters.');
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to a random secret of at least 32 characters.');

const db = new Database(path.join(DATA_DIR, 'rf-game-center.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  game_name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  apk_filename TEXT,
  apk_size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  browser TEXT NOT NULL,
  device TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
);
`);
db.prepare(`INSERT OR IGNORE INTO settings (id, game_name, description, version, apk_filename, apk_size, updated_at)
VALUES (1, 'My Android Game', 'به صفحه رسمی انتشار بازی من خوش آمدید. نسخه‌های جدید را از همین صفحه دریافت کنید.', '1.0.0', NULL, 0, ?)`)
  .run(new Date().toISOString());

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
    baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"]
  } },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
class BetterSqliteSessionStore extends session.Store {
  constructor(database) { super(); this.db = database; }
  get(sid, cb) { try { const row = this.db.prepare('SELECT sess, expire FROM sessions WHERE sid=?').get(sid); if (!row) return cb(null, null); if (row.expire <= Date.now()) { this.destroy(sid, () => {}); return cb(null, null); } cb(null, JSON.parse(row.sess)); } catch (e) { cb(e); } }
  set(sid, sess, cb = () => {}) { try { const expire = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000; this.db.prepare('INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire').run(sid, JSON.stringify(sess), expire); cb(); } catch (e) { cb(e); } }
  destroy(sid, cb = () => {}) { try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(); } catch (e) { cb(e); } }
  touch(sid, sess, cb = () => {}) { this.set(sid, sess, cb); }
}
const sessionStore = new BetterSqliteSessionStore(db);
app.use(session({
  store: sessionStore,
  name: 'rf_admin_session', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProduction, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], index: 'index.html', maxAge: isProduction ? '1h' : 0 }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید.' } });
const downloadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const uploadMax = Math.max(1024 * 1024, Number(process.env.MAX_APK_SIZE || 1073741824));
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `apk-${crypto.randomUUID()}.apk`)
  }),
  limits: { fileSize: uploadMax, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.apk'))
});

function getSettings() { return db.prepare('SELECT * FROM settings WHERE id = 1').get(); }
function requireAdmin(req, res, next) {
  if (!req.session || req.session.admin !== true) return res.status(401).json({ error: 'ابتدا وارد پنل مدیریت شوید.' });
  next();
}
function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || req.body.csrfToken;
  const supplied = Buffer.from(String(token || ''));
  const expected = Buffer.from(String(req.session.csrfToken || ''));
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'درخواست معتبر نیست. صفحه را تازه‌سازی کنید.' });
  }
  next();
}
function parseClient(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /SamsungBrowser/.test(ua) ? 'Samsung Browser' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop';
  return { browser, device };
}
function publicSettings() {
  const s = getSettings();
  return { gameName: s.game_name, description: s.description, version: s.version, apkSize: s.apk_size,
    hasApk: !!(s.apk_filename && fs.existsSync(path.join(UPLOAD_DIR, s.apk_filename))), updatedAt: s.updated_at };
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

app.get('/api/game', (_req, res) => res.json(publicSettings()));
app.get('/api/admin/status', (req, res) => res.json({ authenticated: req.session?.admin === true }));
app.post('/api/admin/login', loginLimiter, asyncRoute(async (req, res) => {
  const password = String(req.body.password || '');
  const a = Buffer.from(password); const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'رمز عبور نادرست است.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'خطا در ایجاد نشست.' });
    req.session.admin = true;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'ذخیره نشست ناموفق بود.' });
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    });
  });
}));
app.post('/api/admin/logout', requireAdmin, requireCsrf, (req, res) => req.session.destroy(() => {
  res.clearCookie('rf_admin_session', { httpOnly: true, sameSite: 'strict', secure: isProduction });
  res.json({ ok: true });
}));
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM downloads').get().count;
  const recent = db.prepare('SELECT download_id AS downloadId, version, created_at AS createdAt, browser, device FROM downloads ORDER BY id DESC LIMIT 100').all();
  const byVersion = db.prepare('SELECT version, COUNT(*) AS count FROM downloads GROUP BY version ORDER BY count DESC').all();
  const byDay = db.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM downloads
    WHERE created_at >= ? GROUP BY day ORDER BY day ASC`).all(new Date(Date.now() - 30 * 86400000).toISOString());
  res.json({ game: publicSettings(), total, recent, byVersion, byDay, csrfToken: req.session.csrfToken });
});
app.post('/api/admin/game', requireAdmin, requireCsrf, (req, res) => {
  const gameName = String(req.body.gameName || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const version = String(req.body.version || '').trim().slice(0, 30);
  if (!gameName || !description || !version) return res.status(400).json({ error: 'نام، توضیحات و نسخه الزامی هستند.' });
  db.prepare('UPDATE settings SET game_name=?, description=?, version=?, updated_at=? WHERE id=1')
    .run(gameName, description, version, new Date().toISOString());
  res.json({ ok: true, game: publicSettings() });
});
app.post('/api/admin/upload', requireAdmin, requireCsrf, (req, res, next) => {
  upload.single('apk')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'حجم فایل بیشتر از حد مجاز است.' : 'آپلود فایل APK ناموفق بود.' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'یک فایل با پسوند APK انتخاب کنید.' });
  const fd = fs.openSync(req.file.path, 'r'); const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  // APK is a ZIP archive. Validate its signature rather than trusting the filename or MIME type.
  if (!(head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2]) && [0x04, 0x06, 0x08].includes(head[3]))) {
    fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'محتوای فایل، یک آرشیو APK معتبر به نظر نمی‌رسد.' });
  }
  const old = getSettings().apk_filename;
  db.prepare('UPDATE settings SET apk_filename=?, apk_size=?, updated_at=? WHERE id=1')
    .run(req.file.filename, req.file.size, new Date().toISOString());
  if (old && old !== req.file.filename) setTimeout(() => { try { fs.unlinkSync(path.join(UPLOAD_DIR, old)); } catch (_) {} }, 1000);
  res.json({ ok: true, game: publicSettings() });
});
app.get('/download', downloadLimiter, (req, res) => {
  const s = getSettings();
  if (!s.apk_filename) return res.status(404).send('هنوز فایل APK منتشر نشده است.');
  const filePath = path.join(UPLOAD_DIR, path.basename(s.apk_filename));
  if (!fs.existsSync(filePath)) return res.status(404).send('فایل APK در دسترس نیست.');
  const cookieHeader = req.get('cookie') || '';
  const anonMatch = cookieHeader.match(/(?:^|;\s*)rf_anon=([a-f0-9]{48})(?:;|$)/);
  let anon = anonMatch ? anonMatch[1] : null;
  // No third-party identity or IP address is stored. This random first-party cookie only limits repeat log entries.
  if (!anon) {
    anon = crypto.randomBytes(24).toString('hex');
    res.cookie('rf_anon', anon, { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 365 * 86400000, path: '/' });
  }
  const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const dedupeKey = crypto.createHmac('sha256', SESSION_SECRET).update(`${anon}:${s.version}:${bucket}`).digest('hex');
  const { browser, device } = parseClient(req.get('user-agent') || '');
  try {
    db.prepare(`INSERT OR IGNORE INTO downloads (download_id, version, created_at, browser, device, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), s.version, new Date().toISOString(), browser, device, dedupeKey);
  } catch (e) { console.error('Download log error:', e.message); }
  res.download(filePath, `${s.game_name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'game'}-${s.version}.apk`);
});

db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now());
const retention = Number(process.env.DOWNLOAD_LOG_RETENTION_DAYS || 0);
if (retention > 0) db.prepare('DELETE FROM downloads WHERE created_at < ?').run(new Date(Date.now() - retention * 86400000).toISOString());
app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use((err, _req, res, _next) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'خطای داخلی سرور رخ داد.' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`RF GAME CENTER is running on port ${PORT}`));
