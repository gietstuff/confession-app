// ══════════════════════════════════════════════════════════════════════════════
// GIET Confessions — server.js (Security-hardened v2.1)
// ══════════════════════════════════════════════════════════════════════════════
//
// NEW PACKAGES REQUIRED — run this before deploying:
//   npm install helmet express-rate-limit express-mongo-sanitize
//
// NEW RENDER ENV VARS REQUIRED:
//   NODE_ENV=production
//   ADMIN_PASSWORD=<strong password>
//   VAPID_PUBLIC_KEY=<new key>
//   VAPID_PRIVATE_KEY=<new key — never commit>
//   VAPID_EMAIL=admin@giet.edu
//   MONGO_URI=<atlas uri>
//   CLIENT_URL=https://page-confession.vercel.app

const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

// [SECURITY-1] helmet: sets 14 HTTP security response headers in one call
// X-Frame-Options: DENY                → stops clickjacking (your page framed in another site)
// X-Content-Type-Options: nosniff      → browser won't sniff MIME type (blocks script injection)
// Strict-Transport-Security            → forces HTTPS forever for this domain
// Content-Security-Policy              → restricts which scripts/styles/iframes can load
// Referrer-Policy: no-referrer         → hides your URL in cross-origin requests
// Permissions-Policy                   → disables browser features (camera, mic, location)
const helmet = require('helmet');

// [SECURITY-2] express-rate-limit: counts requests per IP per time window.
// When IP exceeds the limit → HTTP 429 "Too Many Requests". Prevents brute force and spam.
const rateLimit = require('express-rate-limit');

// [SECURITY-3] express-mongo-sanitize: removes $ and . from all incoming request fields.
// Attack blocked: { "clientId": { "$gt": "" } } → matches ALL documents → data leak.
// After sanitize: { "clientId": {} } → safe, matches nothing useful.
const mongoSanitize = require('express-mongo-sanitize');

const app  = express();
const PORT = process.env.PORT || 5000;

// [SECURITY-13] Fail on startup if ADMIN_PASSWORD not set in production.
// Prevents deploying with the default hardcoded password.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD env var is required in production.');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gietAdmin123';

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
  console.warn('web-push not installed');
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT FILTER ENGINE
// ══════════════════════════════════════════════════════════════════════════════
const PHONE_RE  = /(\+?91[\s\-]?)?[6-9]\d{9}/g;
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const HANDLE_RE = /@[a-zA-Z0-9_.]{2,}/g;
const LINK_RE   = /https?:\/\/[^\s]+/gi;
const ABUSE_EN  = ['fuck','fucking','fucked','fucker','fucks','bitch','bitches','shit','shitty','asshole','bastard','cunt','dick','cock','pussy','whore','slut','nigger','nigga','faggot','retard','rape','rapist','molest','kys','motherfucker','mf','piss','bollocks'];
const ABUSE_HI  = ['chutiya','chutiye','bhenchod','madarchod','bhosdike','bhosdika','bsdk','lodu','lauda','lavde','gaand','mc','bc','randi','harami','kamina','saala','saali','gadha','gandu','jhant','lund','chut','bhosdi','maderchod','bhencho','kutte','kutiya','chodu','chod','chodna','choda'];
const ABUSE_RE  = new RegExp('(?<![a-zA-Z])(' + [...ABUSE_EN,...ABUSE_HI].sort((a,b)=>b.length-a.length).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')(?![a-zA-Z])','gi');
const COMMON_NAMES = ['aarav','aditya','akash','akshay','amit','amitesh','ananya','anjali','ankit','ankita','arjun','aryan','ashish','bhavya','deepak','deepika','devansh','dhruv','divya','gaurav','harsh','harshit','ishaan','janhvi','jay','karan','kavya','komal','krishna','kunal','manish','mehul','mohit','naman','neha','nikhil','nikita','nishant','palak','parth','pooja','prachi','prakash','prashant','prateek','pratik','priya','priyanshi','rahul','raj','rajat','rajesh','ravi','ritesh','rohit','ruchika','sachin','sahil','sakshi','sandeep','sanjay','shivam','shreya','siddharth','simran','sneha','soham','sourav','sumit','suraj','tanvi','tushar','udit','vaibhav','vandana','vibhav','vikash','vikas','vishal','yash','yashasvi','zara'];
const NAME_RE = new RegExp('\\b(' + COMMON_NAMES.join('|') + ')\\b', 'gi');
function blurWord(w) { return w.length<=2?'*'.repeat(w.length):w[0]+'*'.repeat(w.length-2)+w[w.length-1]; }
function filterConfession(rawText) {
  const flags=[]; let text=rawText;
  if(LINK_RE.test(text)){flags.push('link');text=text.replace(LINK_RE,'[link removed]');} LINK_RE.lastIndex=0;
  if(PHONE_RE.test(text)){flags.push('phone');text=text.replace(PHONE_RE,'[number hidden]');} PHONE_RE.lastIndex=0;
  if(EMAIL_RE.test(text)){flags.push('email');text=text.replace(EMAIL_RE,'[email hidden]');}
  if(HANDLE_RE.test(text)){flags.push('handle');text=text.replace(HANDLE_RE,'[handle hidden]');}
  if(ABUSE_RE.test(text)){flags.push('abuse');text=text.replace(ABUSE_RE,m=>blurWord(m));} ABUSE_RE.lastIndex=0;
  if(NAME_RE.test(text)){flags.push('name');text=text.replace(NAME_RE,'[Name]');} NAME_RE.lastIndex=0;
  return { cleanText: text, flags, wasEdited: text !== rawText };
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol, repliesCol, settingsCol, pushSubCol;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('giet_confession');
  confCol=db.collection('confessions'); pendingCol=db.collection('pending');
  analyticsCol=db.collection('analytics'); uniqueCol=db.collection('unique_visitors');
  repliesCol=db.collection('replies'); settingsCol=db.collection('settings');
  pushSubCol=db.collection('push_subscriptions');
  console.log('MongoDB connected');
  await analyticsCol.updateOne({_id:'main'},{$setOnInsert:{visits:0,uniqueVisitors:0}},{upsert:true});
  await settingsCol.updateOne({_id:'main'},{$setOnInsert:{autoApprove:false}},{upsert:true});
  await pushSubCol.createIndex({endpoint:1},{unique:true});
  // Index for fast "active visitors in last 60s" count query
  await uniqueCol.createIndex({ lastSeen: 1 });
}

