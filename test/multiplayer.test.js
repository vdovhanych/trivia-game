'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const questions = require('../questions');

let server;
let base;
const clients = new Set();
const sessions = new Map();
let logs = '';
beforeEach(async () => {
  clients.clear();
  sessions.clear();
  logs = '';
  server = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', OPENTDB: 'off', REVEAL_MS: '100', TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (data) => { logs += String(data); });
  server.stderr.on('data', (data) => { logs += String(data); });
  base = await new Promise((resolve, reject) => {
    const finish = (error, url) => {
      clearTimeout(timer);
      server.off('error', onError);
      server.off('exit', onExit);
      server.stdout.off('data', onData);
      if (error) reject(error); else resolve(url);
    };
    const onError = () => finish(new Error('Test server could not start'));
    const onExit = () => finish(new Error('Test server exited before listening'));
    const onData = () => {
      const match = logs.match(/http:\/\/localhost:\d+/);
      if (match) finish(null, match[0]);
    };
    const timer = setTimeout(() => finish(new Error('Server startup timeout')), 5000);
    server.once('error', onError);
    server.once('exit', onExit);
    server.stdout.on('data', onData);
  });
});
afterEach(async () => {
  for (const client of clients) client.close();
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    const forceKill = setTimeout(() => server.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(forceKill); }
  }
});

async function room(mode = 'duel') {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).code;
}
async function connect(code, id = randomUUID(), options = {}) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${code}`);
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    client.received.push(message);
    if (message.type === 'question') client.question = message;
    if (message.type === 'joined') { client.id = message.playerId; sessions.set(client.id, message.reconnectToken); }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) messages.push(message);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const client = {
    id, socket, received: [],
    closed: new Promise((resolve) => socket.once('close', (...args) => resolve(args))),
    send(message) {
      if (['answer', 'lifeline'].includes(message.type)) {
        message = { matchId: client.question?.matchId, turn: client.question?.turn, ...message };
      }
      socket.send(JSON.stringify(message));
    },
    next(type, predicate = () => true, timeout = 3000) {
      const matches = (message) => message.type === type && predicate(message);
      const index = messages.findIndex(matches);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate: matches, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Test client closed'));
      }
      socket.terminate();
      clients.delete(client);
    },
  };
  clients.add(client);
  socket.on('error', () => { /* Handshake errors are handled by once(open). */ });
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  client.send({ type: 'join', playerId: id, reconnectToken: options.token ?? sessions.get(id), name: options.name ?? 'Test Player' });
  return client;
}
function correctIndex(message) {
  const source = questions.find((q) => q.text === message.question.text);
  assert.ok(source);
  return message.question.choices.indexOf(source.choices[source.correct]);
}

test('two-player match: both reconnect, replacement closes old sockets, duplicates and rematch replay stay inert, tokens stay private', { timeout: 20000 }, async () => {
  const code = await room();
  let a = await connect(code);
  let b = await connect(code);
  const ja = await a.next('joined'); const jb = await b.next('joined');
  assert.notEqual(ja.playerId, jb.playerId);
  assert.ok(ja.reconnectToken !== jb.reconnectToken, 'Each seat needs its own credential');
  const all = [a,b];
  a.send({type:'start'});
  let matchId;
  for(let turn=1;turn<=20;turn++) {
    const q = await a.next('question', q=>q.turn===turn);
    await b.next('question', q=>q.turn===turn);
    matchId = q.matchId;
    if(turn===1 || turn===2) {
      const old = turn===1 ? a : b;
      const replacement = await connect(code,old.id);
      const joined=await replacement.next('joined');
      const restored=await replacement.next('question');
      assert.equal(joined.playerId,old.id);
      assert.equal(restored.turn,turn);
      assert.equal(restored.deadlineTs,q.deadlineTs);
      assert.equal((await old.closed)[0],4000);
      // A closed obsolete transport cannot submit a command.
      const sendError=await new Promise(resolve=>old.socket.send(JSON.stringify({type:'answer',choiceIndex:0,matchId,turn}),resolve));
      assert.ok(sendError);
      all.push(replacement);
      if(turn===1)a=replacement;else b=replacement;
    }
    const active=turn%2?a:b;
    active.send({type:'answer',choiceIndex:correctIndex(q),matchId,turn});
    active.send({type:'answer',choiceIndex:(correctIndex(q)+1)%4,matchId,turn});
    const r=await a.next('reveal',r=>r.answeredBy===active.id);
    assert.equal(r.pickedIndex,correctIndex(q));
  }
  const over=await a.next('gameover');
  assert.equal(over.history.length,20);
  assert.ok(over.history.every(h=>h.correct));
  assert.equal(new Set(over.history.map(h=>h.turn)).size,20);
  // Reconnect after game end receives the same final history.
  const oldGuest=b;
  b=await connect(code,b.id);all.push(b);
  await b.next('joined');
  assert.deepEqual(await b.next('gameover'),over);
  assert.equal((await oldGuest.closed)[0],4000);
  a.send({type:'answer',choiceIndex:0,matchId,turn:20});
  a.send({type:'rematch'});b.send({type:'rematch'});
  const fresh=await a.next('question',q=>q.matchId!==matchId);
  await b.next('question',q=>q.matchId===fresh.matchId);
  assert.equal(fresh.turn,1);
  a.send({type:'answer',choiceIndex:0,matchId,turn:1});
  a.send({type:'lifeline',matchId,turn:1});
  a.send({type:'lifeline',matchId:fresh.matchId,turn:1});
  await a.next('lifeline');
  a.send({type:'answer',choiceIndex:correctIndex(fresh),matchId:fresh.matchId,turn:1});
  const result=await a.next('reveal',r=>r.answeredBy===a.id);
  assert.equal(result.streak,1);
  for(const c of all) {
    for(const m of c.received) {
      const publicMessage={...m};delete publicMessage.reconnectToken;
      for(const token of [ja.reconnectToken,jb.reconnectToken]) assert.equal(JSON.stringify(publicMessage).includes(token),false);
      if (m.reconnectToken) {
        assert.equal(m.type, 'joined');
        assert.ok(m.reconnectToken === (c.id === ja.playerId ? ja.reconnectToken : jb.reconnectToken), 'Only the owning seat receives its credential');
      }
    }
  }
  assert.equal(logs.includes(ja.reconnectToken),false);assert.equal(logs.includes(jb.reconnectToken),false);
  for(const c of all)c.close();
});
test('both players recover from a terminated transport, including the guest on their active turn', { timeout: 10000 }, async () => {
  const code=await room();
  let a=await connect(code);let b=await connect(code);
  await a.next('joined');await b.next('joined');
  const aid=a.id,bid=b.id;
  a.close();
  await b.next('state',s=>s.players.find(p=>p.id===aid)?.connected===false);
  a=await connect(code,aid);assert.equal((await a.next('joined')).role,'host');
  a.send({type:'start'});
  const q=await a.next('question');
  a.send({type:'answer',choiceIndex:correctIndex(q)});
  const guestQ=await b.next('question',q=>q.turn===2);
  b.close();
  await a.next('state',s=>s.players.find(p=>p.id===bid)?.connected===false);
  b=await connect(code,bid);
  assert.equal((await b.next('joined')).role,'guest');
  const restored=await b.next('question');
  assert.equal(restored.deadlineTs,guestQ.deadlineTs);
  assert.deepEqual(restored.question,guestQ.question);
  b.send({type:'answer',choiceIndex:correctIndex(restored)});
  assert.equal((await b.next('reveal')).answeredBy,bid);
  a.close();b.close();
});
