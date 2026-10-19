import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');
const imagesDir = path.join(here, '..', 'images');
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const {
  MONGODB_URI, MONGODB_DB = 'compliance_tracker', PORT = 8000,
  NODE_ENV, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, TRUST_PROXY
} = process.env;
const PROD = NODE_ENV === 'production';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing. Copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (PROD && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET (at least 32 characters) is required when NODE_ENV=production.');
  process.exit(1);
}
const SECRET = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!SESSION_SECRET) console.warn('SESSION_SECRET not set: using a random one, so everyone is signed out on each restart.');

const ROLES = ['admin', 'head', 'owner', 'approver', 'readonly'];
const EDITORS = ['admin', 'head', 'owner', 'approver'];
// Who may write to each collection. Everyone signed in may read.
const WRITE_ROLES = {
  tracking: EDITORS,
  projects: EDITORS,
  audit: EDITORS,
  stage_overrides: ['admin'],
  documents: [] // read-only through /api; rows are created and deleted only by the /files routes
};
const MAX_UPLOAD = 15 * 1024 * 1024;
const UPLOAD_EXT = new Set(['.pdf', '.doc', '.docx']);
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;

/* ----------------------------- database ----------------------------- */
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const users = db.collection('users');
await db.collection('audit').createIndex({ key: 1, at: -1 });
await db.collection('documents').createIndex({ key: 1, uploaded_at: -1 });
const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
console.log(`Connected to MongoDB database "${MONGODB_DB}"`);

/* ----------------------------- passwords & sessions ----------------------------- */
const scrypt = promisify(crypto.scrypt);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const hash = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const expected = Buffer.from(h, 'base64');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}
const DUMMY_HASH = await hashPassword(crypto.randomBytes(8).toString('hex'));

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
function makeToken(user) {
  const p = Buffer.from(JSON.stringify({ e: user._id, v: user.tv || 0, x: Date.now() + SESSION_MS })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readToken(token) {
  if (typeof token !== 'string') return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = sign(p);
  if (expected.length !== s.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.x > Date.now() ? d : null;
  } catch { return null; }
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: SESSION_MS, path: '/' };

/* First run: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD when there are no users. */
if ((await users.countDocuments()) === 0) {
  if (ADMIN_EMAIL && ADMIN_PASSWORD && ADMIN_PASSWORD.length >= MIN_PASSWORD) {
    await users.insertOne({
      _id: ADMIN_EMAIL.trim().toLowerCase(), name: 'Administrator', role: 'admin', active: true,
      passwordHash: await hashPassword(ADMIN_PASSWORD), tv: 0, created_at: new Date().toISOString()
    });
    console.log(`Created first admin user ${ADMIN_EMAIL}. You can now remove ADMIN_PASSWORD from the environment.`);
  } else {
    console.warn(`No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (min ${MIN_PASSWORD} chars) and restart to create the first admin.`);
  }
}

/* ----------------------------- helpers ----------------------------- */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Reject Mongo operator keys ($...) anywhere in a payload, and absurd nesting.
function clean(v, depth = 0) {
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.every((x) => clean(x, depth + 1));
  if (isObj(v)) return Object.entries(v).every(([k, x]) => !k.startsWith('$') && clean(x, depth + 1));
  return true;
}
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\0$\/\\]/.test(id) && !id.startsWith('$');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u) => ({ email: u._id, name: u.name, role: u.role, active: u.active !== false });

/* ----------------------------- app ----------------------------- */
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  hsts: PROD ? undefined : false
}));

app.get('/healthz', async (req, res) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(express.json({ limit: '100kb' }));

// CSRF defence in depth (cookie is SameSite=Strict): writes must be JSON and same-origin.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'cross-origin request blocked' });
  }
  // File upload/delete routes carry binary bodies; a custom header (which cross-site forms can't send) stands in for the JSON check.
  if (req.path.startsWith('/files')) {
    if (req.headers['x-requested-with'] !== 'fetch') return res.status(415).json({ error: 'bad request' });
    return next();
  }
  if (req.body === undefined || !req.is('json')) return res.status(415).json({ error: 'JSON body required' });
  next();
});