// ══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE STACK — security middleware FIRST before any routes
// ══════════════════════════════════════════════════════════════════════════════

// [SECURITY-1] Helmet before everything
app.use(helmet());

// Trust Render's reverse proxy so req.ip = real visitor IP, not proxy IP.
// Without this, all rate limiters see the same internal IP → useless.
app.set('trust proxy', 1);

// [SECURITY-4] Body size limit: 10kb max.
// Default is 100kb. A bot could POST megabytes in a loop → RAM exhaustion → server crash.
// 10kb = ~10,000 chars, plenty for any real confession.
app.use(express.json({ limit: '10kb' }));

// [SECURITY-3] NoSQL injection prevention — strip $operator keys from all input
app.use(mongoSanitize());

app.use(cookieParser());

// [SECURITY-14] CORS locked to your frontend domain only
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
  credentials: true,
}));

// ── Rate limiters ─────────────────────────────────────────────────────────────
// [SECURITY-2] Each rateLimit() creates an IP-keyed counter with a sliding window.
// windowMs = duration of the window. max = requests allowed per window per IP.
// After max is hit → HTTP 429. Counter resets after windowMs ms.

const apiLimiter = rateLimit({
  windowMs: 15*60*1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests.' },
});
// Confession submit: 10 per hour per IP (raised from 5 — allows legitimate testing)
const confessionLimiter = rateLimit({
  windowMs: 60*60*1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many submissions. Try again in an hour.' },
});
// Admin login: 5 attempts per 15 min per IP — brute force protection
const adminLoginLimiter = rateLimit({
  windowMs: 15*60*1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Wait 15 minutes.' },
  skipSuccessfulRequests: true,
});
// Reactions + flags: 30 per 15 min per IP
// [SECURITY-9] Without IP-level limiting, a script could:
// 1) generate 10,000 random clientIds (since they're just localStorage strings)
// 2) spam reactions on every confession → fake "Confession of the Day" rankings
const interactionLimiter = rateLimit({
  windowMs: 15*60*1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many interactions.' },
});
// Visit ping: 1 per 20 seconds per IP — enough for the 15s frontend interval
// Applied ONLY to /api/visit so it never consumes the global 100/15min budget
const visitLimiter = rateLimit({
  windowMs: 20*1000, max: 1,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many pings.' },
  skip: () => false,
});

