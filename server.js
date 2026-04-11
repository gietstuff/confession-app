const express      = require('express');
const bodyParser   = require('body-parser');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
let webpush = null;
try {
  webpush = require('web-push');
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@giet.edu'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('Web Push ready');
} catch(e) {
  console.warn('web-push not installed — run: npm install web-push');
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT FILTER ENGINE  (rule-based only — free, instant, no external calls)
// ══════════════════════════════════════════════════════════════════════════════

// Phone numbers: Indian 10-digit, +91 prefix, international
const PHONE_RE = /(\+?91[\s\-]?)?[6-9]\d{9}/g;

// Email addresses
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Social handles: @username
const HANDLE_RE = /@[a-zA-Z0-9_.]{2,}/g;

// URLs / links
const LINK_RE = /https?:\/\/[^\s]+/gi;

// ── Abusive words — English + Hindi/Hinglish ─────────────────────────────────
// Add more words to either list at any time — they auto-compile into the regex
const ABUSE_EN = [
  'fuck','fucking','fucked','fucker','fucks','bitch','bitches','shit','shitty',
  'asshole','bastard','cunt','dick','cock','pussy','whore','slut',
  'nigger','nigga','faggot','retard','rape','rapist','molest','kys',
  'motherfucker','mf','piss','bollocks',
];
const ABUSE_HI = [
  'chutiya','chutiye','bhenchod','madarchod','bhosdike','bhosdika','bsdk',
  'lodu','lauda','lavde','gaand','mc','bc','randi','harami','kamina',
  'saala','saali','gadha','gandu','jhant','lund','chut','bhosdi',
  'maderchod','bhencho','kutte','kutiya','chodu','chod','chodna','choda',
];

const ABUSE_RE = new RegExp(
  '(?<![a-zA-Z])(' +
  [...ABUSE_EN, ...ABUSE_HI]
    .sort((a,b) => b.length - a.length)            // longer phrases first
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') +
  ')(?![a-zA-Z])',
  'gi'
);

// ── Common Indian first names ─────────────────────────────────────────────────
// These get replaced with [Name] — add names specific to your college freely
const COMMON_NAMES = [
  'aarav','aditya','akash','akshay','amit','amitesh','ananya','anjali','ankit',
  'ankita','arjun','aryan','ashish','bhavya','deepak','deepika','devansh',
  'dhruv','divya','gaurav','harsh','harshit','ishaan','janhvi','jay','karan',
  'kavya','komal','krishna','kunal','manish','mehul','mohit','naman','neha',
  'nikhil','nikita','nishant','palak','parth','pooja','prachi','prakash',
  'prashant','prateek','pratik','priya','priyanshi','rahul','raj','rajat',
  'rajesh','ravi','ritesh','rohit','ruchika','sachin','sahil','sakshi',
  'sandeep','sanjay','shivam','shreya','siddharth','simran','sneha','soham',
  'sourav','sumit','suraj','tanvi','tushar','udit','vaibhav','vandana',
  'vibhav','vikash','vikas','vishal','yash','yashasvi','zara',
];
const NAME_RE = new RegExp(
  '\\b(' + COMMON_NAMES.join('|') + ')\\b',
  'gi'
);

// Blur: first char + asterisks + last char  →  "fuck" becomes "f**k"
function blurWord(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

// ── Main filter function ──────────────────────────────────────────────────────
// Returns { cleanText, flags, wasEdited }
// flags: string[] — list of what was found, shown as badges in admin panel
function filterConfession(rawText) {
  const flags = [];
  let text = rawText;

  // 1. Links
  if (LINK_RE.test(text)) { flags.push('link'); text = text.replace(LINK_RE, '[link removed]'); }
  LINK_RE.lastIndex = 0;

  // 2. Phone numbers
  if (PHONE_RE.test(text)) { flags.push('phone'); text = text.replace(PHONE_RE, '[number hidden]'); }
  PHONE_RE.lastIndex = 0;

  // 3. Emails
  if (EMAIL_RE.test(text)) { flags.push('email'); text = text.replace(EMAIL_RE, '[email hidden]'); }

  // 4. Social handles
  if (HANDLE_RE.test(text)) { flags.push('handle'); text = text.replace(HANDLE_RE, '[handle hidden]'); }

  // 5. Abusive words — blur but keep the confession
  if (ABUSE_RE.test(text)) {
    flags.push('abuse');
    text = text.replace(ABUSE_RE, m => blurWord(m));
  }
  ABUSE_RE.lastIndex = 0;

  // 6. Names — replace with [Name], note it was edited
  if (NAME_RE.test(text)) {
    flags.push('name');
    text = text.replace(NAME_RE, '[Name]');
  }
  NAME_RE.lastIndex = 0;

  return {
    cleanText: text,
    flags,
    wasEdited: text !== rawText,
  };
}


// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol, repliesCol, settingsCol, pushSubCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db   = client.db('giet_confession');
  confCol      = db.collection('confessions');
  pendingCol   = db.collection('pending');
  analyticsCol = db.collection('analytics');
  uniqueCol    = db.collection('unique_visitors');
  repliesCol   = db.collection('replies');
  settingsCol  = db.collection('settings');
  pushSubCol   = db.collection('push_subscriptions');
  console.log('MongoDB connected');

  await analyticsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { visits: 0, uniqueVisitors: 0, activeVisitors: 0 } }, { upsert: true });
  await settingsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { autoApprove: false } }, { upsert: true });
  await pushSubCol.createIndex({ endpoint: 1 }, { unique: true });
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
  if (!LOGIN_RATE_LIMIT.has(ip)) { LOGIN_RATE_LIMIT.set(ip, { count: 1, resetTime: now + 60000 }); return true; }
  const r = LOGIN_RATE_LIMIT.get(ip);
  if (now > r.resetTime) { r.count = 1; r.resetTime = now + 60000; return true; }
  return ++r.count <= 5;
}
setInterval(() => { const now=Date.now(); for(const[t,s]of adminSessions.entries())if(s.expiresAt<now)adminSessions.delete(t); }, 60000);
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