/* ----------------------------- auth ----------------------------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = email ? await users.findOne({ _id: email }) : null;
    // Always run a hash so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok || user.active === false) return res.status(401).json({ error: 'Invalid email or password.' });
    res.cookie('sid', makeToken(user), cookieOpts);
    res.json(publicUser(user));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('sid', { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

// Load the signed-in user on every request so role changes and disabling take effect immediately.
app.use(async (req, res, next) => {
  try {
    const t = readToken(getCookie(req, 'sid'));
    if (t) {
      const u = await users.findOne({ _id: t.e });
      if (u && u.active !== false && (u.tv || 0) === t.v) req.user = u;
    }
    next();
  } catch (e) { next(e); }
});

// Public: login page and logo only.
app.use('/images', express.static(imagesDir, {
  setHeaders: (res, p) => { if (p.endsWith('.avif')) res.setHeader('Content-Type', 'image/avif'); }
}));
app.get('/login.html', (req, res) => res.sendFile(path.join(appDir, 'login.html')));

// Everything below needs a signed-in user.
app.use((req, res, next) => {
  if (req.user) return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.method !== 'GET') {
    return res.status(401).json({ error: 'not signed in' });
  }
  res.redirect('/login.html');
});

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'not allowed for your role' });

app.get('/auth/me', (req, res) => res.json(publicUser(req.user)));

app.post('/auth/password', async (req, res) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (!(await verifyPassword(String(current || ''), req.user.passwordHash))) return res.status(400).json({ error: 'Current password is incorrect.' });
    if (typeof nextPw !== 'string' || nextPw.length < MIN_PASSWORD) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
    const tv = (req.user.tv || 0) + 1; // signs out every other session
    await users.updateOne({ _id: req.user._id }, { $set: { passwordHash: await hashPassword(nextPw), tv } });
    res.cookie('sid', makeToken({ ...req.user, tv }), cookieOpts);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- user management (admin) ----------------------------- */
app.get('/auth/users', requireRole('admin'), async (req, res) => {
  res.json((await users.find().sort({ _id: 1 }).toArray()).map(publicUser));
});