// Global limiter applied to ALL /api/ routes EXCEPT /api/visit
// (visit has its own limiter and needs to stay reliable for stats)
app.use('/api/', (req, res, next) => {
  if (req.path === '/visit') return next(); // skip global for visit
  return apiLimiter(req, res, next);
});
app.use('/api/visit', visitLimiter);
app.use('/api/confessions', confessionLimiter);
app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/react', interactionLimiter);
app.use('/api/like', interactionLimiter);
app.use('/api/dislike', interactionLimiter);
app.use('/api/flag', interactionLimiter);
app.use('/api/replies', interactionLimiter);

// ── Auth helpers ──────────────────────────────────────────────────────────────
const SESSION_TIMEOUT = 3600000;
const adminSessions   = new Map();
// Note: activeVisitors is now DB-backed (unique_visitors.lastSeen), not in-memory
function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const s = adminSessions.get(token);
  if (s.expiresAt < Date.now()) { adminSessions.delete(token); return false; }
  return true;
}

// [SECURITY-12] Prevent service worker from caching admin responses.
// If admin is logged in on a shared device, SW could cache the admin panel response.
// Cache-Control: no-store tells both browser and SW: never store this response.
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
}
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  noCache(req, res, next);
}

setInterval(() => { const now=Date.now(); for(const[t,s]of adminSessions.entries())if(s.expiresAt<now)adminSessions.delete(t); }, 60000);
// activeVisitors is now tracked in MongoDB (unique_visitors collection) via lastSeen field.
// No more in-memory Map — survives cold starts.

// ── Push helper ───────────────────────────────────────────────────────────────
async function pushAll(payload, type='user') {
  if (!webpush) return;
  const subs = await pushSubCol.find(type==='all'?{}:{type}).toArray();
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try { await webpush.sendNotification(sub.subscription, JSON.stringify(payload)); }
    catch(e) { if(e.statusCode===410||e.statusCode===404) dead.push(sub.endpoint); }
  }));
  if (dead.length) await pushSubCol.deleteMany({endpoint:{$in:dead}});
}

// ── Health check endpoint ─────────────────────────────────────────────────────
// Point UptimeRobot (free) at this URL every 5 min to prevent Render cold starts.
// Cold starts reset in-memory rate limit counters → brief unprotected window.
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// [SECURITY-10] Validate subscription object shape before inserting.
// Without validation: bots POST fake endpoints → fill push_subscriptions → storage exhaustion.
function isValidSubscription(sub) {
  return sub &&
    typeof sub.endpoint === 'string' &&
    sub.endpoint.startsWith('https://') &&
    sub.endpoint.length < 500 &&
    typeof sub.keys?.auth === 'string' &&
    typeof sub.keys?.p256dh === 'string';
}

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!isValidSubscription(subscription))
    return res.status(400).json({ error: 'Invalid subscription object.' });
  const count = await pushSubCol.countDocuments({});
  if (count > 10000) return res.status(429).json({ error: 'Subscription limit reached.' });
  await pushSubCol.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { subscription, type:'user', updatedAt:Date.now() } },
    { upsert:true }
  );
  res.json({ status:'ok' });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await pushSubCol.deleteOne({ endpoint });
  res.json({ status:'ok' });
});

