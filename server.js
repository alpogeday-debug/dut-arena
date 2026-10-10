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

async function recordHallOfFameWin(userId, name) {
  if (!redis) return;
  try {
    const key = 'hof:' + userId;
    const cur = (await redis.get(key)) || { name, wins: 0 };
    cur.name = name;
    cur.wins = (cur.wins || 0) + 1;
    await redis.set(key, cur);
    await redis.sadd('hof:index', userId);
  } catch (e) { /* ignore */ }
}

app.get('/api/profile/:userId', async (req, res) => {
  if (!redis) { res.json({ wins: 0 }); return; }
  try {
    const data = await redis.get('hof:' + req.params.userId);
    res.json({ wins: (data && data.wins) || 0 });
  } catch (e) {
    res.json({ wins: 0 });
  }
});

app.get('/api/hall-of-fame', async (req, res) => {
  if (!redis) { res.json({ entries: [] }); return; }
  try {
    const ids = await redis.smembers('hof:index');
    const entries = [];
    for (const uid of ids) {
      const data = await redis.get('hof:' + uid);
      if (data) entries.push({ name: data.name, wins: data.wins });
    }
    entries.sort((a, b) => b.wins - a.wins);
    res.json({ entries: entries.slice(0, 10) });
  } catch (e) {
    res.json({ entries: [] });
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
        stream: true,
        options: { num_predict: 60, temperature: 0.35, repeat_penalty: 1.3 },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const allowedExtra = lang.script;
    const filterRe = new RegExp('[^\\x20-\\x7EçÇğĞıİöÖşŞüÜ\\n' + allowedExtra + ']', 'gu');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let wrote = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch (e) { continue; }
        const piece = String(chunk.response || '').replace(filterRe, '');
        if (piece) { res.write(piece); wrote = true; }
      }
    }
    if (!wrote) res.write('...');
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Maskota ulasilamadi' });
    else res.end();
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
const GAME_MODES = ['chat', 'tag', 'hideseek', 'football', 'battle', 'ffa', 'royale', 'zombie', 'ctf', 'koth', 'race', 'paint'];
const TEAM_MODES = ['battle', 'ctf'];
let nextId = 1;

// Roblox-style 3D mini-game rooms: Map(code -> { mapId, players: Map(ws -> {id,name,color,x,y,z,ry}) })
const rbxRooms = new Map();
const RBX_MAPS = ['classic', 'parkour', 'arena'];
const RBX_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genRbxCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += RBX_CODE_CHARS[Math.floor(Math.random() * RBX_CODE_CHARS.length)];
  } while (rbxRooms.has(code));
  return code;
}

function rbxPlayerList(room) {
  return Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, ry: p.ry }));
}

function broadcastRbx(code, data, excludeWs) {
  const room = rbxRooms.get(code);
  if (!room) return;
  const json = JSON.stringify(data);
  room.players.forEach((info, clientWs) => {
    if (clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) clientWs.send(json);
  });
}

function rbxLeave(ws) {
  const code = ws.rbxRoom;
  if (!code) return;
  const room = rbxRooms.get(code);
  ws.rbxRoom = null;
  if (!room) return;
  room.players.delete(ws);
  if (room.players.size === 0) {
    rbxRooms.delete(code);
  } else {
    broadcastRbx(code, { type: 'rbx-player-left', id: ws.playerId });
  }
}

function makeRoom(password, ownerId, mode, teamSize) {
  return {
    password,
    ownerId,
    mode,
    teamSize: Math.max(1, Math.min(5, teamSize || 3)),
    itId: null,
    lastTagAt: 0,
    players: new Map(),
    scores: new Map(),
    powerups: new Map(),
    shields: new Map(),
    nextRainAt: Date.now() + 15000 + Math.random() * 15000,
    ball: { x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0 },
    lastToucher: null,
    roundPhase: 'waiting',
    roundEndsAt: 0,
    teamScores: { red: 0, blue: 0 },
    lastHitAt: new Map(),
    zombies: new Set(),
    raceWinner: null,
    zoneRadius: null,
    flags: {
      red: { x: RED_SPAWN.x, y: RED_SPAWN.y, carriedBy: null },
      blue: { x: BLUE_SPAWN.x, y: BLUE_SPAWN.y, carriedBy: null },
    },
    paintGrid: new Map(),
  };
}

