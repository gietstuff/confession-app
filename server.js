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
// CONTENT FILTER ENGINE  v3 — AI-first, regex fallback
// ══════════════════════════════════════════════════════════════════════════════
// LEARN: We call Claude API (claude-haiku-4-5 — cheapest model) to understand
// context. It catches things regex never could: nicknames, roll numbers written
// as text, creative spellings of abuse words, indirect threats, etc.
// If the API call fails (network, quota) we fall back to regex so the server
// never goes down just because AI is unavailable.
// ──────────────────────────────────────────────────────────────────────────────

const PHONE_RE  = /(\+?91[\s\-]?)?[6-9]\d{9}/g;
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const HANDLE_RE = /@[a-zA-Z0-9_.]{2,}/g;
const LINK_RE   = /https?:\/\/[^\s]+/gi;

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
  [...ABUSE_EN, ...ABUSE_HI].sort((a,b)=>b.length-a.length)
    .map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') +
  ')(?![a-zA-Z])', 'gi'
);
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
const NAME_RE = new RegExp('\\b(' + COMMON_NAMES.join('|') + ')\\b', 'gi');

function blurWord(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

// ── Regex-only fallback filter (used when AI is unavailable) ──
function filterRegex(rawText) {
  const flags = []; let text = rawText;
  if (LINK_RE.test(text))   { flags.push('link');   text = text.replace(LINK_RE,   '[link removed]');   } LINK_RE.lastIndex=0;
  if (PHONE_RE.test(text))  { flags.push('phone');  text = text.replace(PHONE_RE,  '[number hidden]');  } PHONE_RE.lastIndex=0;
  if (EMAIL_RE.test(text))  { flags.push('email');  text = text.replace(EMAIL_RE,  '[email hidden]');   }
  if (HANDLE_RE.test(text)) { flags.push('handle'); text = text.replace(HANDLE_RE, '[handle hidden]');  }
  if (ABUSE_RE.test(text))  { flags.push('abuse');  text = text.replace(ABUSE_RE,  m=>blurWord(m));     } ABUSE_RE.lastIndex=0;
  if (NAME_RE.test(text))   { flags.push('name');   text = text.replace(NAME_RE,   '[Name]');           } NAME_RE.lastIndex=0;
  return { cleanText: text, flags, wasEdited: text !== rawText };
}

// ── AI filter using Claude API ──
// LEARN: We use claude-haiku-4-5 (fastest, cheapest). We give it a strict JSON
// schema to fill — this is called "structured output prompting". We tell it:
// return ONLY JSON, no explanation. Then we parse it.
// The model understands context: "Kh___" is a name hint, "2k22CS045" is a roll
// number, "bc" in Hinglish context is abuse, etc.
async function filterWithAI(rawText) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('No ANTHROPIC_API_KEY');

  const prompt = `You are a content moderator for a college anonymous confession website (Indian college, GIET University).
Your job: clean the message so no one can be identified or harassed.

Rules:
1. NAMES: Replace any real person's name (even partial like "Kh___" or "that girl from sec-F") with [Name]
2. ROLL NUMBERS: Replace roll numbers, student IDs (e.g. 2k22CS045, 22EGCS001) with [roll hidden]  
3. PHONE NUMBERS: Replace Indian phone numbers (10 digits, starting 6-9, or +91 prefix) with [number hidden]
4. EMAILS/HANDLES: Replace emails and @handles with [contact hidden]
5. LINKS: Replace URLs with [link removed]
6. ABUSE: Blur abusive words (English and Hindi/Hinglish: fuck, chutiya, bsdk, mc, bc used as abuse, etc.) using asterisks like f**k
7. SECTION/CLASS hints: If someone says "sec-F girl" or "that CSE-B guy" in a way that identifies a person, replace the identifying part with [section hidden]
8. HARMLESS content: Do NOT flag normal words. "bc" meaning "because" is fine. Context matters.

Respond ONLY with this JSON (no other text, no markdown):
{
  "cleanText": "<the cleaned message>",
  "flags": ["name"|"roll"|"phone"|"email"|"handle"|"link"|"abuse"|"section"],
  "wasEdited": true|false,
  "aiReasoning": "<one sentence explaining what you changed and why, or 'No changes needed'>"
}

Message to clean:
${rawText}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) throw new Error(`AI API error: ${resp.status}`);
  const data = await resp.json();
  const raw = data.content?.[0]?.text || '';

  // Strip markdown code fences if model adds them
  const jsonStr = raw.replace(/```json\n?|```/g, '').trim();
  const parsed = JSON.parse(jsonStr);

  // Validate shape
  if (!parsed.cleanText || typeof parsed.wasEdited !== 'boolean') {
    throw new Error('Invalid AI response shape');
  }

  return {
    cleanText: parsed.cleanText,
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    wasEdited: parsed.wasEdited,
    aiReasoning: parsed.aiReasoning || '',
    usedAI: true
  };
}

// ── Main filter — tries AI first, falls back to regex ──
// LEARN: async/await means this returns a Promise. The caller must await it.
// The "|| filterRegex(rawText)" fallback ensures the site never breaks if
// the AI API is down or the key is missing.
async function filterConfession(rawText) {
  try {
    const result = await filterWithAI(rawText);
    console.log(`[AI filter] "${rawText.slice(0,40)}…" → flags: [${result.flags}] | ${result.aiReasoning}`);
    return result;
  } catch(err) {
    console.warn('[AI filter] Failed, using regex fallback:', err.message);
    return { ...filterRegex(rawText), usedAI: false, aiReasoning: 'AI unavailable — regex filter used' };
  }
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol, repliesCol, settingsCol, pushSubCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('giet_confession');
  confCol      = db.collection('confessions');
  pendingCol   = db.collection('pending');
  analyticsCol = db.collection('analytics');
  uniqueCol    = db.collection('unique_visitors');
  repliesCol   = db.collection('replies');
  settingsCol  = db.collection('settings');
  pushSubCol   = db.collection('push_subscriptions');
  console.log('MongoDB connected');

  await analyticsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { visits: 0, uniqueVisitors: 0 } }, { upsert: true });
  await settingsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { autoApprove: false } }, { upsert: true });
  await pushSubCol.createIndex({ endpoint: 1 }, { unique: true });
  // TTL index on lastSeen: documents auto-expire after 90s
  // LEARN: MongoDB TTL index deletes docs automatically — "online now" = docs with recent lastSeen.
  // Survives Render cold starts (in-memory Map does not).
  await uniqueCol.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 90, background: true });
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
// activeVisitors is now DB-backed via uniqueCol.lastSeen (TTL index)

function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const s = adminSessions.get(token);
  if (s.expiresAt < Date.now()) { adminSessions.delete(token); return false; }
  return true;
}
function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!LOGIN_RATE_LIMIT.has(ip)) { LOGIN_RATE_LIMIT.set(ip, { count: 1, resetTime: now+60000 }); return true; }
  const r = LOGIN_RATE_LIMIT.get(ip);
  if (now > r.resetTime) { r.count = 1; r.resetTime = now+60000; return true; }
  return ++r.count <= 5;
}
setInterval(() => { const now=Date.now(); for(const[t,s]of adminSessions.entries())if(s.expiresAt<now)adminSessions.delete(t); }, 60000);

// ── Feature 3: Keep last 200 confessions instead of 24h expiry ───────────────
const MAX_CONFESSIONS = 200;
async function enforceConfessionLimit() {
  const total = await confCol.countDocuments({});
  if (total > MAX_CONFESSIONS) {
    // Find the oldest beyond limit and delete them + their replies
    const toDelete = await confCol
      .find({}, { projection: { id: 1 } })
      .sort({ createdAt: 1 })
      .limit(total - MAX_CONFESSIONS)
      .toArray();
    const ids = toDelete.map(d => d.id);
    await confCol.deleteMany({ id: { $in: ids } });
    await repliesCol.deleteMany({ confessionId: { $in: ids } });
    console.log(`Pruned ${ids.length} old confession(s) to stay under ${MAX_CONFESSIONS}`);
  }
}
// Also remove the old 24h pending cleanup — keep pending indefinitely until moderated
async function cleanupOldPending() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // 7 days for pending
  await pendingCol.deleteMany({ createdAt: { $lt: cutoff } });
}
setInterval(cleanupOldPending, 60 * 60 * 1000); // hourly

// ── Feature 4: Confession of the Day ─────────────────────────────────────────
// Cached in memory, refreshed every 24h
let cotdCache = { id: null, refreshedAt: 0 };
async function getConfessionOfTheDay() {
  const now = Date.now();
  if (cotdCache.id && (now - cotdCache.refreshedAt) < 24 * 3600 * 1000) {
    return cotdCache.id;
  }
  // Find the confession with the most likes in the last 7 days
  const cutoff = now - 7 * 24 * 3600 * 1000;
  const top = await confCol
    .find({ createdAt: { $gte: cutoff }, likes: { $gt: 0 } })
    .sort({ likes: -1 })
    .limit(1)
    .toArray();
  if (top.length) {
    cotdCache = { id: top[0].id, refreshedAt: now };
    return top[0].id;
  }
  return null;
}

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

app.get('/api/push/vapid-public-key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));

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

// Submit confession — Feature 1: branch tag, Feature 7: poll support
app.post('/api/confessions', async (req, res) => {
  const { message, clientId, category, branch, poll } = req.body;

  // For polls, the poll.question IS the message — allow empty message field
  const isPoll = category === '📊 Poll' && poll && poll.question?.trim();
  const rawMessage = isPoll ? poll.question.trim() : (message || '').trim();

  if (!rawMessage) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (rawMessage.split(/\s+/).filter(Boolean).length > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const { cleanText, flags, wasEdited, aiReasoning, usedAI } = await filterConfession(rawMessage);

  // Validate branch tag (optional)
  const VALID_YEARS    = ['1st Year','2nd Year','3rd Year','4th Year'];
  const VALID_BRANCHES = ['CSE','AIML','ECE','AGRI','Others'];
  let branchTag = null;
  if (branch && branch.year && branch.branch) {
    if (VALID_YEARS.includes(branch.year) && VALID_BRANCHES.includes(branch.branch)) {
      branchTag = { year: branch.year, branch: branch.branch };
    }
  }

  const settings = await settingsCol.findOne({ _id: 'main' });
  const autoApprove = settings?.autoApprove || false;

  const confession = {
    id: uuidv4(),
    message: cleanText,
    originalMessage: wasEdited ? rawMessage : undefined,
    category: category || '💭 Random',
    branchTag,
    createdAt: Date.now(),
    likes: 0, dislikes: 0, votes: {},
    reactions: { '❤️':0, '😮':0, '😂':0, '🥺':0, '🔥':0 },
    reactedBy: {},
    approved: autoApprove,
    flags: 0, flaggedBy: [],
    filterFlags: flags,
    wasEdited,
    aiReasoning: aiReasoning||'',
    usedAI: !!usedAI,
    // ── Poll fields ──
    isPoll: !!isPoll,
    pollOptions: isPoll ? { a: (poll.optA||'Yes').slice(0,60), b: (poll.optB||'No').slice(0,60) } : null,
    pollVotes: isPoll ? { a: 0, b: 0 } : null,
    pollUserVotes: isPoll ? {} : null,
  };

  if (autoApprove) {
    await confCol.insertOne(confession);
    await enforceConfessionLimit();
    pushAll({ title: '💌 New Confession on GIET!',
      body: cleanText.slice(0,90) + (cleanText.length>90?'…':''),
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
  return res.json({ status: autoApprove ? 'approved' : 'pending', edited: wasEdited, editedFields: flags, confessionId: confession.id });
});

// Get approved confessions — Feature 3: last 200, Feature 4: COTD pinned first
app.get('/api/confessions', async (req, res) => {
  // Exclude reportHidden confessions from public feed
  const data = await confCol.find({ reportHidden: { $ne: true } }).sort({ createdAt: -1 }).limit(MAX_CONFESSIONS).toArray();
  const cotdId = await getConfessionOfTheDay();
  // Attach cotd flag
  data.forEach(c => { c.isConfessionOfDay = (c.id === cotdId); });
  // Pin COTD to top
  data.sort((a, b) => {
    if (a.isConfessionOfDay) return -1;
    if (b.isConfessionOfDay) return 1;
    return b.createdAt - a.createdAt;
  });
  res.json(data);
});

// Like / Dislike (kept for compatibility)
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

// Feature 5: Emoji reactions endpoint
app.post('/api/react/:id', async (req, res) => {
  const { clientId, emoji } = req.body;
  const VALID_EMOJIS = ['❤️','😮','😂','🥺','🔥'];
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!VALID_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });

  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });

  const prevReaction = item.reactedBy?.[clientId];
  const upd = {};

  if (prevReaction === emoji) {
    // Toggle off — remove reaction
    upd.$inc = { [`reactions.${emoji}`]: -1 };
    upd.$unset = { [`reactedBy.${clientId}`]: '' };
  } else {
    upd.$inc = { [`reactions.${emoji}`]: 1 };
    upd.$set = { [`reactedBy.${clientId}`]: emoji };
    if (prevReaction) upd.$inc[`reactions.${prevReaction}`] = -1;
  }

  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ reactions: u.reactions, myReaction: u.reactedBy?.[clientId] || null });
});

// Flag
app.post('/api/flag/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.flaggedBy||[]).includes(clientId)) return res.json({ flags: item.flags, alreadyFlagged: true });
  await confCol.updateOne({ id: req.params.id }, { $inc: { flags: 1 }, $push: { flaggedBy: clientId } });
  res.json({ flags: (item.flags||0)+1 });
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
// LEARN: DB-backed "online now" count.
// We upsert a lastSeen timestamp per clientId in unique_visitors.
// The TTL index (90s) auto-deletes stale docs, so countDocuments = active users.
// This survives cold starts — in-memory Map resets to 0 every time Render sleeps.
app.post('/api/visit', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const now = Date.now();
  const exists = await uniqueCol.findOne({ _id: clientId });
  if (!exists) {
    await uniqueCol.insertOne({ _id: clientId, firstSeen: now, lastSeen: new Date(now) });
    await analyticsCol.updateOne({ _id: 'main' }, { $inc: { visits: 1, uniqueVisitors: 1 } });
  } else {
    // Update lastSeen — TTL index uses this Date field to expire inactive visitors
    await uniqueCol.updateOne({ _id: clientId }, { $set: { lastSeen: new Date(now) } });
  }
  // Count active = docs with lastSeen in last 90s (TTL index keeps this clean)
  const activeCount = await uniqueCol.countDocuments({ lastSeen: { $gte: new Date(now - 90000) } });
  const stats = await analyticsCol.findOne({ _id: 'main' });
  res.json({ status:'ok', visits: stats.visits, uniqueVisitors: stats.uniqueVisitors, activeVisitors: activeCount });
});
app.get('/api/analytics', async (req, res) => {
  const stats = await analyticsCol.findOne({ _id: 'main' });
  const activeCount = await uniqueCol.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 90000) } });
  res.json({ visits: stats?.visits||0, uniqueVisitors: stats?.uniqueVisitors||0, activeVisitors: activeCount });
});
app.get('/api/settings', async (req, res) => {
  const s = await settingsCol.findOne({ _id: 'main' });
  res.json({ autoApprove: s?.autoApprove||false });
});

// ── Poll vote ─────────────────────────────────────────
// LEARN: We store pollUserVotes as { [clientId]: 'a'|'b' } in MongoDB.
// This lets us check per-user votes without a separate collection.
app.post('/api/poll/:id/vote', async (req, res) => {
  const { clientId, option } = req.body;
  if (!clientId || !['a','b'].includes(option))
    return res.status(400).json({ error: 'clientId and option (a or b) required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item || !item.isPoll) return res.status(404).json({ error: 'Poll not found' });
  if (item.pollUserVotes?.[clientId])
    return res.json({ pollVotes: item.pollVotes, alreadyVoted: true });
  await confCol.updateOne({ id: req.params.id }, {
    $inc:  { [`pollVotes.${option}`]: 1 },
    $set:  { [`pollUserVotes.${clientId}`]: option }
  });
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ pollVotes: u.pollVotes });
});

// ── "This is me!" ─────────────────────────────────────
// LEARN: thisIsMe is an array of clientIds stored on the confession document.
// We use $push to append and check for duplicates before pushing.
app.post('/api/thisisme/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.thisIsMe||[]).includes(clientId))
    return res.json({ count: (item.thisIsMe||[]).length, list: item.thisIsMe||[], alreadyClaimed: true });
  await confCol.updateOne({ id: req.params.id }, { $push: { thisIsMe: clientId } });
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ count: u.thisIsMe.length, list: u.thisIsMe });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════
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
  adminSessions.set(token, { expiresAt: Date.now()+SESSION_TIMEOUT });
  res.cookie('admin_token', token, { httpOnly:true, secure:true, sameSite:'none', maxAge:SESSION_TIMEOUT });
  return res.json({ message:'OK', token, expiresIn: SESSION_TIMEOUT/1000 });
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
    await enforceConfessionLimit();
    pushAll({ title: '💌 New Confession on GIET!',
      body: rest.message.slice(0,90)+(rest.message.length>90?'…':''),
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
  await enforceConfessionLimit();
  pushAll({ title: `💌 ${pending.length} New Confession${pending.length>1?'s':''} on GIET!`,
    body: 'Fresh confessions just dropped — come check them out!',
    url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
  res.json({ approved: pending.length });
});

app.post('/api/admin/auto-approve', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { enabled } = req.body;
  await settingsCol.updateOne({ _id:'main' }, { $set: { autoApprove: !!enabled } });
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

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNITY REPORT SYSTEM
// LEARN: This gives users real power. Instead of just "flag" (which admins
// may never see), users can report with a specific reason. When 3+ unique
// users report the same confession, it gets auto-hidden from the feed and
// moved to a special "reported" queue in the admin panel.
// This is called "community moderation" — used by Reddit, Twitter, etc.
// ══════════════════════════════════════════════════════════════════════════════

const REPORT_THRESHOLD = 3; // auto-hide after this many unique reports

app.post('/api/report/:id', async (req, res) => {
  const { clientId, reason } = req.body;
  // reason options: 'identity' | 'harassment' | 'fake' | 'spam' | 'other'
  const VALID_REASONS = ['identity', 'harassment', 'fake', 'spam', 'other'];
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });

  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });

  // Check if this client already reported
  const alreadyReported = (item.reports||[]).some(r => r.clientId === clientId);
  if (alreadyReported) return res.json({ alreadyReported: true, reportCount: item.reports.length });

  // Add report
  const report = { clientId, reason, reportedAt: Date.now() };
  await confCol.updateOne({ id: req.params.id }, { $push: { reports: report } });

  // Fetch updated doc
  const updated = await confCol.findOne({ id: req.params.id });
  const reportCount = updated.reports.length;

  // Auto-hide if threshold reached
  if (reportCount >= REPORT_THRESHOLD && !item.reportHidden) {
    await confCol.updateOne({ id: req.params.id }, { $set: { reportHidden: true } });
    console.log(`[Reports] Confession ${req.params.id} auto-hidden after ${reportCount} reports`);
  }

  res.json({ status: 'reported', reportCount, autoHidden: reportCount >= REPORT_THRESHOLD });
});

// Get reported confessions (admin only)
app.get('/api/reported', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await confCol.find({ 'reports.0': { $exists: true } })
    .sort({ 'reports.length': -1, createdAt: -1 }).limit(100).toArray();
  res.json(data);
});

// Restore a reported confession (admin clears reports and unhides)
app.post('/api/admin/restore', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  await confCol.updateOne({ id: confessionId }, { $set: { reports: [], reportHidden: false } });
  res.json({ status: 'restored' });
});
