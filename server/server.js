import express from 'express';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { MONGODB_URI, MONGODB_DB = 'compliance_tracker', PORT = 8000 } = process.env;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing. Copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}

const COLLECTIONS = new Set(['tracking', 'projects', 'stage_overrides', 'audit']);
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
await db.collection('audit').createIndex({ key: 1, at: -1 });
console.log(`Connected to MongoDB database "${MONGODB_DB}"`);

const app = express();
app.use(express.json({ limit: '5mb' }));

const guard = (req, res, next) =>
  COLLECTIONS.has(req.params.col) ? next() : res.status(404).json({ error: 'unknown collection' });

const toDoc = ({ _id, ...rest }) => ({ id: String(_id), data: rest });

// List documents. Optional: ?key=...&orderBy=at&dir=desc&limit=25
app.get('/api/:col', guard, async (req, res) => {
  try {
    const { key, orderBy, dir, limit } = req.query;
    const filter = key !== undefined ? { key: String(key) } : {};
    let cur = db.collection(req.params.col).find(filter);
    if (orderBy) cur = cur.sort({ [String(orderBy)]: dir === 'desc' ? -1 : 1 });
    if (limit) cur = cur.limit(Math.min(parseInt(limit, 10) || 0, 1000));
    res.json((await cur.toArray()).map(toDoc));
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Create or replace a document by id.
app.put('/api/:col/:id', guard, async (req, res) => {
  try {
    const { _id, ...data } = req.body || {};
    await db.collection(req.params.col).replaceOne({ _id: req.params.id }, data, { upsert: true });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Append a document with a generated id.
app.post('/api/:col', guard, async (req, res) => {
  try {
    const { _id, ...data } = req.body || {};
    const r = await db.collection(req.params.col).insertOne(data);
    res.json({ ok: true, id: String(r.insertedId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Bulk import (used for one-time migration from browser localStorage). Existing ids are kept.
app.post('/import-all', async (req, res) => {
  try {
    const out = {};
    for (const [col, docs] of Object.entries(req.body || {})) {
      if (!COLLECTIONS.has(col)) continue;
      const ops = Object.entries(docs).map(([id, data]) => ({
        updateOne: { filter: { _id: id }, update: { $setOnInsert: data }, upsert: true }
      }));
      if (ops.length) out[col] = (await db.collection(col).bulkWrite(ops)).upsertedCount;
    }
    res.json({ ok: true, inserted: out });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

app.use('/images', express.static(path.join(here, '..', 'images'), {
  setHeaders: (res, p) => { if (p.endsWith('.avif')) res.setHeader('Content-Type', 'image/avif'); }
}));
app.use(express.static(path.join(here, '..', 'app'), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8'); }
}));

app.listen(PORT, () => console.log(`Compliance Tracker running at http://localhost:${PORT}`));