function assignBattleTeam(room) {
  let red = 0, blue = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') red++;
    else if (p.team === 'blue') blue++;
  }
  return red <= blue ? 'red' : 'blue';
}

async function loadRoomsFromRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const name = key.slice('room:'.length);
      const mode = GAME_MODES.includes(data.mode) ? data.mode : 'chat';
      rooms.set(name, makeRoom(data.password || null, data.ownerId || null, mode, data.teamSize));
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

app.get('/api/online-users', async (req, res) => {
  const online = new Map();
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId && client.name) {
      let room = client.roomName || null;
      if (room) {
        const r = rooms.get(room);
        if (r && r.password) room = null;
      }
      online.set(client.userId, { name: client.name, room });
    }
  });
  if (!redis) {
    res.json({ users: Array.from(online.values()).map((u) => ({ name: u.name, room: u.room, online: true })) });
    return;
  }
  try {
    const keys = await redis.keys('user:*');
    const users = [];
    for (const key of keys) {
      const id = key.slice('user:'.length);
      const live = online.get(id);
      if (live) {
        users.push({ name: live.name, room: live.room, online: true });
        continue;
      }
      const data = await redis.get(key);
      if (data && data.name) users.push({ name: data.name, room: null, online: false });
    }
    users.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    res.json({ users });
  } catch (e) {
    res.json({ users: Array.from(online.values()).map((u) => ({ name: u.name, room: u.room, online: true })) });
  }
});

app.get('/api/find-players', (req, res) => {
  const wanted = String(req.query.names || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
  const found = {};
  if (wanted.length) {
    for (const [roomName, room] of rooms.entries()) {
      if (room.password) continue;
      for (const p of room.players.values()) {
        const key = (p.name || '').toLowerCase();
        if (wanted.includes(key) && !found[key]) {
          found[key] = roomName;
        }
      }
    }
  }
  res.json({ found });
});

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
  const now = Date.now();
  return {
    type: 'state',
    players: room ? Array.from(room.players.values()).map((p) => ({ ...p, shielded: (room.shields.get(p.id) || 0) > now })) : [],
    itId: room ? room.itId : null,
    mode: room ? room.mode : 'chat',
    scores: room ? Array.from(room.scores.entries()).map(([id, score]) => ({ id, score })) : [],
    roundPhase: room ? room.roundPhase : 'waiting',
    roundEndsAt: room ? room.roundEndsAt : 0,
    teamScores: room ? room.teamScores : null,
    zombies: room && room.mode === 'zombie' ? Array.from(room.zombies) : null,
    flags: room && room.mode === 'ctf' ? room.flags : null,
    zoneRadius: room && (room.mode === 'royale' || room.mode === 'koth') ? room.zoneRadius : null,
  };
}

const TAG_RADIUS = 0.05;
const TAG_COOLDOWN_MS = 1000;
const WORLD_W = 2.4;
const WORLD_H = 2.4;
const POWERUP_TTL_MS = 20000;
const POWERUP_TYPES_GAME = ['speed', 'teleport', 'shield'];
const POWERUP_TYPES_CHAT = ['dumpling', 'squishy', 'donut', 'boba'];
let nextPowerupId = 1;

const HIT_RADIUS = 0.07;
const HIT_COOLDOWN_MS = 800;
const RED_SPAWN = { x: 0.3, y: WORLD_H / 2 };
const BLUE_SPAWN = { x: WORLD_W - 0.3, y: WORLD_H / 2 };

const ROUND_MS = 60000;
const INTERMISSION_MS = 8000;
const TAGLIKE_MODES = ['tag', 'hideseek'];
const ROUND_MODES = ['tag', 'hideseek', 'royale', 'koth', 'zombie', 'race'];
const PAINT_GRID_N = 16;

