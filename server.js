const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;

const HAS_REDIS = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
let redis = null;
if (HAS_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
} else {
  console.log('UPSTASH_REDIS_REST_URL/TOKEN yok - odalar ve profiller kalici olmayacak.');
}

const COLORS = ['#ff4d94', '#ffce3d', '#4dd6ff', '#7dff6b', '#c76bff', '#ff8a4d', '#4dffb8', '#ff4d4d'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

async function getUser(id) {
  if (!redis) return null;
  return (await redis.get('user:' + id)) || null;
}
async function saveUser(user) {
  if (!redis) return;
  await redis.set('user:' + user.id, user);
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = (await getUser(id)) || { id };
    done(null, user);
  } catch (e) {
    done(e);
  }
});

const BASE_URL = process.env.BASE_URL || 'https://dut-arena.onrender.com';

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const id = 'google:' + profile.id;
      let user = await getUser(id);
      if (!user) {
        user = { id, provider: 'google', name: profile.displayName || 'Oyuncu', color: randomColor() };
        await saveUser(user);
      }
      done(null, user);
    } catch (e) {
      done(e);
    }
  }));
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/github/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const id = 'github:' + profile.id;
      let user = await getUser(id);
      if (!user) {
        user = { id, provider: 'github', name: profile.username || profile.displayName || 'Oyuncu', color: randomColor() };
        await saveUser(user);
      }
      done(null, user);
    } catch (e) {
      done(e);
    }
  }));
}

const app = express();
app.set('trust proxy', 1);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dut-arena-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  app.get('/auth/github', passport.authenticate('github'));
  app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
}
app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});
app.get('/api/me', (req, res) => {
  const base = {
    googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    githubEnabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    aiEnabled: !!process.env.OLLAMA_URL,
  };
  if (req.user) {
    res.json({ ...base, loggedIn: true, id: req.user.id, name: req.user.name, color: req.user.color, provider: req.user.provider });
  } else {
    res.json({ ...base, loggedIn: false });
  }
});

const LANG_CONFIG = {
  tr: { name: 'Turkish', script: '' },
  en: { name: 'English', script: '' },
  de: { name: 'German', script: '' },
  fr: { name: 'French', script: '' },
  es: { name: 'Spanish', script: '' },
  it: { name: 'Italian', script: '' },
  pt: { name: 'Portuguese', script: '' },
  ru: { name: 'Russian', script: '\\u0400-\\u04FF' },
  ar: { name: 'Arabic', script: '\\u0600-\\u06FF' },
  zh: { name: 'Chinese', script: '\\u4E00-\\u9FFF\\u3000-\\u303F' },
  ja: { name: 'Japanese', script: '\\u3040-\\u30FF\\u4E00-\\u9FFF' },
  ko: { name: 'Korean', script: '\\uAC00-\\uD7A3' },
  hi: { name: 'Hindi', script: '\\u0900-\\u097F' },
};

