'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const questions = require('../questions');

let server;
let base;
const clients = new Set();
before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', OPENTDB: 'off', REVEAL_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.once('error', reject);
    server.stderr.on('data', (data) => reject(new Error(String(data))));
    server.stdout.on('data', (data) => {
      const match = String(data).match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
});
after(async () => {
  for (const client of clients) client.close();
  server.kill();
  await once(server, 'exit');
});

async function room(mode = 'duel') {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).code;
}
async function connect(code, id = randomUUID()) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${code}`);
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) messages.push(message);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const client = {
    id,
    send(message) { socket.send(JSON.stringify(message)); },
    next(type, predicate = () => true, timeout = 3000) {
      const matches = (message) => message.type === type && predicate(message);
      const index = messages.findIndex(matches);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate: matches, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    close() { socket.terminate(); clients.delete(client); },
  };
  clients.add(client);
  await once(socket, 'open');
  client.send({ type: 'join', playerId: id, name: 'Test Player' });
  return client;
}
function correctIndex(message) {
  const source = questions.find((q) => q.text === message.question.text);
  assert.ok(source);
  return message.question.choices.indexOf(source.choices[source.correct]);
}

test('full duel: authority, lifelines, streaks, answer review, and fresh rematches', async () => {
  const code = await room();
  const a = await connect(code);
  const b = await connect(code);
  await a.next('joined'); await b.next('joined');
  b.send({ type: 'start' });
  assert.match((await b.next('error')).message, /host/);
  a.send({ type: 'start' });
  let firstMatch;
  const served = new Set();
  for (let turn = 1; turn <= 20; turn++) {
    const q = await a.next('question', (m) => m.turn === turn);
    firstMatch ||= q.matchId;
    assert.equal(q.question.correctIndex, undefined);
    assert.equal(q.correctIndex, undefined);
    assert.equal(q.history, undefined);
    assert.equal(served.has(q.question.text), false);
    served.add(q.question.text);
    const active = turn % 2 ? a : b;
    const spectator = turn % 2 ? b : a;
    const correct = correctIndex(q);
    if (turn === 1) {
      spectator.send({ type: 'lifeline' });
      spectator.send({ type: 'answer', choiceIndex: correct });
      active.send({ type: 'answer', choiceIndex: 9 });
      active.send({ type: 'lifeline' });
      const lifeline = await a.next('lifeline');
      assert.equal(lifeline.eliminated.length, 2);
      assert.equal(new Set(lifeline.eliminated).size, 2);
      assert.equal(lifeline.eliminated.includes(correct), false);
      active.send({ type: 'answer', choiceIndex: lifeline.eliminated[0] });
      active.send({ type: 'lifeline' });
      const state = await a.next('state', (m) => m.players[0]?.lifelineUsed);
      assert.equal(state.players[1].lifelineUsed, false);
    }
    // Break the host's streak on their third answer, then rebuild it.
    const wrong = turn === 5;
    active.send({ type: 'answer', choiceIndex: wrong ? (correct + 1) % 4 : correct });
    const reveal = await a.next('reveal');
    assert.equal(reveal.answeredBy, active.id);
    assert.equal(reveal.correctIndex, correct);
    assert.equal(reveal.pickedIndex, wrong ? (correct + 1) % 4 : correct);
    if (turn === 1) assert.equal(reveal.streakBonus, 0);
    if (turn === 3) assert.equal(reveal.streakBonus, 25);
    if (turn === 5) { assert.equal(reveal.streak, 0); assert.equal(reveal.scoreDelta, 0); }
    if (turn === 7) assert.equal(reveal.streakBonus, 0);
    assert.ok(reveal.streakBonus <= 75);
    const updated = await a.next('state', (m) => m.phase === 'playing' && m.players.some((p) => p.id === active.id && p.score === reveal.scores[active.id]));
    assert.ok(updated);
  }
  const over = await a.next('gameover');
  assert.equal(over.history.length, 20);
  assert.equal(over.history.filter((q) => q.playerId === a.id && q.correct).length, 9);
  assert.equal(over.history[0].lifeline, true);
  assert.equal(over.history[4].scoreDelta, 0);
  assert.equal(Object.values(over.breakdown[a.id]).reduce((sum, stat) => sum + stat.total, 0), 10);
  a.send({ type: 'rematch' }); b.send({ type: 'rematch' });
  const rematch = await a.next('question', (q) => q.matchId !== firstMatch);
  assert.equal(rematch.turn, 1);
  assert.equal(served.has(rematch.question.text), false);
  const reset = await a.next('state', (state) => state.matchId === rematch.matchId);
  assert.ok(reset.players.every((p) => p.score === 0 && p.streak === 0 && !p.lifelineUsed));
  a.close(); b.close();
});

test('reconnect restores used lifeline and answer reveal', async () => {
  const code = await room();
  let a = await connect(code);
  const id = a.id;
  const b = await connect(code);
  await b.next('joined');
  a.send({ type: 'start' });
  const q = await a.next('question');
  a.send({ type: 'lifeline' });
  const lifeline = await a.next('lifeline');
  a.close();
  a = await connect(code, id);
  const restored = await a.next('question');
  assert.deepEqual(restored.eliminated, lifeline.eliminated);
  assert.equal((await a.next('joined')).players[0].lifelineUsed, true);
  a.send({ type: 'answer', choiceIndex: correctIndex(q) });
  const reveal = await a.next('reveal');
  a.close();
  a = await connect(code, id);
  assert.equal((await a.next('question')).turn, 1);
  assert.deepEqual(await a.next('reveal'), reveal);
  a.close(); b.close();
});

test('practice starts immediately, bot answers, and its seat cannot be claimed', async () => {
  const code = await room('practice');
  const human = await connect(code);
  const q = await human.next('question');
  const state = await human.next('state', (m) => m.phase === 'playing');
  const bot = state.players.find((p) => p.bot);
  assert.equal(bot.name, 'Byte Bot');
  const intruder = await connect(code, bot.id);
  assert.equal((await intruder.next('error')).code, 'room_full');
  intruder.close();
  human.send({ type: 'answer', choiceIndex: correctIndex(q) });
  await human.next('reveal');
  const botQuestion = await human.next('question', (m) => m.turn === 2);
  assert.equal(botQuestion.turnPlayerId, bot.id);
  const botReveal = await human.next('reveal', (m) => m.answeredBy === bot.id, 8000);
  assert.notEqual(botReveal.pickedIndex, null);
  for (let turn = 3; turn <= 19; turn += 2) {
    const next = await human.next('question', (m) => m.turn === turn);
    human.send({ type: 'answer', choiceIndex: correctIndex(next) });
    await human.next('reveal', (m) => m.answeredBy === human.id);
    await human.next('reveal', (m) => m.answeredBy === bot.id, 8000);
  }
  const over = await human.next('gameover');
  assert.equal(over.history.length, 20);
  human.send({ type: 'rematch' });
  const replay = await human.next('question', (m) => m.matchId !== q.matchId);
  assert.equal(replay.turn, 1);
  const reset = await human.next('state', (m) => m.matchId === replay.matchId);
  assert.ok(reset.players.every((p) => p.score === 0 && p.bestStreak === 0 && !p.lifelineUsed));
  human.close();
});

test('a timeout scores zero and advances to the next player', async () => {
  const code = await room();
  const a = await connect(code);
  const b = await connect(code);
  await b.next('joined');
  a.send({ type: 'start' });
  await a.next('question');
  const reveal = await a.next('reveal', () => true, 23000);
  assert.equal(reveal.pickedIndex, null);
  assert.equal(reveal.scoreDelta, 0);
  assert.equal(reveal.streak, 0);
  assert.equal((await a.next('question', (m) => m.turn === 2)).turnPlayerId, b.id);
  a.close(); b.close();
});

test('invalid modes fail cleanly and health endpoint remains available', async () => {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'invalid' }),
  });
  assert.equal(response.status, 400);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
});

test('oversized WebSocket messages do not crash the server', async () => {
  const code = await room();
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${code}`);
  await once(socket, 'open');
  socket.send('x'.repeat(5000));
  const [codeReceived] = await once(socket, 'close');
  assert.equal(codeReceived, 1009);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
});