function startRound(room, roomName, now, isFirst) {
  room.roundPhase = 'playing';
  room.scores.clear();
  room.roundEndsAt = now + ROUND_MS;
  room.raceWinner = null;
  if (TAGLIKE_MODES.includes(room.mode)) {
    room.itId = null;
  } else if (room.mode === 'zombie') {
    room.zombies = new Set();
    const ids = Array.from(room.players.values()).map((p) => p.id);
    if (ids.length) room.zombies.add(ids[Math.floor(Math.random() * ids.length)]);
  } else if (room.mode === 'race') {
    const startPt = { x: 0.3, y: 0.3 };
    for (const [pws, p] of room.players.entries()) {
      p.x = startPt.x + (Math.random() - 0.5) * 0.15;
      p.y = startPt.y + (Math.random() - 0.5) * 0.15;
      if (pws.readyState === WebSocket.OPEN) {
        pws.send(JSON.stringify({ type: 'force-position', x: p.x, y: p.y }));
      }
    }
  }
  broadcastToRoom(roomName, { type: 'notify', key: isFirst ? 'round_start' : 'round_new' });
}

function endRound(room, roomName, now) {
  let winnerEntry = null;
  let winnerScore = null;
  const noScore = room.mode === 'race';
  if (room.mode === 'race') {
    if (room.raceWinner) {
      winnerEntry = Array.from(room.players.entries()).find(([, p]) => p.id === room.raceWinner);
    }
  } else {
    const sorted = Array.from(room.scores.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length && sorted[0][1] > 0) {
      winnerEntry = Array.from(room.players.entries()).find(([, p]) => p.id === sorted[0][0]);
      winnerScore = sorted[0][1];
    }
  }
  if (winnerEntry) {
    const [winnerWs, winnerP] = winnerEntry;
    broadcastToRoom(roomName, { type: 'notify', key: noScore ? 'round_end_winner_noscore' : 'round_end_winner', name: winnerP.name, score: winnerScore });
    if (winnerWs.userId) recordHallOfFameWin(winnerWs.userId, winnerP.name);
  } else {
    broadcastToRoom(roomName, { type: 'notify', key: 'round_end_none' });
  }
  room.roundPhase = 'intermission';
  room.roundEndsAt = now + INTERMISSION_MS;
}

function tickRoundScoring(room, roomName, now) {
  if (TAGLIKE_MODES.includes(room.mode)) {
    for (const p of room.players.values()) {
      if (p.id !== room.itId) room.scores.set(p.id, (room.scores.get(p.id) || 0) + 1);
    }
  } else if (room.mode === 'zombie') {
    for (const p of room.players.values()) {
      if (!room.zombies.has(p.id)) room.scores.set(p.id, (room.scores.get(p.id) || 0) + 1);
    }
    if (room.players.size >= 2 && room.zombies.size >= room.players.size) {
      endRound(room, roomName, now);
    }
  } else if (room.mode === 'royale' || room.mode === 'koth') {
    let radius;
    if (room.mode === 'royale') {
      const elapsed = ROUND_MS - (room.roundEndsAt - now);
      const t = Math.min(1, Math.max(0, elapsed / ROUND_MS));
      radius = 1.2 - t * 0.95;
    } else {
      radius = 0.3;
    }
    room.zoneRadius = radius;
    for (const p of room.players.values()) {
      const dx = p.x - WORLD_W / 2, dy = p.y - WORLD_H / 2;
      if (Math.hypot(dx, dy) <= radius) {
        room.scores.set(p.id, (room.scores.get(p.id) || 0) + 1);
      }
    }
  }
}

function recomputePaintScores(room) {
  const tally = new Map();
  for (const owner of room.paintGrid.values()) {
    tally.set(owner, (tally.get(owner) || 0) + 1);
  }
  room.scores = tally;
}

