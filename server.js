const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// rooms: Map(name -> { password: string|null, players: Map(ws -> {id,x,y,color,name}) })
const rooms = new Map();
let nextId = 1;

function roomListPayload() {
  return Array.from(rooms.entries())
    .map(([name, room]) => ({ name, hasPassword: !!room.password, count: room.players.size }))
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

wss.on('connection', (ws) => {
  const id = nextId++;
  ws.playerId = id;
  ws.roomName = null;
  ws.send(JSON.stringify({ type: 'init', id }));
  ws.send(JSON.stringify({ type: 'room-list', rooms: roomListPayload() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
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
      rooms.set(name, { password, players: new Map() });
      ws.roomName = name;
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Dut Arena listening on port ' + PORT));