// ── Push helper ───────────────────────────────────────────────────────────────
async function pushAll(payload, type = 'user') {
  if (!webpush) return;
  const filter = type === 'all' ? {} : { type };
  const subs = await pushSubCol.find(filter).toArray();
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try { await webpush.sendNotification(sub.subscription, JSON.stringify(payload)); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint); }
  }));
  if (dead.length) await pushSubCol.deleteMany({ endpoint: { $in: dead } });
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// VAPID public key
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// Subscribe (user)
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await pushSubCol.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { subscription, type: 'user', updatedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await pushSubCol.deleteOne({ endpoint });
  res.json({ status: 'ok' });
});

// Submit confession
app.post('/api/confessions', async (req, res) => {
  const { message, clientId, category } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.trim().split(/\s+/).filter(Boolean).length > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  // ── Run content filter (free, instant, no external calls) ────────────────
  const { cleanText, flags, wasEdited } = filterConfession(message.trim());

  const settings = await settingsCol.findOne({ _id: 'main' });
  const autoApprove = settings?.autoApprove || false;

  const { batch } = req.body; // optional: { year: '2nd', branch: 'CSE' }
  const confession = {
    id: uuidv4(),
    message: cleanText,
    originalMessage: wasEdited ? message.trim() : undefined,
    category: category || '💭 Random',
    batch: batch || null,
    createdAt: Date.now(),
    likes: 0, dislikes: 0, votes: {},
    approved: autoApprove,
    flags: 0, flaggedBy: [],
    filterFlags: flags,
    wasEdited,
    pollVotes: (category === '📊 Poll') ? [0, 0] : undefined,
    pollVoters: (category === '📊 Poll') ? [] : undefined,
    reactCounts: {},
    reacts: {},
  };

  if (autoApprove) {
    await confCol.insertOne(confession);
    pushAll({ title: '💌 New Confession on GIET!',
      body: cleanText.slice(0, 90) + (cleanText.length > 90 ? '…' : ''),
      url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
  } else {
    await pendingCol.insertOne(confession);
    pushAll({ title: '🔔 New Confession Pending',
      body: 'A new confession needs your approval.',
      url: 'https://page-confession.vercel.app/admin.html' }, 'admin').catch(()=>{});
  }

  if (clientId) {
    const exists = await uniqueCol.findOne({ _id: clientId });
    if (!exists) {
      await uniqueCol.insertOne({ _id: clientId });
      await analyticsCol.updateOne({ _id: 'main' }, { $inc: { uniqueVisitors: 1 } });
    }
  }

  // Tell the submitter if their message was edited — honest + transparent
  return res.json({
    status: autoApprove ? 'approved' : 'pending',
    edited: wasEdited,
    editedFields: flags,
    confessionId: confession.id,
  });
});

// Get approved confessions
app.get('/api/confessions', async (req, res) => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const data = await confCol.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).toArray();
  res.json(data);
});

// Like / Dislike
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

// Flag
app.post('/api/flag/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.flaggedBy || []).includes(clientId)) return res.json({ flags: item.flags, alreadyFlagged: true });
  await confCol.updateOne({ id: req.params.id }, { $inc: { flags: 1 }, $push: { flaggedBy: clientId } });
  res.json({ flags: (item.flags || 0) + 1 });
});

