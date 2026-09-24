const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const players = new Map(); // ws -> {id, x, y, color, name}
let nextId = 1;

function broadcast(data, exclude) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function stateMessage() {
  return { type: 'state', players: Array.from(players.values()) };
}

wss.on('connection', (ws) => {
  const id = nextId++;
  ws.send(JSON.stringify({ type: 'init', id }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'presence') {
      players.set(ws, {
        id,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        name: msg.name,
      });
      broadcast(stateMessage());
    } else if (msg.type === 'honk') {
      broadcast({ type: 'honk', id, x: msg.x, y: msg.y, color: msg.color }, ws);
    } else if (msg.type === 'chat') {
      const info = players.get(ws) || {};
      const text = String(msg.text || '').slice(0, 140);
      if (text) {
        broadcast({ type: 'chat', id, name: info.name, color: info.color, text });
      }
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    broadcast(stateMessage());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Dut Arena listening on port ' + PORT));