// Submit confession
app.post('/api/confessions', async (req, res) => {
  const { message, clientId, category, year, branch } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.trim().length > 5000) return res.status(400).json({ error: 'Message too long.' });
  if (message.trim().split(/\s+/).filter(Boolean).length > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const { cleanText, flags, wasEdited } = filterConfession(message.trim());
  const settings = await settingsCol.findOne({ _id:'main' });
  const autoApprove = settings?.autoApprove || false;

  // Validate enum fields — never trust client to send valid values
  const validYears    = ['1st','2nd','3rd','4th'];
  const validBranches = ['CSE','AIML','ECE','AGRI','Others'];
  const validCategory = ['💘 Crush','✍️ Shayari','💭 Random'];

  const confession = {
    id: uuidv4(), // [SECURITY-11] UUID v4 — not sequential, not guessable
    message: cleanText,
    originalMessage: wasEdited ? message.trim() : undefined,
    category: validCategory.includes(category) ? category : '💭 Random',
    year:   validYears.includes(year)     ? year   : undefined,
    branch: validBranches.includes(branch)? branch : undefined,
    createdAt: Date.now(),
    likes: 0, dislikes: 0, votes: {},
    reactions: {'😮':0,'😂':0,'🥺':0,'🔥':0,'❤️':0},
    reactionVotes: {},
    approved: autoApprove,
    flags: 0, flaggedBy: [],
    filterFlags: flags,
    wasEdited,
  };

  if (autoApprove) {
    await confCol.insertOne(confession);
    pushAll({title:'💌 New Confession on GIET!',body:cleanText.slice(0,90)+(cleanText.length>90?'…':''),url:'https://page-confession.vercel.app'},'user').catch(()=>{});
  } else {
    await pendingCol.insertOne(confession);
    pushAll({title:'🔔 New Confession Pending',body:'A new confession needs your approval.',url:'https://page-confession.vercel.app/admin.html'},'admin').catch(()=>{});
  }

  if (clientId && typeof clientId==='string' && clientId.length<100) {
    const exists = await uniqueCol.findOne({ _id:clientId });
    if (!exists) {
      await uniqueCol.insertOne({ _id:clientId });
      await analyticsCol.updateOne({_id:'main'},{$inc:{uniqueVisitors:1}});
    }
  }
  return res.json({ status:autoApprove?'approved':'pending', edited:wasEdited, editedFields:flags });
});

app.get('/api/confessions', async (req, res) => {
  const cutoff = Date.now() - 24*3600*1000;
  const data = await confCol.find({createdAt:{$gte:cutoff}}).sort({createdAt:-1}).toArray();
  res.json(data);
});

// Like / Dislike / React
app.post('/api/like/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error:'clientId required' });
  if (typeof req.params.id !== 'string' || req.params.id.length > 50)
    return res.status(400).json({ error:'Invalid id' });
  const item = await confCol.findOne({ id:req.params.id });
  if (!item) return res.status(404).json({ error:'Not found' });
  if (item.votes?.[clientId]==='like') return res.json({ likes:item.likes, dislikes:item.dislikes });
  const upd = { $inc:{likes:1}, $set:{[`votes.${clientId}`]:'like'} };
  if (item.votes?.[clientId]==='dislike') upd.$inc.dislikes=-1;
  await confCol.updateOne({id:req.params.id}, upd);
  const u = await confCol.findOne({id:req.params.id});
  res.json({ likes:u.likes, dislikes:u.dislikes });
});
app.post('/api/dislike/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error:'clientId required' });
  if (typeof req.params.id !== 'string' || req.params.id.length > 50)
    return res.status(400).json({ error:'Invalid id' });
  const item = await confCol.findOne({ id:req.params.id });
  if (!item) return res.status(404).json({ error:'Not found' });
  if (item.votes?.[clientId]==='dislike') return res.json({ likes:item.likes, dislikes:item.dislikes });
  const upd = { $inc:{dislikes:1}, $set:{[`votes.${clientId}`]:'dislike'} };
  if (item.votes?.[clientId]==='like') upd.$inc.likes=-1;
  await confCol.updateOne({id:req.params.id}, upd);
  const u = await confCol.findOne({id:req.params.id});
  res.json({ likes:u.likes, dislikes:u.dislikes });
});
app.post('/api/react/:id', async (req, res) => {
  const { clientId, emoji } = req.body;
  if (!clientId) return res.status(400).json({ error:'clientId required' });
  if (!['😮','😂','🥺','🔥','❤️'].includes(emoji)) return res.status(400).json({ error:'Invalid emoji' });
  if (typeof req.params.id !== 'string' || req.params.id.length > 50)
    return res.status(400).json({ error:'Invalid id' });
  const item = await confCol.findOne({ id:req.params.id });
  if (!item) return res.status(404).json({ error:'Not found' });
  const prev = item.reactionVotes?.[clientId];
  const upd = { $set:{[`reactionVotes.${clientId}`]:emoji}, $inc:{} };
  if (prev && prev!==emoji) upd.$inc[`reactions.${prev}`]=-1;
  if (!prev || prev!==emoji) upd.$inc[`reactions.${emoji}`]=1;
  await confCol.updateOne({id:req.params.id}, upd);
  const u = await confCol.findOne({id:req.params.id});
  res.json({ reactions:u.reactions, myReaction:emoji });
});

