const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ✅ FIX 1: CORS now accepts the Vercel frontend URL (set via env var)
// Also allows localhost for local dev.
const allowedOrigins = [
  process.env.CLIENT_URL,          // e.g. https://giet-confession.vercel.app
  'http://localhost:3000',
  'http://localhost:5000',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gietAdmin123';
const SESSION_TIMEOUT = 3600000; // 1 hour
const LOGIN_RATE_LIMIT = new Map();
const abusiveWords = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'piss', 'slut'];

let confessions = [];
let pendingConfessions = [];
let analytics = { visits: 0, uniqueVisitors: 0, activeVisitors: 0 };
let uniqueByClient = new Set();
let activeVisitors = new Map();
let adminSessions = new Map();

function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const session = adminSessions.get(token);
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (session.expiresAt < now) adminSessions.delete(token);
  }
}

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!LOGIN_RATE_LIMIT.has(ip)) {
    LOGIN_RATE_LIMIT.set(ip, { count: 1, resetTime: now + 60000 });
    return true;
  }
  const record = LOGIN_RATE_LIMIT.get(ip);
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + 60000;
    return true;
  }
  record.count += 1;
  return record.count <= 5;
}

setInterval(cleanupExpiredSessions, 60000);

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      confessions = parsed.confessions || [];
      pendingConfessions = parsed.pendingConfessions || [];
      analytics = parsed.analytics || analytics;
      uniqueByClient = new Set(parsed.uniqueByClient || []);
    }
  } catch (err) {
    console.error('Failed to load data file:', err);
  }
}

function saveData() {
  try {
    const payload = {
      confessions,
      pendingConfessions,
      analytics,
      uniqueByClient: Array.from(uniqueByClient)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save data file:', err);
  }
}

loadData();

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  let filtered = text.trim().slice(0, 4000);
  filtered = filtered.replace(/\d+/g, '');
  abusiveWords.forEach(word => {
    const re = new RegExp(word, 'gi');
    filtered = filtered.replace(re, '***');
  });
  return filtered;
}

function hasAbusive(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return abusiveWords.some(word => lower.includes(word));
}

function cleanupOld() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  confessions = confessions.filter(item => item.createdAt >= cutoff && item.approved);
  pendingConfessions = pendingConfessions.filter(item => item.createdAt >= cutoff && !item.rejected);
  saveData();
}

function cleanupActiveVisitors() {
  const cutoff = Date.now() - 30 * 1000;
  for (const [id, lastSeen] of activeVisitors.entries()) {
    if (lastSeen < cutoff) activeVisitors.delete(id);
  }
  analytics.activeVisitors = activeVisitors.size;
}

setInterval(cleanupOld, 10 * 60 * 1000);
setInterval(cleanupActiveVisitors, 5000);

// --- Public Routes ---

app.post('/api/confessions', (req, res) => {
  const { message, clientId, category } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0)
    return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.length > 400 * 5)
    return res.status(400).json({ error: 'Message too long. Keep within 400 words.' });

  let filtered = sanitizeText(message);
  if (!filtered || filtered.trim().length === 0)
    return res.status(400).json({ error: 'Invalid message after filtering.' });

  const wordCount = filtered.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const confession = {
    id: uuidv4(),
    message: filtered,
    category: category || '💭 Random',
    createdAt: Date.now(),
    likes: 0,
    dislikes: 0,
    votes: {},
    approved: false,
    rejected: false,
    hasAbusive: hasAbusive(message),
  };

  pendingConfessions.unshift(confession);
  saveData();

  if (clientId) {
    uniqueByClient.add(clientId);
    analytics.uniqueVisitors = uniqueByClient.size;
    saveData();
  }

  return res.json({ status: 'pending', notification: 'NEW CONFESSION' });
});

app.get('/api/confessions', (req, res) => {
  const alive = confessions.filter(c => c.createdAt >= Date.now() - 24 * 3600 * 1000);
  res.json(alive);
});

app.post('/api/like/:id', (req, res) => {
  const id = req.params.id;
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = confessions.find(c => c.id === id);
  if (!item) return res.status(404).json({ error: 'Confession not found' });

  const existing = item.votes[clientId];
  if (existing === 'like') return res.json({ likes: item.likes, dislikes: item.dislikes, message: 'Already liked' });
  if (existing === 'dislike') item.dislikes = Math.max(0, item.dislikes - 1);

  item.votes[clientId] = 'like';
  item.likes += 1;
  saveData();
  res.json({ likes: item.likes, dislikes: item.dislikes });
});