// Replies
app.get('/api/replies/:confessionId', async (req, res) => {
  const replies = await repliesCol.find({ confessionId: req.params.confessionId }).sort({ createdAt: 1 }).toArray();
  res.json(replies);
});
app.post('/api/replies/:confessionId', async (req, res) => {
  const { message, clientId } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Reply cannot be empty.' });
  if (message.trim().length > 500) return res.status(400).json({ error: 'Reply too long.' });
  const conf = await confCol.findOne({ id: req.params.confessionId });
  if (!conf) return res.status(404).json({ error: 'Confession not found' });
  const reply = { id: uuidv4(), confessionId: req.params.confessionId, message: message.trim(), createdAt: Date.now() };
  await repliesCol.insertOne(reply);
  res.json({ status: 'ok', reply });
});

// Bulk reply counts — POST /api/replies/counts { ids: [...] }
app.post('/api/replies/counts', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
  const counts = await repliesCol.aggregate([
    { $match: { confessionId: { $in: ids } } },
    { $group: { _id: '$confessionId', count: { $sum: 1 } } }
  ]).toArray();
  const map = {};
  counts.forEach(c => { map[c._id] = c.count; });
  res.json(map);
});

// Pending
app.get('/api/pending', async (req, res) => {
  const data = await pendingCol.find({}).sort({ flags: -1, createdAt: -1 }).toArray();
  res.json(data);
});
app.get('/api/pending-count', async (req, res) => {
  const count = await pendingCol.countDocuments({});
  res.json({ count });
});

// Visit / Analytics
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
app.get('/api/settings', async (req, res) => {
  const s = await settingsCol.findOne({ _id: 'main' });
  res.json({ autoApprove: s?.autoApprove || false });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Admin push subscribe
app.post('/api/admin/push/subscribe', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await pushSubCol.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { subscription, type: 'admin', updatedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 1 minute.' });
  if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid password' });
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
    pushAll({ title: '💌 New Confession on GIET!',
      body: rest.message.slice(0, 90) + (rest.message.length > 90 ? '…' : ''),
      url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
    return res.json({ updated: rest });
  }
  if (action === 'reject') {
    await pendingCol.deleteOne({ id: confessionId });
    return res.json({ updated: item });
  }
  res.status(400).json({ error: 'Invalid action' });
});

app.post('/api/admin/approve-all', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const pending = await pendingCol.find({}).toArray();
  if (!pending.length) return res.json({ approved: 0 });
  const toInsert = pending.map(({ _id, ...rest }) => ({ ...rest, approved: true }));
  await confCol.insertMany(toInsert);
  await pendingCol.deleteMany({});
  pushAll({ title: `💌 ${pending.length} New Confession${pending.length > 1 ? 's' : ''} on GIET!`,
    body: 'Fresh confessions just dropped — come check them out!',
    url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
  res.json({ approved: pending.length });
});

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


// ── Reactions (5 emoji) ───────────────────────────────────────────────────────
app.post('/api/react/:id', async (req, res) => {
  const { clientId, emoji } = req.body;
  const VALID = ['❤️','😂','😮','🥺','🔥'];
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!VALID.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  const key = `reacts.${clientId}`;
  const prev = item.reacts?.[clientId];
  const update = { $set: { [key]: emoji } };
  if (!item.reacts) update.$set['reacts'] = { [clientId]: emoji };
  // Decrement old, increment new
  if (prev) {
    update.$inc = { [`reactCounts.${prev}`]: -1, [`reactCounts.${emoji}`]: 1 };
  } else {
    update.$inc = { [`reactCounts.${emoji}`]: 1 };
  }
  await confCol.updateOne({ id: req.params.id }, update);
  const updated = await confCol.findOne({ id: req.params.id });
  res.json({ reactCounts: updated.reactCounts || {} });
});

// ── Poll vote ─────────────────────────────────────────────────────────────────
app.post('/api/poll/:id', async (req, res) => {
  const { clientId, option } = req.body; // option: 0 or 1
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (option !== 0 && option !== 1) return res.status(400).json({ error: 'Invalid option' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item || item.category !== '📊 Poll') return res.status(404).json({ error: 'Poll not found' });
  if ((item.pollVoters || []).includes(clientId))
    return res.json({ votes: item.pollVotes || [0,0], alreadyVoted: true });
  const votes = item.pollVotes || [0, 0];
  votes[option] = (votes[option] || 0) + 1;
  await confCol.updateOne({ id: req.params.id },
    { $set: { pollVotes: votes }, $push: { pollVoters: clientId } });
  res.json({ votes });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