setInterval(() => {
  const now = Date.now();
  for (const [roomName, room] of rooms.entries()) {
    if (ROUND_MODES.includes(room.mode)) {
      if (room.players.size < 2) {
        room.roundPhase = 'waiting';
      } else if (room.roundPhase === 'waiting') {
        startRound(room, roomName, now, true);
      } else if (now >= room.roundEndsAt) {
        if (room.roundPhase === 'playing') {
          endRound(room, roomName, now);
        } else {
          startRound(room, roomName, now, false);
        }
      }
      if (room.roundPhase === 'playing') {
        tickRoundScoring(room, roomName, now);
      }
    }

    if (room.mode === 'paint') {
      recomputePaintScores(room);
    }

    for (const [pid, exp] of room.shields.entries()) {
      if (exp < now) room.shields.delete(pid);
    }
    for (const [pid, p] of room.powerups.entries()) {
      if (now - p.spawnedAt > POWERUP_TTL_MS) room.powerups.delete(pid);
    }

    if (room.mode !== 'football' && room.players.size > 0 && now >= room.nextRainAt) {
      const margin = 0.08;
      const count = 4 + Math.floor(Math.random() * 3);
      const types = room.mode === 'chat' ? POWERUP_TYPES_CHAT : POWERUP_TYPES_GAME;
      const items = [];
      for (let i = 0; i < count; i++) {
        const item = {
          id: 'p' + (nextPowerupId++),
          type: types[Math.floor(Math.random() * types.length)],
          x: margin + Math.random() * (WORLD_W - margin * 2),
          y: margin + Math.random() * (WORLD_H - margin * 2),
          spawnedAt: now,
        };
        room.powerups.set(item.id, item);
        items.push(item);
      }
      broadcastToRoom(roomName, { type: 'rain', items, ttlMs: POWERUP_TTL_MS });
      broadcastToRoom(roomName, { type: 'notify', key: room.mode === 'chat' ? 'rain_item' : 'rain_power' });
      room.nextRainAt = now + 20000 + Math.random() * 20000;
    }
  }
}, 1000);

const FOOTBALL_FRICTION = 0.97;
const KICK_RADIUS = 0.09;
const KICK_POWER = 1.4;
const GOAL_HALF_HEIGHT = 0.35;
const GOAL_DEPTH = 0.08;

function scoreGoal(roomName, room) {
  const scorer = room.lastToucher;
  if (scorer) {
    room.scores.set(scorer, (room.scores.get(scorer) || 0) + 1);
    const info = Array.from(room.players.values()).find((p) => p.id === scorer);
    broadcastToRoom(roomName, { type: 'notify', key: 'goal', name: info ? info.name : null });
  }
  room.ball.x = WORLD_W / 2;
  room.ball.y = WORLD_H / 2;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.lastToucher = null;
  broadcastToRoom(roomName, roomStateMessage(roomName));
}