// Flag — interactionLimiter already applied at route level
app.post('/api/flag/:id', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error:'clientId required' });
  const item = await confCol.findOne({ id:req.params.id });
  if (!item) return res.status(404).json({ error:'Not found' });
  if ((item.flaggedBy||[]).includes(clientId)) return res.json({ flags:item.flags, alreadyFlagged:true });
  await confCol.updateOne({id:req.params.id},{$inc:{flags:1},$push:{flaggedBy:clientId}});
  res.json({ flags:(item.flags||0)+1 });
});

// Replies
app.get('/api/replies/:confessionId', async (req, res) => {
  const replies = await repliesCol.find({confessionId:req.params.confessionId}).sort({createdAt:1}).toArray();
  res.json(replies);
});
app.post('/api/replies/:confessionId', async (req, res) => {
  const { message, clientId } = req.body;
  if (!message||!message.trim()) return res.status(400).json({ error:'Reply cannot be empty.' });
  if (message.trim().length>500) return res.status(400).json({ error:'Reply too long.' });
  const conf = await confCol.findOne({ id:req.params.confessionId });
  if (!conf) return res.status(404).json({ error:'Confession not found' });
  const reply = { id:uuidv4(), confessionId:req.params.confessionId, message:message.trim(), createdAt:Date.now() };
  await repliesCol.insertOne(reply);
  res.json({ status:'ok', reply });
});
app.post('/api/replies/counts', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)||ids.length>200) return res.status(400).json({ error:'ids must be array (max 200)' });
  const counts = await repliesCol.aggregate([
    {$match:{confessionId:{$in:ids}}},
    {$group:{_id:'$confessionId',count:{$sum:1}}}
  ]).toArray();
  const map = {};
  counts.forEach(c => { map[c._id]=c.count; });
  res.json(map);
});

// Visit — tracks unique visitors + active users
// activeVisitors = count of unique_visitors with lastSeen within last 60 seconds
// Stored in MongoDB so it survives Render cold starts
app.post('/api/visit', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId||typeof clientId!=='string'||clientId.length>100)
    return res.status(400).json({ error:'clientId required' });

  const now = Date.now();
  const existing = await uniqueCol.findOne({ _id:clientId });
  if (!existing) {
    // Brand new visitor
    await uniqueCol.insertOne({ _id:clientId, firstSeen:now, lastSeen:now });
    await analyticsCol.updateOne({_id:'main'},{$inc:{visits:1,uniqueVisitors:1}});
  } else {
    // Returning visitor — just update lastSeen
    await uniqueCol.updateOne({ _id:clientId }, { $set:{ lastSeen:now } });
  }

  // Count active: any visitor whose lastSeen is within last 60 seconds
  const activeCutoff = now - 60000;
  const activeCount = await uniqueCol.countDocuments({ lastSeen:{ $gte: activeCutoff } });

  const stats = await analyticsCol.findOne({_id:'main'});
  res.json({
    status:'ok',
    visits: stats?.visits || 0,
    uniqueVisitors: stats?.uniqueVisitors || 0,
    activeVisitors: activeCount,
  });
});

// [SECURITY-7] Analytics require admin auth.
app.get('/api/analytics', requireAdmin, async (req, res) => {
  const stats = await analyticsCol.findOne({_id:'main'});
  const activeCutoff = Date.now() - 60000;
  const activeCount = await uniqueCol.countDocuments({ lastSeen:{ $gte: activeCutoff } });
  res.json({ visits:stats?.visits||0, uniqueVisitors:stats?.uniqueVisitors||0, activeVisitors:activeCount });
});
app.get('/api/settings', requireAdmin, async (req, res) => {
  const s = await settingsCol.findOne({_id:'main'});
  res.json({ autoApprove:s?.autoApprove||false });
});

