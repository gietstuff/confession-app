const express    = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db  = client.db('giet_confession');
  confCol      = db.collection('confessions');
  pendingCol   = db.collection('pending');
  analyticsCol = db.collection('analytics');
  uniqueCol    = db.collection('unique_visitors');
  console.log('MongoDB connected');
  // Ensure analytics doc exists
  await analyticsCol.updateOne(
    { _id: 'main' },
    { $setOnInsert: { visits: 0, uniqueVisitors: 0, activeVisitors: 0 } },
    { upsert: true }
  );
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://page-confession.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// ── Auth ──────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD || 'gietAdmin123';
const SESSION_TIMEOUT  = 3600000;
const LOGIN_RATE_LIMIT = new Map();
const adminSessions    = new Map();
const activeVisitors   = new Map();

function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const s = adminSessions.get(token);
  if (s.expiresAt < Date.now()) { adminSessions.delete(token); return false; }
  return true;
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!LOGIN_RATE_LIMIT.has(ip)) {
    LOGIN_RATE_LIMIT.set(ip, { count: 1, resetTime: now + 60000 });
    return true;
  }
  const r = LOGIN_RATE_LIMIT.get(ip);
  if (now > r.resetTime) { r.count = 1; r.resetTime = now + 60000; return true; }
  return ++r.count <= 5;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of adminSessions.entries()) if (s.expiresAt < now) adminSessions.delete(t);
}, 60000);

// ── Cleanup old confessions from DB ───────────────────────────────────────────
async function cleanupOld() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  await confCol.deleteMany({ createdAt: { $lt: cutoff } });
  await pendingCol.deleteMany({ createdAt: { $lt: cutoff } });
}

function cleanupActiveVisitors() {
  const cutoff = Date.now() - 30000;
  for (const [id, ts] of activeVisitors.entries()) if (ts < cutoff) activeVisitors.delete(id);
}

setInterval(cleanupOld, 10 * 60 * 1000);
setInterval(cleanupActiveVisitors, 5000);

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/confessions', async (req, res) => {
  const { message, clientId, category } = req.body;
  if (!message || typeof message !== 'string' || !message.trim())
    return res.status(400).json({ error: 'Message cannot be empty.' });
  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const confession = {
    id: uuidv4(),
    message: message.trim(),
    category: category || '💭 Random',
    createdAt: Date.now(),
    likes: 0,
    dislikes: 0,
    votes: {},
    approved: false,
  };

  await pendingCol.insertOne(confession);

  if (clientId) {
    const exists = await uniqueCol.findOne({ _id: clientId });
    if (!exists) {
      await uniqueCol.insertOne({ _id: clientId });
      await analyticsCol.updateOne({ _id: 'main' }, { $inc: { uniqueVisitors: 1 } });
    }
  }

  return res.json({ status: 'pending' });
});

app.get('/api/confessions', async (req, res) => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const data = await confCol.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).toArray();
  res.json(data);
});

app.post('/api/like/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Confession not found' });
  if (item.votes?.[clientId] === 'like')
    return res.json({ likes: item.likes, dislikes: item.dislikes });
  const update = { $inc: { likes: 1 }, $set: { [`votes.${clientId}`]: 'like' } };
  if (item.votes?.[clientId] === 'dislike') update.$inc.dislikes = -1;
  await confCol.updateOne({ id: req.params.id }, update);
  const updated = await confCol.findOne({ id: req.params.id });
  res.json({ likes: updated.likes, dislikes: updated.dislikes });
});

app.post('/api/dislike/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Confession not found' });
  if (item.votes?.[clientId] === 'dislike')
    return res.json({ likes: item.likes, dislikes: item.dislikes });
  const update = { $inc: { dislikes: 1 }, $set: { [`votes.${clientId}`]: 'dislike' } };
  if (item.votes?.[clientId] === 'like') update.$inc.likes = -1;
  await confCol.updateOne({ id: req.params.id }, update);
  const updated = await confCol.findOne({ id: req.params.id });
  res.json({ likes: updated.likes, dislikes: updated.dislikes });
});

app.get('/api/pending', async (req, res) => {
  const data = await pendingCol.find({}).sort({ createdAt: -1 }).toArray();
  res.json(data);
});

app.post('/api/visit', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const exists = await uniqueCol.findOne({ _id: clientId });
  if (!exists) {
    await uniqueCol.insertOne({ _id: clientId });
    await analyticsCol.updateOne({ _id: 'main' }, { $inc: { visits: 1, uniqueVisitors: 1 } });
  }

  activeVisitors.set(clientId, Date.now());
  await analyticsCol.updateOne({ _id: 'main' }, { $set: { activeVisitors: activeVisitors.size } });

  const stats = await analyticsCol.findOne({ _id: 'main' });
  res.json({ status: 'ok', visits: stats.visits, uniqueVisitors: stats.uniqueVisitors, activeVisitors: activeVisitors.size });
});

app.get('/api/analytics', async (req, res) => {
  const stats = await analyticsCol.findOne({ _id: 'main' });
  res.json({ visits: stats?.visits || 0, uniqueVisitors: stats?.uniqueVisitors || 0, activeVisitors: activeVisitors.size });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginRateLimit(ip))
    return res.status(429).json({ error: 'Too many attempts. Try again in 1 minute.' });
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Invalid password' });
  const token = uuidv4();
  adminSessions.set(token, { expiresAt: Date.now() + SESSION_TIMEOUT });
  res.cookie('admin_token', token, { httpOnly: true, secure: true, sameSite: 'none', maxAge: SESSION_TIMEOUT });
  return res.json({ message: 'OK', token, expiresIn: SESSION_TIMEOUT / 1000 });
});

app.post('/api/admin/moderate', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId, action } = req.body;
  const item = await pendingCol.findOne({ id: confessionId });
  if (!item) return res.status(404).json({ error: 'Not found in pending' });
  if (action === 'approve') {
    const { _id, ...rest } = item;
    rest.approved = true;
    await confCol.insertOne(rest);
    await pendingCol.deleteOne({ id: confessionId });
    return res.json({ updated: rest });
  }
  if (action === 'reject') {
    await pendingCol.deleteOne({ id: confessionId });
    return res.json({ updated: item });
  }
  res.status(400).json({ error: 'Invalid action' });
});

app.post('/api/admin/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  const r1 = await confCol.deleteOne({ id: confessionId });
  if (r1.deletedCount) return res.json({ removed: confessionId });
  const r2 = await pendingCol.deleteOne({ id: confessionId });
  if (r2.deletedCount) return res.json({ removed: confessionId });
  res.status(404).json({ error: 'Confession not found' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
