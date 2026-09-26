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

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback',
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
    callbackURL: '/auth/github/callback',
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
  if (req.user) {
    res.json({ loggedIn: true, id: req.user.id, name: req.user.name, color: req.user.color, provider: req.user.provider });
  } else {
    res.json({
      loggedIn: false,
      googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      githubEnabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
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

// rooms: Map(name -> { password: string|null, ownerId: string|null, players: Map(ws -> {id,x,y,color,name}) })
const rooms = new Map();
const takenNames = new Map(); // lowercase name -> ws
let nextId = 1;

async function loadRoomsFromRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const name = key.slice('room:'.length);
      rooms.set(name, { password: data.password || null, ownerId: data.ownerId || null, players: new Map() });
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
  return { type: 'state', players: room ? Array.from(room.players.values()) : [] };
}

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (room) {
    room.players.delete(ws);
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
      if (!name) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'empty' }));
        return;
      }
      if (rooms.has(name)) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'taken' }));
        return;
      }
      rooms.set(name, { password, ownerId: ws.userId, players: new Map() });
      ws.roomName = name;
      if (redis) {
        await redis.set('room:' + name, { password, ownerId: ws.userId, createdAt: Date.now() });
      }
      ws.send(JSON.stringify({ type: 'joined-room', name }));
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
      ws.send(JSON.stringify({ type: 'joined-room', name }));
      broadcastToRoom(name, roomStateMessage(name));
      broadcastRoomList();
      return;
    }

    if (msg.type === 'leave-room') {
      leaveRoom(ws);
      return;
    }

    if (!ws.roomName) return;
    const room = rooms.get(ws.roomName);
    if (!room) return;

    if (msg.type === 'presence') {
      room.players.set(ws, { id, x: msg.x, y: msg.y, color: msg.color, name: msg.name });
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