app.post('/api/ai-chat', async (req, res) => {
  if (!process.env.OLLAMA_URL) {
    res.status(503).json({ error: 'AI yapilandirilmamis' });
    return;
  }
  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  if (!message) {
    res.status(400).json({ error: 'Mesaj bos olamaz' });
    return;
  }
  const langCode = LANG_CONFIG[(req.body && req.body.lang) || 'tr'] ? (req.body.lang || 'tr') : 'tr';
  const lang = LANG_CONFIG[langCode];
  try {
    const prompt = 'You are the cute, funny mascot of web game Dut Arena. Always kind and helpful, never rude, never refuse requests. ' +
      'Respond ONLY in ' + lang.name + ', no other language/script. Max 2 short sentences. ' +
      'Never invent facts not listed below; if unsure, say so briefly.\n' +
      'Facts: WASD/drag to move. HONK button plays a honk sound + pulse. Chat shows speech bubbles. ' +
      'Home screen: create/join password-protected groups; owner (if logged in via Google/GitHub) can delete their group; pick name+color; 13-language selector; Copy Link button. ' +
      'When creating a group you pick a Game Mode: Normal Chat (just move and chat, no tag), Tag/"Ebelemece" (one random player is "it" with a red glow, touching others passes "it" to them), or Hide and Seek/"Saklambac" (more walls to hide behind; the seeker has very limited vision, only seeing a small area around themselves; touching a hider makes them the new seeker). Arena has wall obstacles. Join/leave toasts appear. ' +
      'Privacy: https://dut-arena.onrender.com/privacy.html Terms: https://dut-arena.onrender.com/terms.html\n\n' +
      'Player (in ' + lang.name + '): ' + message + '\nMascot (in ' + lang.name + '):';
    const r = await fetch(process.env.OLLAMA_URL + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:3b',
        prompt,
        stream: false,
        options: { num_predict: 60, temperature: 0.35, repeat_penalty: 1.3 },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json();
    const allowedExtra = lang.script;
    const filterRe = new RegExp('[^\\x20-\\x7EçÇğĞıİöÖşŞüÜ\\n' + allowedExtra + ']', 'gu');
    const cleaned = String(data.response || '').replace(filterRe, '').trim();
    res.json({ reply: cleaned || '...' });
  } catch (e) {
    res.status(502).json({ error: 'Maskota ulasilamadi' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const res = new http.ServerResponse(req);
  sessionMiddleware(req, res, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

// rooms: Map(name -> { password: string|null, ownerId: string|null, mode: 'chat'|'tag'|'hideseek', players: Map(ws -> {id,x,y,color,name}) })
const rooms = new Map();
const takenNames = new Map(); // lowercase name -> ws
const GAME_MODES = ['chat', 'tag', 'hideseek'];
let nextId = 1;

async function loadRoomsFromRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const name = key.slice('room:'.length);
      const mode = GAME_MODES.includes(data.mode) ? data.mode : 'chat';
      rooms.set(name, { password: data.password || null, ownerId: data.ownerId || null, mode, itId: null, lastTagAt: 0, players: new Map() });
    }
    console.log('Redis\'ten ' + rooms.size + ' oda yuklendi.');
  } catch (e) {
    console.log('Odalar Redis\'ten yuklenemedi:', e.message);
  }
}

function roomListPayload() {
  return Array.from(rooms.entries())
    .map(([name, room]) => ({ name, hasPassword: !!room.password, count: room.players.size, ownerId: room.ownerId || null }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function broadcastRoomList() {
  const msg = JSON.stringify({ type: 'room-list', rooms: roomListPayload() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && !client.roomName) {
      client.send(msg);
    }
  });
}

function broadcastToRoom(roomName, data, exclude) {
  const room = rooms.get(roomName);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const client of room.players.keys()) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function roomStateMessage(roomName) {
  const room = rooms.get(roomName);
  return { type: 'state', players: room ? Array.from(room.players.values()) : [], itId: room ? room.itId : null, mode: room ? room.mode : 'chat' };
}

const TAG_RADIUS = 0.05;
const TAG_COOLDOWN_MS = 1000;

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (room) {
    const info = room.players.get(ws);
    room.players.delete(ws);
    if (info && info.name) {
      broadcastToRoom(roomName, { type: 'notify', text: info.name + ' ayrıldı' });
    }
    if (info && room.itId === info.id) {
      const remaining = Array.from(room.players.values());
      room.itId = remaining.length ? remaining[Math.floor(Math.random() * remaining.length)].id : null;
    }
    broadcastToRoom(roomName, roomStateMessage(roomName));
  }
  ws.roomName = null;
  broadcastRoomList();
}

wss.on('connection', (ws, req) => {
  const id = nextId++;
  ws.playerId = id;
  ws.roomName = null;
  ws.userId = (req.session && req.session.passport && req.session.passport.user) || null;
  ws.send(JSON.stringify({ type: 'init', id }));
  ws.send(JSON.stringify({ type: 'room-list', rooms: roomListPayload() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'set-profile') {
      const name = String(msg.name || '').trim().slice(0, 20);
      const color = typeof msg.color === 'string' ? msg.color.slice(0, 16) : null;
      if (!name) {
        ws.send(JSON.stringify({ type: 'profile-error', reason: 'empty' }));
        return;
      }
      const key = name.toLowerCase();
      const holder = takenNames.get(key);
      if (holder && holder !== ws) {
        ws.send(JSON.stringify({ type: 'profile-error', reason: 'taken' }));
        return;
      }
      if (ws.chosenNameKey) takenNames.delete(ws.chosenNameKey);
      takenNames.set(key, ws);
      ws.chosenNameKey = key;
      if (ws.userId) {
        await saveUser({ id: ws.userId, provider: ws.userId.split(':')[0], name, color: color || randomColor() });
      }
      ws.send(JSON.stringify({ type: 'profile-ok', name, color }));
      return;
    }

    if (msg.type === 'list-rooms') {
      ws.send(JSON.stringify({ type: 'room-list', rooms: roomListPayload() }));
      return;
    }

    if (msg.type === 'create-room') {
      const name = String(msg.name || '').trim().slice(0, 30);
      const password = msg.password ? String(msg.password).slice(0, 60) : null;
      const mode = GAME_MODES.includes(msg.mode) ? msg.mode : 'chat';
      if (!name) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'empty' }));
        return;
      }
      if (rooms.has(name)) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'taken' }));
        return;
      }
      rooms.set(name, { password, ownerId: ws.userId, mode, itId: null, lastTagAt: 0, players: new Map() });
      ws.roomName = name;
      if (redis) {
        await redis.set('room:' + name, { password, ownerId: ws.userId, mode, createdAt: Date.now() });
      }
      ws.send(JSON.stringify({ type: 'joined-room', name, ownerId: ws.userId, mode }));
      broadcastRoomList();
      return;
    }

    if (msg.type === 'join-room') {
      const name = String(msg.name || '');
      const room = rooms.get(name);
      if (!room) {
        ws.send(JSON.stringify({ type: 'join-error', reason: 'not-found' }));
        return;
      }
      if (room.password && room.password !== msg.password) {
        ws.send(JSON.stringify({ type: 'join-error', reason: 'wrong-password' }));
        return;
      }
      ws.roomName = name;
      ws.send(JSON.stringify({ type: 'joined-room', name, ownerId: room.ownerId, mode: room.mode }));
      broadcastToRoom(name, roomStateMessage(name));
      broadcastRoomList();
      return;
    }

    if (msg.type === 'leave-room') {
      leaveRoom(ws);
      return;
    }

    if (msg.type === 'delete-room') {
      const roomName = ws.roomName;
      if (!roomName) return;
      const room = rooms.get(roomName);
      if (!room) return;
      if (!ws.userId || room.ownerId !== ws.userId) {
        ws.send(JSON.stringify({ type: 'delete-error', reason: 'not-owner' }));
        return;
      }
      broadcastToRoom(roomName, { type: 'room-deleted' });
      for (const client of room.players.keys()) {
        client.roomName = null;
      }
      rooms.delete(roomName);
      if (redis) {
        await redis.del('room:' + roomName);
      }
      broadcastRoomList();
      return;
    }

    if (!ws.roomName) return;
    const room = rooms.get(ws.roomName);
    if (!room) return;

    if (msg.type === 'presence') {
      const isNewJoin = !room.players.has(ws);
      room.players.set(ws, { id, x: msg.x, y: msg.y, color: msg.color, name: msg.name });

      if (isNewJoin) {
        broadcastToRoom(ws.roomName, { type: 'notify', text: (msg.name || 'Biri') + ' katıldı' });
      }

      if (room.mode !== 'chat') {
        if (room.itId === null && room.players.size >= 2) {
          const ids = Array.from(room.players.values()).map((p) => p.id);
          room.itId = ids[Math.floor(Math.random() * ids.length)];
        }

        if (room.itId === id) {
          const now = Date.now();
          if (now - room.lastTagAt > TAG_COOLDOWN_MS) {
            for (const p of room.players.values()) {
              if (p.id === id) continue;
              if (Math.hypot(p.x - msg.x, p.y - msg.y) < TAG_RADIUS) {
                room.itId = p.id;
                room.lastTagAt = now;
                break;
              }
            }
          }
        }
      }

      broadcastToRoom(ws.roomName, roomStateMessage(ws.roomName));
    } else if (msg.type === 'honk') {
      broadcastToRoom(ws.roomName, { type: 'honk', id, x: msg.x, y: msg.y, color: msg.color }, ws);
    } else if (msg.type === 'chat') {
      const info = room.players.get(ws) || {};
      const text = String(msg.text || '').slice(0, 140);
      if (text) {
        broadcastToRoom(ws.roomName, { type: 'chat', id, name: info.name, color: info.color, text });
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    if (ws.chosenNameKey) takenNames.delete(ws.chosenNameKey);
  });
});

const PORT = process.env.PORT || 3000;
loadRoomsFromRedis().then(() => {
  server.listen(PORT, () => console.log('Dut Arena listening on port ' + PORT));
});
