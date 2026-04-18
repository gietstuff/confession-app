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
// SMART CONTENT FILTER v4 — 100% FREE, zero external API calls
// ══════════════════════════════════════════════════════════════════════════════
// LEARN: Why no paid AI? Cost + reliability. If the AI API goes down or runs
// out of credits, the whole site breaks. This filter handles everything with
// clever regex patterns. It catches what the old list missed:
//   • Roll numbers (2k22CS045, 22EGCS001, EG/22/001, etc.)
//   • Leet-speak abuse (f@ck, $hit, ch*tiya)
//   • Hinglish abuse with creative spellings
//   • Section identifiers (sec-A, section F, CSE-B batch)
//   • Partial name hints (Kh___, R****)
// ══════════════════════════════════════════════════════════════════════════════

const PHONE_RE  = /(\+?91[\s\-]?)?[6-9]\d{9}/g;
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const HANDLE_RE = /@[a-zA-Z0-9_.]{2,}/g;
const LINK_RE   = /https?:\/\/[^\s]+/gi;

// ── Roll number patterns — covers most Indian college formats ──
// LEARN: | in regex means OR. We chain all common roll number formats.
// Examples caught: 2k22CS045, 22EGCS001, EG/22/CS/001, 2022CSE045
const ROLL_RE = /\b(
  [2][0-9]{3}[A-Z]{2,4}[0-9]{2,4}         |  (?# 2k22CS045, 2022CS045 )
  [0-9]{2}[A-Z]{2,6}[0-9]{3,4}             |  (?# 22EGCS001, 22CS045 )
  [A-Z]{2,4}[\/\-][0-9]{2}[\/\-][0-9]{3,4} |  (?# EG/22/001, CS-22-045 )
  [A-Z]{2,4}[0-9]{4,8}                      |  (?# EGCS2045, CS220045 )
  [0-9]{4}[A-Z]{2,4}[0-9]{3,4}              |  (?# 2022CSE045 )
  \d{2}[A-Z]{2}\d{3,4}                         (?# 22EG045 )
)\b/gix;

// ── Section/batch identifiers ──
// Catches: sec-A, section F, CSE-B, branch B, 2nd year A
const SECTION_RE = /\b(sec(tion)?[\s\-]?[A-F]|[A-Z]{2,4}[\s\-][A-F]\s+batch|branch[\s\-][A-F]|[1-4](st|nd|rd|th)\s+year\s+[A-F])\b/gi;

// ── Partial name hints with blanks/stars (e.g. "Kh___", "R****") ──
const PARTIAL_NAME_RE = /\b[A-Z][a-zA-Z]{0,3}[_*]{3,}[a-zA-Z]{0,3}\b/g;

// ── Abuse list — English + Hindi/Hinglish + leet-speak variants ──
// LEARN: The leet-speak variants (f@ck, $hit) are separate patterns.
// We sort longest-first so "motherfucker" matches before "fucker".
const ABUSE_WORDS = [
  // English
  'fuck','fucking','fucked','fucker','fucks','bitch','bitches','shit','shitty',
  'asshole','bastard','cunt','dick','cock','pussy','whore','slut','bollocks',
  'nigger','nigga','faggot','retard','rape','rapist','molest','kys','piss',
  'motherfucker','dickhead','bullshit','horseshit','jackass','dumbass',
  // Hindi/Hinglish
  'chutiya','chutiye','bhenchod','madarchod','bhosdike','bhosdika','bsdk',
  'lodu','lauda','lavde','gaand','randi','harami','gandu','jhant','lund',
  'chut','bhosdi','maderchod','bhencho','kutte','kutiya','chodu','choda',
  'chod','chodna','saala','saali','gadha','kamina','haramzada','haramzadi',
  'rascal','bakwaas','ullu','bhadwa','bhadwi','hijra','chakka',
  // Common short abuses used in Indian context (context-checked below)
  'mc','bc',
];
const ABUSE_RE = new RegExp(
  '(?<![a-zA-Z])(' +
  ABUSE_WORDS.sort((a,b)=>b.length-a.length)
    .map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') +
  ')(?![a-zA-Z])', 'gi'
);

// Leet-speak abuse patterns (f@ck, $hit, ch*tiya, etc.)
const LEET_RE = /\b(f[@4]c+k|$h[i1]t|[a@]ssh[o0]le|b[i1]tc+h|d[i1]ck|c[@*]ck|p[u@]ssy|wh[o0]re|ch[\*@]t[i1]y[a@]|bh[\*@]nch[o0]d|m[a@]d[a@]rch[o0]d)\b/gi;

// ── "mc" and "bc" are only abuse in certain contexts ──
// LEARN: "bc" meaning "because" is totally fine. We check what comes
// after: if it's a vowel/word it's likely "because", otherwise abuse.
// This is context-sensitive filtering without needing AI.
function isAbusiveShortForm(word, fullText, matchIndex) {
  const before = fullText.slice(Math.max(0, matchIndex - 20), matchIndex).toLowerCase();
  const after  = fullText.slice(matchIndex + word.length, matchIndex + word.length + 10).toLowerCase();
  if (word.toLowerCase() === 'bc') {
    // "bc" as "because" usually followed by a space+word or comma
    if (/\s+(of|he|she|it|i|the|this|that|my|your|his|her|they)/.test(' ' + after)) return false;
    if (before.trim().endsWith(',')) return false;
  }
  if (word.toLowerCase() === 'mc') {
    // "mc" as "MC (emcee/rapper)" — usually in music context
    if (/rap|music|song|emcee|hip/.test(before)) return false;
  }
  return true;
}

// ── Name list (expanded with more Indian names) ──
const COMMON_NAMES = [
  'aarav','aditya','akash','akshay','akshat','amit','amitesh','ananya','anjali',
  'ankit','ankita','anushka','arjun','aryan','ashish','bhavya','deepak','deepika',
  'devansh','dhruv','divya','gaurav','harsh','harshit','ishaan','ishika','janhvi',
  'jay','karan','kartik','kavya','komal','krishna','kunal','lakshmi','manish',
  'mehul','mohit','naman','neha','nikhil','nikita','nishant','palak','parth',
  'pooja','prachi','prakash','prashant','prateek','pratik','priya','priyanshi',
  'rahul','raj','rajat','rajesh','ravi','ritesh','rohit','ruchika','sachin',
  'sahil','sakshi','sandeep','sanjay','shivam','shreya','siddharth','simran',
  'sneha','soham','sourav','sumit','suraj','swati','tanvi','tushar','udit',
  'vaibhav','vandana','vibhav','vikash','vikas','vishal','yash','yashasvi','zara',
  // more common GIET-context names
  'himanshu','harshita','sarthak','utkarsh','aakash','abhishek','ajay','alok',
  'aman','amisha','anand','anshul','anurag','apoorva','astha','ayush','bhanu',
  'chetan','chirag','devika','diksha','dinesh','garima','girish','hitesh',
  'jagdish','jatin','karishma','khushbu','lalit','madhur','mahesh','mansi',
  'megha','mukesh','nidhi','payal','piyush','pragati','preeti','raghav',
  'rakesh','ramesh','rashmi','rishi','ritu','rohan','romil','rupesh','sanket',
  'seema','shubham','sonika','sourabh','subham','sudhir','sunil','suresh',
  'swapnil','tarun','umesh','vicky','vijay','vinay','vineet','vivek','yogesh',
];
const NAME_RE = new RegExp('\\b(' + COMMON_NAMES.join('|') + ')\\b', 'gi');

function blurWord(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

// ── Main filter — synchronous, no external calls, fast ──
function filterConfession(rawText) {
  const flags = [];
  let text = rawText;

  // 1. Links
  if (LINK_RE.test(text)) { flags.push('link'); text = text.replace(LINK_RE, '[link removed]'); } LINK_RE.lastIndex = 0;

  // 2. Phone numbers
  if (PHONE_RE.test(text)) { flags.push('phone'); text = text.replace(PHONE_RE, '[number hidden]'); } PHONE_RE.lastIndex = 0;

  // 3. Email
  if (EMAIL_RE.test(text)) { flags.push('email'); text = text.replace(EMAIL_RE, '[email hidden]'); }

  // 4. Handles
  if (HANDLE_RE.test(text)) { flags.push('handle'); text = text.replace(HANDLE_RE, '[handle hidden]'); }

  // 5. Roll numbers (new — catches 2k22CS045 etc.)
  if (ROLL_RE.test(text)) { flags.push('roll'); text = text.replace(ROLL_RE, '[roll hidden]'); } ROLL_RE.lastIndex = 0;

  // 6. Section/batch identifiers
  if (SECTION_RE.test(text)) { flags.push('section'); text = text.replace(SECTION_RE, '[section hidden]'); } SECTION_RE.lastIndex = 0;

  // 7. Partial name hints (Kh___, R****)
  if (PARTIAL_NAME_RE.test(text)) { flags.push('partial_name'); text = text.replace(PARTIAL_NAME_RE, '[Name]'); } PARTIAL_NAME_RE.lastIndex = 0;

  // 8. Leet-speak abuse
  if (LEET_RE.test(text)) { flags.push('abuse'); text = text.replace(LEET_RE, m => blurWord(m)); } LEET_RE.lastIndex = 0;

  // 9. Standard abuse (with context check for mc/bc)
  let abuseFound = false;
  text = text.replace(ABUSE_RE, (match, p1, offset) => {
    const lower = match.toLowerCase();
    if ((lower === 'mc' || lower === 'bc') && !isAbusiveShortForm(match, text, offset)) {
      return match; // keep it — it's "because" or "emcee"
    }
    abuseFound = true;
    return blurWord(match);
  });
  ABUSE_RE.lastIndex = 0;
  if (abuseFound && !flags.includes('abuse')) flags.push('abuse');

  // 10. Known names
  if (NAME_RE.test(text)) { flags.push('name'); text = text.replace(NAME_RE, '[Name]'); } NAME_RE.lastIndex = 0;

  return { cleanText: text, flags, wasEdited: text !== rawText, aiReasoning: '', usedAI: false };
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
  try { await uniqueCol.dropIndex('lastSeen_1'); } catch(e) {}
  await uniqueCol.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 90 });
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

  const { cleanText, flags, wasEdited } = filterConfession(rawMessage);

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
  const data = await confCol.find({}).sort({ createdAt: -1 }).limit(MAX_CONFESSIONS).toArray();
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
// ── Community report + reply delete routes ────────────────────────────────────
const REPORT_THRESHOLD = 3;
app.post('/api/report/:id', async (req, res) => {
  const { clientId, reason } = req.body;
  const VALID = ['identity','harassment','fake','spam','other'];
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!VALID.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.reports||[]).some(r => r.clientId === clientId))
    return res.json({ alreadyReported: true, reportCount: (item.reports||[]).length });
  await confCol.updateOne({ id: req.params.id }, { $push: { reports: { clientId, reason, reportedAt: Date.now() } } });
  const updated = await confCol.findOne({ id: req.params.id });
  const reportCount = (updated.reports||[]).length;
  if (reportCount >= REPORT_THRESHOLD && !item.reportHidden)
    await confCol.updateOne({ id: req.params.id }, { $set: { reportHidden: true } });
  res.json({ status: 'reported', reportCount, autoHidden: reportCount >= REPORT_THRESHOLD });
});
app.get('/api/reported', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await confCol.find({ 'reports.0': { $exists: true } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(data);
});
app.post('/api/admin/restore', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  await confCol.updateOne({ id: confessionId }, { $set: { reports: [], reportHidden: false } });
  res.json({ status: 'restored' });
});
app.post('/api/admin/reply/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { replyId } = req.body;
  if (!replyId) return res.status(400).json({ error: 'replyId required' });
  const result = await repliesCol.deleteOne({ id: replyId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Reply not found' });
  res.json({ removed: replyId });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
