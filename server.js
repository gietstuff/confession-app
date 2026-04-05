const express      = require('express');
const bodyParser   = require('body-parser');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol, repliesCol, settingsCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db   = client.db('giet_confession');
  confCol    = db.collection('confessions');
  pendingCol = db.collection('pending');
  analyticsCol = db.collection('analytics');
  uniqueCol  = db.collection('unique_visitors');
  repliesCol = db.collection('replies');
  settingsCol= db.collection('settings');
  console.log('MongoDB connected');

  await analyticsCol.updateOne(
    { _id: 'main' },
    { $setOnInsert: { visits: 0, uniqueVisitors: 0, activeVisitors: 0 } },
    { upsert: true }
  );
  // Default settings
  await settingsCol.updateOne(
    { _id: 'main' },
    { $setOnInsert: { autoApprove: false } },
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

// Submit confession
app.post('/api/confessions', async (req, res) => {
  const { message, clientId, category } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.trim().split(/\s+/).filter(Boolean).length > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const settings = await settingsCol.findOne({ _id: 'main' });
  const autoApprove = settings?.autoApprove || false;

  const confession = {
    id: uuidv4(),
    message: message.trim(),
    category: category || '💭 Random',
    createdAt: Date.now(),
    likes: 0, dislikes: 0, votes: {},
    approved: autoApprove,
    flags: 0, flaggedBy: [],
  };

  if (autoApprove) {
    await confCol.insertOne(confession);
  } else {
    await pendingCol.insertOne(confession);
  }

  if (clientId) {
    const exists = await uniqueCol.findOne({ _id: clientId });
    if (!exists) {
      await uniqueCol.insertOne({ _id: clientId });
      await analyticsCol.updateOne({ _id: 'main' }, { $inc: { uniqueVisitors: 1 } });
    }
  }

  return res.json({ status: autoApprove ? 'approved' : 'pending' });
});

// Get approved confessions
app.get('/api/confessions', async (req, res) => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const data = await confCol.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).toArray();
  res.json(data);
});

// Like
app.post('/api/like/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.votes?.[clientId] === 'like') return res.json({ likes: item.likes, dislikes: item.dislikes });
  const upd = { $inc: { likes: 1 }, $set: { [`votes.${clientId}`]: 'like' } };
  if (item.votes?.[clientId] === 'dislike') upd.$inc.dislikes = -1;
  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ likes: u.likes, dislikes: u.dislikes });
});

// Dislike
app.post('/api/dislike/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.votes?.[clientId] === 'dislike') return res.json({ likes: item.likes, dislikes: item.dislikes });
  const upd = { $inc: { dislikes: 1 }, $set: { [`votes.${clientId}`]: 'dislike' } };
  if (item.votes?.[clientId] === 'like') upd.$inc.likes = -1;
  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ likes: u.likes, dislikes: u.dislikes });
});

// ── FLAG a confession ─────────────────────────────────────────────────────────
app.post('/api/flag/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.flaggedBy || []).includes(clientId))
    return res.json({ flags: item.flags, alreadyFlagged: true });
  await confCol.updateOne(
    { id: req.params.id },
    { $inc: { flags: 1 }, $push: { flaggedBy: clientId } }
  );
  res.json({ flags: (item.flags || 0) + 1 });
});

// ── REPLIES ───────────────────────────────────────────────────────────────────
// Get replies for a confession
app.get('/api/replies/:confessionId', async (req, res) => {
  const replies = await repliesCol
    .find({ confessionId: req.params.confessionId })
    .sort({ createdAt: 1 })
    .toArray();
  res.json(replies);
});

// Post a reply
app.post('/api/replies/:confessionId', async (req, res) => {
  const { message, clientId } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Reply cannot be empty.' });
  if (message.trim().length > 500) return res.status(400).json({ error: 'Reply too long (max 500 chars).' });

  // Check confession exists
  const conf = await confCol.findOne({ id: req.params.confessionId });
  if (!conf) return res.status(404).json({ error: 'Confession not found' });

  const reply = {
    id: uuidv4(),
    confessionId: req.params.confessionId,
    message: message.trim(),
    createdAt: Date.now(),
  };
  await repliesCol.insertOne(reply);
  res.json({ status: 'ok', reply });
});

// Pending
app.get('/api/pending', async (req, res) => {
  // Flagged confessions bubble to top
  const data = await pendingCol.find({}).sort({ flags: -1, createdAt: -1 }).toArray();
  res.json(data);
});

// Visit
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

// Pending count (for admin polling)
app.get('/api/pending-count', async (req, res) => {
  const count = await pendingCol.countDocuments({});
  res.json({ count });
});

// Settings (public read — only exposes autoApprove status)
app.get('/api/settings', async (req, res) => {
  const s = await settingsCol.findOne({ _id: 'main' });
  res.json({ autoApprove: s?.autoApprove || false });
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

// Approve ALL pending at once
app.post('/api/admin/approve-all', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const pending = await pendingCol.find({}).toArray();
  if (!pending.length) return res.json({ approved: 0 });
  const toInsert = pending.map(({ _id, ...rest }) => ({ ...rest, approved: true }));
  await confCol.insertMany(toInsert);
  await pendingCol.deleteMany({});
  res.json({ approved: pending.length });
});

// Toggle auto-approve
app.post('/api/admin/auto-approve', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { enabled } = req.body;
  await settingsCol.updateOne({ _id: 'main' }, { $set: { autoApprove: !!enabled } });
  res.json({ autoApprove: !!enabled });
});

app.post('/api/admin/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  const r1 = await confCol.deleteOne({ id: confessionId });
  if (r1.deletedCount) { await repliesCol.deleteMany({ confessionId }); return res.json({ removed: confessionId }); }
  const r2 = await pendingCol.deleteOne({ id: confessionId });
  if (r2.deletedCount) return res.json({ removed: confessionId });
  res.status(404).json({ error: 'Not found' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
