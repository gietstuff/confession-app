const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gietAdmin123';
const abusiveWords = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'piss', 'slut'];

let confessions = [];
let pendingConfessions = [];
let analytics = { visits: 0, uniqueVisitors: 0, activeVisitors: 0 };
let uniqueByClient = new Set();
let activeVisitors = new Map(); // clientId -> lastHeartbeat timestamp

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
    if (lastSeen < cutoff) {
      activeVisitors.delete(id);
    }
  }
  analytics.activeVisitors = activeVisitors.size;
}

setInterval(cleanupOld, 10 * 60 * 1000);
setInterval(cleanupActiveVisitors, 5000);

app.post('/api/confessions', (req, res) => {
  const { message, clientId } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  if (message.length > 400 * 5) {
    return res.status(400).json({ error: 'Message too long. Keep within 400 words.' });
  }

  let filtered = sanitizeText(message);
  if (!filtered || filtered.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid message after filtering.' });
  }

  const wordCount = filtered.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 400) {
    return res.status(400).json({ error: 'Message exceeds 400 words.' });
  }

  const confession = {
    id: uuidv4(),
    message: filtered,
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
  if (existing === 'dislike') {
    item.dislikes = Math.max(0, item.dislikes - 1);
  }

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
  if (existing === 'like') {
    item.likes = Math.max(0, item.likes - 1);
  }

  item.votes[clientId] = 'dislike';
  item.dislikes += 1;
  saveData();

  res.json({ likes: item.likes, dislikes: item.dislikes });
});

app.get('/api/pending', (req, res) => {
  res.json(pendingConfessions);
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ token: 'admintoken', message: 'OK' });
  }
  return res.status(403).json({ error: 'Invalid password' });
});

app.post('/api/admin/moderate', (req, res) => {
  const { token, confessionId, action } = req.body;
  if (token !== 'admintoken') {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const idx = pendingConfessions.findIndex(item => item.id === confessionId);
  if (idx === -1 && action !== 'delete') return res.status(404).json({ error: 'Confession not found in pending list' });

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
  const { token, confessionId } = req.body;
  if (token !== 'admintoken') {
    return res.status(403).json({ error: 'Invalid token' });
  }

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

app.post('/api/visit', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  if (!uniqueByClient.has(clientId)) {
    uniqueByClient.add(clientId);
    analytics.uniqueVisitors = uniqueByClient.size;
    analytics.visits += 1; // Count only first visit per clientId
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

app.get('/admin', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