app.post('/auth/users', requireRole('admin'), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim().slice(0, 100);
    const { role, password } = req.body || {};
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (await users.findOne({ _id: email })) return res.status(409).json({ error: 'A user with that email already exists.' });
    await users.insertOne({ _id: email, name, role, active: true, passwordHash: await hashPassword(password), tv: 0, created_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.put('/auth/users/:email', requireRole('admin'), async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const target = await users.findOne({ _id: email });
    if (!target) return res.status(404).json({ error: 'No such user.' });
    const { name, role, active, password } = req.body || {};
    const set = {};
    let revoke = false;
    if (name !== undefined) { set.name = String(name).trim().slice(0, 100); if (!set.name) return res.status(400).json({ error: 'Enter a name.' }); }
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
      if (email === req.user._id && role !== target.role) return res.status(400).json({ error: "You can't change your own role." });
      if (role !== target.role) { set.role = role; revoke = true; }
    }
    if (active !== undefined) {
      if (email === req.user._id && active === false) return res.status(400).json({ error: "You can't disable your own account." });
      set.active = active !== false;
      if (!set.active) revoke = true;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
      set.passwordHash = await hashPassword(password);
      revoke = true;
    }
    const update = { $set: set };
    if (revoke) update.$inc = { tv: 1 };
    if (Object.keys(set).length) await users.updateOne({ _id: email }, update);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- data API ----------------------------- */
const guard = (req, res, next) =>
  Object.hasOwn(WRITE_ROLES, req.params.col) ? next() : res.status(404).json({ error: 'unknown collection' });
const canWrite = (req, res, next) =>
  WRITE_ROLES[req.params.col].includes(req.user.role) ? next() : res.status(403).json({ error: 'not allowed for your role' });

const toDoc = ({ _id, ...rest }) => ({ id: String(_id), data: rest });

// The server, not the browser, decides who made a change and when.
function stamp(col, data, user) {
  const now = new Date().toISOString();
  if (col === 'tracking') { data.last_updated_by = user.name; data.updated_at = now; }
  if (col === 'stage_overrides') { data.set_by = user.name; data.at = now; }
  if (col === 'projects') { data.updated_by = user.name; }
  if (col === 'audit') { data.who = user.name; data.at = now; }
  return data;
}

// List documents. Optional: ?key=...&orderBy=at&dir=desc&limit=25
app.get('/api/:col', guard, async (req, res) => {
  try {
    const { key, orderBy, dir, limit } = req.query;
    const filter = typeof key === 'string' ? { key } : {};
    let cur = db.collection(req.params.col).find(filter);
    if (typeof orderBy === 'string' && /^[a-z_]{1,40}$/.test(orderBy)) cur = cur.sort({ [orderBy]: dir === 'desc' ? -1 : 1 });
    if (typeof limit === 'string') cur = cur.limit(Math.min(parseInt(limit, 10) || 0, 1000));
    res.json((await cur.toArray()).map(toDoc));
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Create or replace a document by id.
app.put('/api/:col/:id', guard, canWrite, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    if (!isObj(req.body) || !clean(req.body)) return res.status(400).json({ error: 'bad document' });
    const { _id, ...data } = req.body;
    await db.collection(req.params.col).replaceOne({ _id: req.params.id }, stamp(req.params.col, data, req.user), { upsert: true });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Append a document with a generated id.
app.post('/api/:col', guard, canWrite, async (req, res) => {
  try {
    if (!isObj(req.body) || !clean(req.body)) return res.status(400).json({ error: 'bad document' });
    const { _id, ...data } = req.body;
    const r = await db.collection(req.params.col).insertOne(stamp(req.params.col, data, req.user));
    res.json({ ok: true, id: String(r.insertedId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

/* ----------------------------- document files (GridFS + "documents" collection) ----------------------------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

app.post('/files', requireRole(...EDITORS), express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  try {
    const { key, compliance_id, project_id, doc_name, file_name } = req.query;
    const meta = {
      key: str(key, 200), compliance_id: str(compliance_id, 100), project_id: str(project_id, 100) || null,
      doc_name: str(doc_name, 150), file_name: path.basename(str(file_name, 200).replace(/\\/g, '/'))
    };
    if (!validId(meta.key) || !validId(meta.compliance_id) || !meta.doc_name || !meta.file_name) return res.status(400).json({ error: 'Missing document details.' });
    if (!UPLOAD_EXT.has(path.extname(meta.file_name).toLowerCase())) return res.status(400).json({ error: 'This file type is not allowed.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'The file is empty.' });
    const up = bucket.openUploadStream(meta.file_name, { metadata: { key: meta.key } });
    await new Promise((ok, fail) => { up.on('finish', ok).on('error', fail); up.end(req.body); });
    const doc = {
      ...meta, file_id: String(up.id), size: req.body.length,
      uploaded_by: req.user.name, uploaded_at: new Date().toISOString()
    };
    const r = await db.collection('documents').insertOne(doc);
    res.json({ ok: true, id: String(r.insertedId) });
  } catch (e) {
    if (e.type === 'entity.too.large') return res.status(413).json({ error: 'File is larger than 15 MB.' });
    console.error(e); res.status(500).json({ error: 'upload failed' });
  }
});

app.get('/files/:fileId', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.fileId)) return res.status(404).json({ error: 'not found' });
    const doc = await db.collection('documents').findOne({ file_id: req.params.fileId });
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    bucket.openDownloadStream(new ObjectId(doc.file_id)).on('error', () => res.destroy()).pipe(res);
  } catch (e) { console.error(e); res.status(500).json({ error: 'download failed' }); }
});

// :id here is the "documents" row id.
app.delete('/files/:id', requireRole(...EDITORS), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const doc = await db.collection('documents').findOneAndDelete({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'not found' });
    await bucket.delete(new ObjectId(doc.file_id)).catch(() => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'delete failed' }); }
});

/* ----------------------------- static app (signed-in only) ----------------------------- */
app.use(express.static(appDir, {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); }
  }
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'server error' });
});

const server = app.listen(PORT, () => console.log(`Compliance Tracker running on port ${PORT}${PROD ? ' (production)' : ''}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(async () => { await client.close(); process.exit(0); }));
}