setInterval(() => {
  for (const [roomName, room] of rooms.entries()) {
    if (room.mode !== 'football') continue;
    const b = room.ball;
    b.x += b.vx * 0.05;
    b.y += b.vy * 0.05;
    b.vx *= FOOTBALL_FRICTION;
    b.vy *= FOOTBALL_FRICTION;

    const inGoalY = b.y > (WORLD_H / 2 - GOAL_HALF_HEIGHT) && b.y < (WORLD_H / 2 + GOAL_HALF_HEIGHT);
    if (b.x < GOAL_DEPTH && inGoalY) {
      scoreGoal(roomName, room);
      continue;
    }
    if (b.x > WORLD_W - GOAL_DEPTH && inGoalY) {
      scoreGoal(roomName, room);
      continue;
    }
    if (b.x < 0.03) { b.x = 0.03; b.vx *= -0.6; }
    if (b.x > WORLD_W - 0.03) { b.x = WORLD_W - 0.03; b.vx *= -0.6; }
    if (b.y < 0.03) { b.y = 0.03; b.vy *= -0.6; }
    if (b.y > WORLD_H - 0.03) { b.y = WORLD_H - 0.03; b.vy *= -0.6; }

    broadcastToRoom(roomName, { type: 'ball', x: b.x, y: b.y });
  }
}, 50);

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (room) {
    const info = room.players.get(ws);
    room.players.delete(ws);
    if (info && info.name) {
      broadcastToRoom(roomName, { type: 'notify', key: 'leave', name: info.name });
    }
    if (info) {
      room.scores.delete(info.id);
      room.shields.delete(info.id);
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
      ws.name = name;
      if (ws.userId) {
        await saveUser({ id: ws.userId, provider: ws.userId.split(':')[0], name, color: color || randomColor() });
      }
      ws.send(JSON.stringify({ type: 'profile-ok', name, color }));
      return;
    }

    if (msg.type === 'rbx-create') {
      const mapId = RBX_MAPS.includes(msg.mapId) ? msg.mapId : 'classic';
      const name = String(msg.name || ws.name || 'Misafir').trim().slice(0, 20) || 'Misafir';
      const color = typeof msg.color === 'string' ? msg.color.slice(0, 16) : '#4da3ff';
      const code = genRbxCode();
      const room = { mapId, players: new Map() };
      room.players.set(ws, { id, name, color, x: 0, y: 0, z: 0, ry: 0 });
      rbxRooms.set(code, room);
      ws.rbxRoom = code;
      ws.send(JSON.stringify({ type: 'rbx-joined', code, mapId, selfId: id, players: rbxPlayerList(room) }));
      return;
    }

    if (msg.type === 'rbx-join') {
      const code = String(msg.code || '').trim().toUpperCase().slice(0, 10);
      const room = rbxRooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'rbx-join-error', reason: 'not-found' }));
        return;
      }
      const name = String(msg.name || ws.name || 'Misafir').trim().slice(0, 20) || 'Misafir';
      const color = typeof msg.color === 'string' ? msg.color.slice(0, 16) : '#4da3ff';
      room.players.set(ws, { id, name, color, x: 0, y: 0, z: 0, ry: 0 });
      ws.rbxRoom = code;
      ws.send(JSON.stringify({ type: 'rbx-joined', code, mapId: room.mapId, selfId: id, players: rbxPlayerList(room) }));
      broadcastRbx(code, { type: 'rbx-player-joined', id, name, color, x: 0, y: 0, z: 0, ry: 0 }, ws);
      return;
    }

    if (msg.type === 'rbx-pos') {
      const code = ws.rbxRoom;
      const room = code && rbxRooms.get(code);
      const info = room && room.players.get(ws);
      if (!info) return;
      info.x = Number(msg.x) || 0;
      info.y = Number(msg.y) || 0;
      info.z = Number(msg.z) || 0;
      info.ry = Number(msg.ry) || 0;
      broadcastRbx(code, { type: 'rbx-pos', id, x: info.x, y: info.y, z: info.z, ry: info.ry }, ws);
      return;
    }

    if (msg.type === 'rbx-chat') {
      const code = ws.rbxRoom;
      const room = code && rbxRooms.get(code);
      const info = room && room.players.get(ws);
      const text = String(msg.text || '').slice(0, 140);
      if (!info || !text) return;
      broadcastRbx(code, { type: 'rbx-chat', id, name: info.name, text });
      return;
    }

    if (msg.type === 'rbx-leave') {
      rbxLeave(ws);
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
      const teamSize = Math.max(1, Math.min(5, parseInt(msg.teamSize, 10) || 3));
      if (!name) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'empty' }));
        return;
      }
      if (rooms.has(name)) {
        ws.send(JSON.stringify({ type: 'create-error', reason: 'taken' }));
        return;
      }
      const room = makeRoom(password, ws.userId, mode, teamSize);
      rooms.set(name, room);
      ws.roomName = name;
      let team = null;
      if (TEAM_MODES.includes(mode)) {
        team = assignBattleTeam(room);
        ws.battleTeam = team;
      }
      if (redis) {
        await redis.set('room:' + name, { password, ownerId: ws.userId, mode, teamSize, createdAt: Date.now() });
      }
      ws.send(JSON.stringify({ type: 'joined-room', name, ownerId: ws.userId, mode, team, teamSize: room.teamSize }));
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
      if (TEAM_MODES.includes(room.mode) && room.players.size >= room.teamSize * 2) {
        ws.send(JSON.stringify({ type: 'join-error', reason: 'full' }));
        return;
      }
      ws.roomName = name;
      let team = null;
      if (TEAM_MODES.includes(room.mode)) {
        team = assignBattleTeam(room);
        ws.battleTeam = team;
      }
      ws.send(JSON.stringify({ type: 'joined-room', name, ownerId: room.ownerId, mode: room.mode, team, teamSize: room.teamSize }));
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
      room.players.set(ws, { id, x: msg.x, y: msg.y, color: msg.color, name: msg.name, accessory: typeof msg.accessory === 'string' ? msg.accessory.slice(0, 20) : null, team: TEAM_MODES.includes(room.mode) ? ws.battleTeam : undefined });

      if (isNewJoin) {
        broadcastToRoom(ws.roomName, { type: 'notify', key: 'join', name: msg.name || null });
      }

      if (TAGLIKE_MODES.includes(room.mode) && room.roundPhase === 'playing') {
        if (room.itId === null && room.players.size >= 2) {
          const ids = Array.from(room.players.values()).map((p) => p.id);
          room.itId = ids[Math.floor(Math.random() * ids.length)];
        }

        if (room.itId === id) {
          const now = Date.now();
          if (now - room.lastTagAt > TAG_COOLDOWN_MS) {
            for (const p of room.players.values()) {
              if (p.id === id) continue;
              if ((room.shields.get(p.id) || 0) > now) continue;
              if (Math.hypot(p.x - msg.x, p.y - msg.y) < TAG_RADIUS) {
                room.itId = p.id;
                room.lastTagAt = now;
                break;
              }
            }
          }
        }
      }

      if (room.mode === 'football') {
        const b = room.ball;
        const bdx = b.x - msg.x, bdy = b.y - msg.y;
        const bdist = Math.hypot(bdx, bdy);
        if (bdist < KICK_RADIUS && bdist > 0.001) {
          b.vx = (bdx / bdist) * KICK_POWER;
          b.vy = (bdy / bdist) * KICK_POWER;
          room.lastToucher = id;
        }
      }

      if (room.mode === 'zombie' && room.roundPhase === 'playing' && room.zombies.has(id)) {
        const nowZ = Date.now();
        if (nowZ - room.lastTagAt > TAG_COOLDOWN_MS) {
          for (const p of room.players.values()) {
            if (room.zombies.has(p.id)) continue;
            if (Math.hypot(p.x - msg.x, p.y - msg.y) < TAG_RADIUS) {
              room.zombies.add(p.id);
              room.lastTagAt = nowZ;
              broadcastToRoom(ws.roomName, { type: 'notify', key: 'infected', name: p.name });
              break;
            }
          }
        }
      }

      if (room.mode === 'ctf' && ws.battleTeam) {
        const myColor = ws.battleTeam;
        const enemyColor = myColor === 'red' ? 'blue' : 'red';
        const f = room.flags[enemyColor];
        if (f.carriedBy === id) {
          f.x = msg.x;
          f.y = msg.y;
          const myBase = myColor === 'red' ? RED_SPAWN : BLUE_SPAWN;
          if (Math.hypot(msg.x - myBase.x, msg.y - myBase.y) < 0.15) {
            room.teamScores[myColor] = (room.teamScores[myColor] || 0) + 1;
            f.carriedBy = null;
            f.x = enemyColor === 'red' ? RED_SPAWN.x : BLUE_SPAWN.x;
            f.y = enemyColor === 'red' ? RED_SPAWN.y : BLUE_SPAWN.y;
            broadcastToRoom(ws.roomName, { type: 'notify', key: 'ctf_score', name: msg.name });
          }
        }
      }

      if (room.mode === 'race' && room.roundPhase === 'playing' && !room.raceWinner) {
        const finish = { x: WORLD_W - 0.3, y: WORLD_H - 0.3 };
        if (Math.hypot(msg.x - finish.x, msg.y - finish.y) < 0.15) {
          room.raceWinner = id;
          room.roundEndsAt = Date.now();
          broadcastToRoom(ws.roomName, { type: 'notify', key: 'race_finish', name: msg.name });
        }
      }

      if (room.mode === 'paint') {
        const gx = Math.floor((msg.x / WORLD_W) * PAINT_GRID_N);
        const gy = Math.floor((msg.y / WORLD_H) * PAINT_GRID_N);
        const key = gx + ',' + gy;
        if (room.paintGrid.get(key) !== id) {
          room.paintGrid.set(key, id);
          broadcastToRoom(ws.roomName, { type: 'paint', gx, gy, color: msg.color });
        }
      }

      broadcastToRoom(ws.roomName, roomStateMessage(ws.roomName));
    } else if (msg.type === 'honk') {
      broadcastToRoom(ws.roomName, { type: 'honk', id, x: msg.x, y: msg.y, color: msg.color }, ws);
      if (room.mode === 'battle' && ws.battleTeam) {
        const now3 = Date.now();
        const lastHit = room.lastHitAt.get(id) || 0;
        if (now3 - lastHit > HIT_COOLDOWN_MS) {
          for (const [pws, p] of room.players.entries()) {
            if (p.id === id || p.team === ws.battleTeam) continue;
            if ((room.shields.get(p.id) || 0) > now3) continue;
            if (Math.hypot(p.x - msg.x, p.y - msg.y) < HIT_RADIUS) {
              room.lastHitAt.set(id, now3);
              room.teamScores[ws.battleTeam] = (room.teamScores[ws.battleTeam] || 0) + 1;
              const spawn = p.team === 'red' ? RED_SPAWN : BLUE_SPAWN;
              p.x = spawn.x + (Math.random() - 0.5) * 0.1;
              p.y = spawn.y + (Math.random() - 0.5) * 0.1;
              if (pws.readyState === WebSocket.OPEN) {
                pws.send(JSON.stringify({ type: 'force-position', x: p.x, y: p.y }));
              }
              broadcastToRoom(ws.roomName, { type: 'notify', key: 'hit', name: p.name });
              broadcastToRoom(ws.roomName, roomStateMessage(ws.roomName));
              break;
            }
          }
        }
      } else if (room.mode === 'ffa') {
        const nowF = Date.now();
        const lastHit = room.lastHitAt.get(id) || 0;
        if (nowF - lastHit > HIT_COOLDOWN_MS) {
          for (const [pws, p] of room.players.entries()) {
            if (p.id === id) continue;
            if ((room.shields.get(p.id) || 0) > nowF) continue;
            if (Math.hypot(p.x - msg.x, p.y - msg.y) < HIT_RADIUS) {
              room.lastHitAt.set(id, nowF);
              room.scores.set(id, (room.scores.get(id) || 0) + 1);
              const rx = 0.1 + Math.random() * (WORLD_W - 0.2);
              const ry = 0.1 + Math.random() * (WORLD_H - 0.2);
              p.x = rx;
              p.y = ry;
              if (pws.readyState === WebSocket.OPEN) {
                pws.send(JSON.stringify({ type: 'force-position', x: rx, y: ry }));
              }
              broadcastToRoom(ws.roomName, { type: 'notify', key: 'hit', name: p.name });
              broadcastToRoom(ws.roomName, roomStateMessage(ws.roomName));
              break;
            }
          }
        }
      } else if (room.mode === 'ctf' && ws.battleTeam) {
        const enemyColor = ws.battleTeam === 'red' ? 'blue' : 'red';
        const f = room.flags[enemyColor];
        if (!f.carriedBy) {
          const fdist = Math.hypot(f.x - msg.x, f.y - msg.y);
          if (fdist < 0.12) {
            f.carriedBy = id;
            broadcastToRoom(ws.roomName, { type: 'notify', key: 'ctf_pickup', name: msg.name });
            broadcastToRoom(ws.roomName, roomStateMessage(ws.roomName));
          }
        }
      }
    } else if (msg.type === 'chat') {
      const info = room.players.get(ws) || {};
      const text = String(msg.text || '').slice(0, 140);
      if (text) {
        broadcastToRoom(ws.roomName, { type: 'chat', id, name: info.name, color: info.color, text });
      }
    } else if (msg.type === 'collect-powerup') {
      const p = room.powerups.get(String(msg.id));
      if (p) {
        room.powerups.delete(p.id);
        if (p.type === 'shield') {
          room.shields.set(id, Date.now() + 15000);
        }
        broadcastToRoom(ws.roomName, { type: 'powerup-collected', id: p.id, playerId: id, kind: p.type });
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    rbxLeave(ws);
    if (ws.chosenNameKey) takenNames.delete(ws.chosenNameKey);
  });
});

const PORT = process.env.PORT || 3000;
loadRoomsFromRedis().then(() => {
  server.listen(PORT, () => console.log('Dut Arena listening on port ' + PORT));
});
