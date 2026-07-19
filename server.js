'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QUESTIONS = require('./questions');

const PORT = process.env.PORT || 3000;

const TOTAL_ROUNDS = 10;
const TURNS_PER_GAME = TOTAL_ROUNDS * 2;
const TURN_MS = 20_000;
const REVEAL_MS = 3_000;
const CLAIM_AFTER_MS = 2 * 60_000;
const WAITING_TTL_MS = 30 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;
const HARD_TTL_MS = 60 * 60_000;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // code -> Room

// ── helpers ───────────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function pickQuestions() {
  const bank = shuffle([...QUESTIONS]);
  const picked = bank.slice(0, TURNS_PER_GAME);
  const rest = bank.slice(TURNS_PER_GAME);
  const cats = new Set(picked.map((q) => q.category));
  // Soft constraint: at least 4 categories represented.
  for (const q of rest) {
    if (cats.size >= 4) break;
    if (cats.has(q.category)) continue;
    const counts = new Map();
    for (const p of picked) counts.set(p.category, (counts.get(p.category) || 0) + 1);
    const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    picked[picked.findIndex((p) => p.category === biggest)] = q;
    cats.add(q.category);
  }
  return shuffle(picked);
}

function sanitizeName(name, fallback) {
  const clean = String(name || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 20);
  return clean || fallback;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ── Room ──────────────────────────────────────────────────────────

class Room {
  constructor(code) {
    this.code = code;
    this.phase = 'waiting'; // waiting | playing | finished
    this.players = []; // [{ id, name, role, score, connected, ws, stats, disconnectTimer }]
    this.queue = [];
    this.turnIndex = 0;
    this.current = null; // { q, choices, correctIndex, deadline, resolved }
    this.turnTimer = null;
    this.revealTimer = null;
    this.rematchVotes = new Set();
    this.claimableBy = null;
    this.createdAt = Date.now();
    this.finishedAt = null;
  }

  get activePlayer() {
    return this.players[this.turnIndex % 2] || null;
  }

  otherPlayer(player) {
    return this.players.find((p) => p !== player) || null;
  }

  snapshot() {
    return {
      phase: this.phase,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, role: p.role, score: p.score, connected: p.connected,
      })),
      round: Math.min(Math.floor(this.turnIndex / 2) + 1, TOTAL_ROUNDS),
      totalRounds: TOTAL_ROUNDS,
      activePlayerId: this.phase === 'playing' ? this.activePlayer?.id ?? null : null,
      rematchVotes: [...this.rematchVotes],
      claimableBy: this.claimableBy,
    };
  }

  broadcast(msg) {
    for (const p of this.players) send(p.ws, msg);
  }

  broadcastState() {
    this.broadcast({ type: 'state', ...this.snapshot() });
  }

  questionMessage() {
    const { q, choices, deadline } = this.current;
    return {
      type: 'question',
      round: Math.floor(this.turnIndex / 2) + 1,
      turn: this.turnIndex + 1,
      turnPlayerId: this.activePlayer.id,
      question: { text: q.text, choices, category: q.category },
      deadlineTs: deadline,
    };
  }

  // ── joining / reconnect ──
  join(ws, name, playerId) {
    const existing = playerId && this.players.find((p) => p.id === playerId);
    if (existing) return this.reattach(existing, ws, name);

    if (this.players.length >= 2) {
      send(ws, { type: 'error', code: 'room_full', message: 'Room is full.' });
      ws.close(4001, 'room full');
      return;
    }
    if (this.phase !== 'waiting') {
      send(ws, { type: 'error', code: 'in_progress', message: 'This game has already started.' });
      ws.close(4002, 'in progress');
      return;
    }
    const role = this.players.length === 0 ? 'host' : 'guest';
    const clientId = typeof playerId === 'string' && /^[0-9a-f-]{36}$/i.test(playerId) ? playerId : null;
    const player = {
      id: clientId || crypto.randomUUID(),
      name: sanitizeName(name, role === 'host' ? 'Player 1' : 'Player 2'),
      role,
      score: 0,
      connected: true,
      ws,
      stats: {},
      disconnectTimer: null,
    };
    this.players.push(player);
    ws.player = player;
    ws.room = this;
    send(ws, { type: 'joined', playerId: player.id, role, roomCode: this.code, ...this.snapshot() });
    this.broadcastState();
  }

  reattach(player, ws, name) {
    if (player.ws && player.ws !== ws) {
      try { player.ws.player = null; player.ws.close(4000, 'replaced by new connection'); } catch { /* already gone */ }
    }
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    const wasDisconnected = !player.connected;
    player.ws = ws;
    player.connected = true;
    if (name) player.name = sanitizeName(name, player.name);
    if (this.claimableBy && this.claimableBy === this.otherPlayer(player)?.id) this.claimableBy = null;
    ws.player = player;
    ws.room = this;
    send(ws, { type: 'joined', playerId: player.id, role: player.role, roomCode: this.code, ...this.snapshot() });
    if (wasDisconnected) {
      const other = this.otherPlayer(player);
      if (other) send(other.ws, { type: 'opponent_reconnected' });
    }
    this.broadcastState();
    if (this.phase === 'playing' && this.current && !this.current.resolved) {
      send(ws, this.questionMessage());
    }
    if (this.phase === 'finished' && this.gameoverMsg) {
      send(ws, this.gameoverMsg);
    }
  }

  handleDisconnect(player) {
    if (!this.players.includes(player)) return;
    player.connected = false;
    player.ws = null;
    const other = this.otherPlayer(player);
    if (other) send(other.ws, { type: 'opponent_left' });
    if (this.phase === 'playing' && other) {
      player.disconnectTimer = setTimeout(() => {
        player.disconnectTimer = null;
        if (this.phase === 'playing' && !player.connected) {
          this.claimableBy = this.otherPlayer(player)?.id ?? null;
          this.broadcastState();
        }
      }, CLAIM_AFTER_MS);
    }
    this.broadcastState();
  }

  // ── game flow ──
  start(sender) {
    if (this.phase !== 'waiting') return send(sender.ws, { type: 'error', message: 'Game already started.' });
    if (sender.role !== 'host') return send(sender.ws, { type: 'error', message: 'Only the host can start the game.' });
    if (this.players.length < 2) return send(sender.ws, { type: 'error', message: 'Waiting for a second player.' });
    this.phase = 'playing';
    this.queue = pickQuestions();
    this.turnIndex = 0;
    this.broadcastState();
    this.beginTurn();
  }

  beginTurn() {
    const q = this.queue[this.turnIndex];
    const order = shuffle([0, 1, 2, 3]);
    this.current = {
      q,
      choices: order.map((i) => q.choices[i]),
      correctIndex: order.indexOf(q.correct),
      deadline: Date.now() + TURN_MS,
      resolved: false,
    };
    this.broadcastState();
    this.broadcast(this.questionMessage());
    this.turnTimer = setTimeout(() => this.resolveTurn(null), TURN_MS + 150);
  }

  answer(sender, choiceIndex) {
    if (this.phase !== 'playing' || !this.current || this.current.resolved) return;
    if (sender !== this.activePlayer) return;
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) return;
    if (Date.now() > this.current.deadline) return; // late answer: let the timeout stand
    this.resolveTurn(choiceIndex);
  }

  resolveTurn(pickedIndex) {
    if (!this.current || this.current.resolved) return;
    this.current.resolved = true;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;

    const player = this.activePlayer;
    const { q, correctIndex, deadline } = this.current;
    const isCorrect = pickedIndex === correctIndex;
    let scoreDelta = 0;
    if (isCorrect) {
      const secondsRemaining = Math.max(0, (deadline - Date.now()) / 1000);
      scoreDelta = 100 + Math.min(100, Math.floor(secondsRemaining * 5));
      player.score += scoreDelta;
    }
    const stat = player.stats[q.category] || (player.stats[q.category] = { correct: 0, total: 0 });
    stat.total += 1;
    if (isCorrect) stat.correct += 1;

    this.broadcast({
      type: 'reveal',
      correctIndex,
      pickedIndex,
      answeredBy: player.id,
      scoreDelta,
      scores: Object.fromEntries(this.players.map((p) => [p.id, p.score])),
    });

    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      this.turnIndex += 1;
      this.current = null;
      if (this.turnIndex >= TURNS_PER_GAME) this.finishGame(null);
      else this.beginTurn();
    }, REVEAL_MS);
  }

  finishGame(forcedWinnerId) {
    clearTimeout(this.turnTimer);
    clearTimeout(this.revealTimer);
    this.turnTimer = this.revealTimer = null;
    this.current = null;
    this.phase = 'finished';
    this.finishedAt = Date.now();
    this.claimableBy = null;
    this.rematchVotes.clear();

    let winnerId = forcedWinnerId;
    if (!winnerId) {
      const [a, b] = this.players;
      winnerId = !a || !b || a.score === b.score ? null : (a.score > b.score ? a.id : b.id);
    }
    this.gameoverMsg = {
      type: 'gameover',
      winnerId,
      forfeit: Boolean(forcedWinnerId),
      scores: Object.fromEntries(this.players.map((p) => [p.id, p.score])),
      breakdown: Object.fromEntries(this.players.map((p) => [p.id, p.stats])),
    };
    this.broadcast(this.gameoverMsg);
    this.broadcastState();
  }

  claimWin(sender) {
    if (this.phase !== 'playing' || this.claimableBy !== sender.id) return;
    this.finishGame(sender.id);
  }

  rematch(sender) {
    if (this.phase !== 'finished') return;
    this.rematchVotes.add(sender.id);
    if (this.rematchVotes.size >= 2 && this.players.every((p) => p.connected)) {
      for (const p of this.players) { p.score = 0; p.stats = {}; }
      this.rematchVotes.clear();
      this.phase = 'playing';
      this.finishedAt = null;
      this.queue = pickQuestions();
      this.turnIndex = 0;
      this.broadcastState();
      this.beginTurn();
    } else {
      this.broadcastState();
    }
  }

  destroy() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.revealTimer);
    for (const p of this.players) {
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
      if (p.ws) { try { p.ws.close(4003, 'room expired'); } catch { /* ignore */ } }
    }
    rooms.delete(this.code);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Tiny in-memory rate limiter for room creation: 10/min/IP.