// [SECURITY-8] Pending confessions require admin auth.
// Previously GET /api/pending was public — anyone could read unmoderated content.
app.get('/api/pending', requireAdmin, async (req, res) => {
  const data = await pendingCol.find({}).sort({flags:-1,createdAt:-1}).toArray();
  res.json(data);
});
app.get('/api/pending-count', requireAdmin, async (req, res) => {
  const count = await pendingCol.countDocuments({});
  res.json({ count });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — all protected via requireAdmin
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/push/subscribe', requireAdmin, async (req, res) => {
  const { subscription } = req.body;
  if (!isValidSubscription(subscription))
    return res.status(400).json({ error:'Invalid subscription' });
  await pushSubCol.updateOne(
    {endpoint:subscription.endpoint},
    {$set:{subscription,type:'admin',updatedAt:Date.now()}},
    {upsert:true}
  );
  res.json({ status:'ok' });
});

// Admin login — adminLoginLimiter applied above (5 attempts / 15 min per IP)
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error:'Invalid password' });
  const token = uuidv4();
  adminSessions.set(token, { expiresAt:Date.now()+SESSION_TIMEOUT });
  res.cookie('admin_token', token, {
    httpOnly: true,   // JS cannot read this cookie — prevents XSS token theft
    secure:   true,   // Only sent over HTTPS
    sameSite: 'none', // Required for cross-origin (Vercel → Render)
    maxAge:   SESSION_TIMEOUT,
  });
  return res.json({ message:'OK', token, expiresIn:SESSION_TIMEOUT/1000 });
});

app.post('/api/admin/moderate', requireAdmin, async (req, res) => {
  const { confessionId, action } = req.body;
  const item = await pendingCol.findOne({ id:confessionId });
  if (!item) return res.status(404).json({ error:'Not found in pending' });
  if (action==='approve') {
    const { _id, ...rest } = item;
    rest.approved=true;
    await confCol.insertOne(rest);
    await pendingCol.deleteOne({ id:confessionId });
    pushAll({title:'💌 New Confession on GIET!',body:rest.message.slice(0,90)+(rest.message.length>90?'…':''),url:'https://page-confession.vercel.app'},'user').catch(()=>{});
    return res.json({ updated:rest });
  }
  if (action==='reject') {
    await pendingCol.deleteOne({ id:confessionId });
    return res.json({ updated:item });
  }
  res.status(400).json({ error:'Invalid action' });
});

app.post('/api/admin/approve-all', requireAdmin, async (req, res) => {
  const pending = await pendingCol.find({}).toArray();
  if (!pending.length) return res.json({ approved:0 });
  const toInsert = pending.map(({_id,...rest}) => ({...rest,approved:true}));
  await confCol.insertMany(toInsert);
  await pendingCol.deleteMany({});
  pushAll({title:`💌 ${pending.length} New Confession${pending.length>1?'s':''} on GIET!`,body:'Fresh confessions just dropped!',url:'https://page-confession.vercel.app'},'user').catch(()=>{});
  res.json({ approved:pending.length });
});

app.post('/api/admin/auto-approve', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  await settingsCol.updateOne({_id:'main'},{$set:{autoApprove:!!enabled}});
  res.json({ autoApprove:!!enabled });
});

app.post('/api/admin/delete', requireAdmin, async (req, res) => {
  const { confessionId } = req.body;
  const r1 = await confCol.deleteOne({ id:confessionId });
  if (r1.deletedCount) { await repliesCol.deleteMany({confessionId}); return res.json({ removed:confessionId }); }
  const r2 = await pendingCol.deleteOne({ id:confessionId });
  if (r2.deletedCount) return res.json({ removed:confessionId });
  res.status(404).json({ error:'Not found' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER — must be defined LAST, after all routes
// ══════════════════════════════════════════════════════════════════════════════
// [SECURITY-5, SECURITY-6]
// Express calls this 4-argument middleware whenever next(err) is called
// OR an unhandled exception occurs inside a route.
// Without this: Express's built-in error handler sends the full stack trace
// as HTML, leaking: file paths, DB URIs, package names, internal logic.
// With NODE_ENV=production (set on Render): clients see only "Server error".
// In dev: include the actual message so you can debug locally.
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message || err);
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(err.status || 500).json({
    error: isDev ? (err.message || 'Server error') : 'Server error',
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT} [${process.env.NODE_ENV||'development'}]`));
}).catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
