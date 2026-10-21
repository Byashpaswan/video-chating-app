// Signaling + matchmaking server. Video/audio never touches this server (WebRTC is peer-to-peer).
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const REPORTS_BEFORE_BAN = 3;
const BAN_MS = 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

function iceServers() {
  const servers = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ],
    },
  ];
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (urls.length && username && credential) {
    servers.push({ urls, username, credential });
  }
  return servers;
}
app.get('/ice', (_req, res) => res.json(iceServers()));

// In-memory state. For multiple server instances, move these to Redis + the Socket.IO Redis adapter.
const waiting = [];            // socket ids waiting for a partner
const partners = new Map();    // socket.id -> partner socket.id
const reportCount = new Map(); // ip -> reports received
const bans = new Map();        // ip -> ban expiry timestamp

const ipOf = (s) =>
  (s.handshake.headers['x-forwarded-for'] || s.handshake.address || '').toString().split(',')[0].trim();
const isBanned = (ip) => {
  const until = bans.get(ip);
  if (!until) return false;
  if (Date.now() > until) { bans.delete(ip); return false; }
  return true;
};
const broadcastOnline = () => io.emit('online', io.engine.clientsCount);

function removeFromQueue(id) {
  const i = waiting.indexOf(id);
  if (i !== -1) waiting.splice(i, 1);
}

function leave(socket) {
  removeFromQueue(socket.id);
  const pid = partners.get(socket.id);
  if (pid) {
    partners.delete(socket.id);
    partners.delete(pid);
    io.to(pid).emit('partner-left');
  }
}

function find(socket) {
  leave(socket);
  while (waiting.length) {
    const otherId = waiting.shift();
    const other = io.sockets.sockets.get(otherId);
    if (!other || otherId === socket.id) continue;       // stale or self
    partners.set(socket.id, otherId);
    partners.set(otherId, socket.id);
    socket.emit('matched', { initiator: true });          // this side creates the WebRTC offer
    other.emit('matched', { initiator: false });
    return;
  }
  waiting.push(socket.id);
  socket.emit('waiting');
}

// Simple sliding-window rate limiter per socket
function limiter(max, windowMs) {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < windowMs);
    if (stamps.length >= max) return false;
    stamps.push(now);
    return true;
  };
}

io.on('connection', (socket) => {
  const ip = ipOf(socket);
  const chatLimit = limiter(5, 3000);
  const findLimit = limiter(10, 10000);
  const signalLimit = limiter(200, 10000);
  broadcastOnline();

  socket.on('find', () => {
    if (isBanned(ip)) return socket.emit('banned');
    if (!findLimit()) return socket.emit('notice', 'Slow down a little before pressing Next again.');
    find(socket);
  });

  socket.on('stop', () => leave(socket));

  // Relay offer / answer / ICE candidates to the matched partner only
  socket.on('signal', (data) => {
    const pid = partners.get(socket.id);
    if (!pid || !signalLimit() || typeof data !== 'object') return;
    io.to(pid).emit('signal', data);
  });

  socket.on('chat', (text) => {
    const pid = partners.get(socket.id);
    if (!pid || typeof text !== 'string') return;
    if (!chatLimit()) return socket.emit('notice', 'You are sending messages too quickly.');
    const clean = text.trim().slice(0, 500);
    if (clean) io.to(pid).emit('chat', clean);
  });

  socket.on('report', () => {
    const pid = partners.get(socket.id);
    const target = pid && io.sockets.sockets.get(pid);
    if (!target) return;
    const tip = ipOf(target);
    const n = (reportCount.get(tip) || 0) + 1;
    reportCount.set(tip, n);
    console.log(`[report] ${tip} reported (${n})`);
    if (n >= REPORTS_BEFORE_BAN) {
      bans.set(tip, Date.now() + BAN_MS);
      reportCount.delete(tip);
      target.emit('banned');
      leave(target);
    }
    socket.emit('notice', 'Report sent. Thank you.');
    find(socket); // move the reporter on to a new person
  });

  socket.on('disconnect', () => { leave(socket); broadcastOnline(); });
});

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
