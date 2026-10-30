'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

async function start(t, trustProxy = '') {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', OPENTDB: 'off', TRUST_PROXY: trustProxy },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    server.once('error', reject);
    server.stdout.on('data', (data) => {
      const url = String(data).match(/http:\/\/localhost:\d+/);
      if (url) { clearTimeout(timer); resolve(url[0]); }
    });
  });
}

test('spoofed forwarding headers cannot bypass room creation limit by default', async (t) => {
  const base = await start(t);
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` },
    });
    assert.equal(res.status, i < 10 ? 201 : 429);
  }
});

test('explicitly trusted proxy addresses allow separate client quotas', async (t) => {
  const base = await start(t, 'loopback');
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` },
    });
    assert.equal(res.status, 201);
  }
});

test('a message flood closes only the offending socket', async (t) => {
  const base = await start(t);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const closed = once(ws, 'close');
  for (let i = 0; i < 35; i++) ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await closed)[0], 1008);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
});

test('idle unjoined sockets expire', async (t) => {
  const base = await start(t);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  assert.equal((await once(ws, 'close'))[0], 4006);
});