const createHits = new Map();
app.post('/api/rooms', (req, res) => {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const hits = (createHits.get(ip) || []).filter((t) => t > now - 60_000);
  if (hits.length >= 10) return res.status(429).json({ error: 'Too many rooms created. Try again in a minute.' });
  hits.push(now);
  createHits.set(ip, hits);

  const code = makeRoomCode();
  if (!code) return res.status(503).json({ error: 'No room codes available. Try again later.' });
  rooms.set(code, new Room(code));
  res.status(201).json({ code });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const code = String(new URL(req.url, 'http://localhost').searchParams.get('room') || '')
    .toUpperCase().slice(0, 8);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') { ws.isAlive = true; return send(ws, { type: 'pong' }); }

    if (msg.type === 'join') {
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', code: 'no_room', message: 'This room doesn’t exist or has expired.' });
        return ws.close(4004, 'no room');
      }
      return room.join(ws, msg.name, msg.playerId);
    }

    const room = ws.room;
    const player = ws.player;
    if (!room || !player) return;
    switch (msg.type) {
      case 'start': return room.start(player);
      case 'answer': return room.answer(player, msg.choiceIndex);
      case 'rematch': return room.rematch(player);
      case 'claim_win': return room.claimWin(player);
      default: return;
    }
  });

  ws.on('close', () => {
    if (ws.room && ws.player && ws.player.ws === ws) ws.room.handleDisconnect(ws.player);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

// ── room sweep ────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const age = now - room.createdAt;
    const expired =
      age > HARD_TTL_MS ||
      (room.phase === 'waiting' && age > WAITING_TTL_MS) ||
      (room.phase === 'finished' && room.finishedAt && now - room.finishedAt > FINISHED_TTL_MS);
    if (expired) room.destroy();
  }
  for (const [ip, hits] of createHits) {
    if (hits.every((t) => t < now - 60_000)) createHits.delete(ip);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Duel Trivia listening on http://localhost:${PORT}`);
});