app.post('/api/dislike/:id', (req, res) => {
  const id = req.params.id;
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = confessions.find(c => c.id === id);
  if (!item) return res.status(404).json({ error: 'Confession not found' });

  const existing = item.votes[clientId];
  if (existing === 'dislike') return res.json({ likes: item.likes, dislikes: item.dislikes, message: 'Already disliked' });
  if (existing === 'like') item.likes = Math.max(0, item.likes - 1);

  item.votes[clientId] = 'dislike';
  item.dislikes += 1;
  saveData();
  res.json({ likes: item.likes, dislikes: item.dislikes });
});

app.get('/api/pending', (req, res) => {
  res.json(pendingConfessions);
});

app.post('/api/visit', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  if (!uniqueByClient.has(clientId)) {
    uniqueByClient.add(clientId);
    analytics.uniqueVisitors = uniqueByClient.size;
    analytics.visits += 1;
  }

  activeVisitors.set(clientId, Date.now());
  analytics.activeVisitors = activeVisitors.size;
  saveData();

  res.json({ status: 'ok', visits: analytics.visits, uniqueVisitors: analytics.uniqueVisitors, activeVisitors: analytics.activeVisitors });
});

app.get('/api/active-visitors', (req, res) => {
  res.json({ activeVisitors: analytics.activeVisitors });
});

app.get('/api/analytics', (req, res) => {
  res.json({ visits: analytics.visits, uniqueVisitors: analytics.uniqueVisitors, activeVisitors: analytics.activeVisitors });
});

// --- Admin Routes ---

app.post('/api/admin/login', (req, res) => {
  const clientIp = getClientIp(req);

  if (!checkLoginRateLimit(clientIp))
    return res.status(429).json({ error: 'Too many login attempts. Try again in 1 minute.' });

  const { password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Invalid password' });

  const token = uuidv4();
  const expiresAt = Date.now() + SESSION_TIMEOUT;
  adminSessions.set(token, { expiresAt, createdAt: Date.now() });

  // ✅ FIX 2: Set cookie with sameSite:'none' so cross-origin requests (Vercel → Render) work.
  // Also return token in response body so admin.html can use it as a header fallback.
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,                  // required when sameSite is 'none'
    sameSite: 'none',              // allows cross-site cookie (Vercel ↔ Render)
    maxAge: SESSION_TIMEOUT
  });

  // ✅ FIX 3: Return the token in the JSON response so admin.html can send it as a header
  return res.json({ message: 'OK', token, expiresIn: SESSION_TIMEOUT / 1000 });
});

app.post('/api/admin/moderate', (req, res) => {
  // ✅ FIX 4: Accept token from cookie OR from Authorization header (sent by admin.html)
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  const { confessionId, action } = req.body;

  if (!isValidSession(token))
    return res.status(403).json({ error: 'Unauthorized. Please login again.' });

  const idx = pendingConfessions.findIndex(item => item.id === confessionId);
  if (idx === -1 && action !== 'delete')
    return res.status(404).json({ error: 'Confession not found in pending list' });

  if (action === 'approve') {
    const confession = pendingConfessions[idx];
    confession.approved = true;
    confessions.unshift(confession);
    pendingConfessions.splice(idx, 1);
    saveData();
    return res.json({ updated: confession });
  } else if (action === 'reject') {
    const confession = pendingConfessions[idx];
    confession.rejected = true;
    pendingConfessions.splice(idx, 1);
    saveData();
    return res.json({ updated: confession });
  }

  res.status(400).json({ error: 'Invalid action' });
});

app.post('/api/admin/delete', (req, res) => {
  // ✅ FIX 4: Accept token from cookie OR from Authorization header
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  const { confessionId } = req.body;

  if (!isValidSession(token))
    return res.status(403).json({ error: 'Unauthorized. Please login again.' });

  let removeIndex = confessions.findIndex(c => c.id === confessionId);
  if (removeIndex >= 0) {
    confessions.splice(removeIndex, 1);
    saveData();
    return res.json({ removed: confessionId });
  }

  removeIndex = pendingConfessions.findIndex(item => item.id === confessionId);
  if (removeIndex >= 0) {
    pendingConfessions.splice(removeIndex, 1);
    saveData();
    return res.json({ removed: confessionId });
  }

  res.status(404).json({ error: 'Confession not found' });
});

// Serve frontend (only used when frontend is served from same origin as backend)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
