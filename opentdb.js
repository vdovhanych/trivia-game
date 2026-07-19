'use strict';

// Optional Open Trivia Database (https://opentdb.com) integration.
//
// Fetches multiple-choice questions in the background and exposes them in
// the same shape as questions.js, mapped onto our existing categories. The
// game never depends on the API: if fetching fails the local bank simply
// carries the game, and failures back off exponentially.
//
// Questions are requested base64-encoded so no HTML-entity decoding is
// needed. OpenTDB content is licensed CC BY-SA 4.0 (attribution in README).
//
// Env:
//   OPENTDB=off       disable the integration entirely
//   OPENTDB_URL=...   override the API base URL (used by tests)

const crypto = require('crypto');

const BASE_URL = process.env.OPENTDB_URL || 'https://opentdb.com';

// OpenTDB category id -> our category name
const CATEGORY_MAP = {
  9: 'Fun facts',        // General Knowledge
  11: 'Movies & TV',     // Film
  12: 'Music',
  14: 'Movies & TV',     // Television
  15: 'Video games',
  17: 'Science & space', // Science & Nature
  22: 'World geography',
  23: 'History',
};
const FETCH_CATEGORIES = Object.keys(CATEGORY_MAP).map(Number);

const POOL_CAP = 600;              // max API questions kept in memory
const BATCH_SIZE = 25;
const FETCH_INTERVAL_MS = 30_000;  // well under the API's 1 req / 5 s limit
const MAX_BACKOFF_MS = 10 * 60_000;

const pool = new Map(); // id -> question
let token = null;
let catIndex = 0;
let failures = 0;
let backoffUntil = 0;
const enabled = process.env.OPENTDB !== 'off';

const b64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`opentdb http ${res.status}`);
  return res.json();
}

function addResult(raw, category) {
  const text = b64(raw.question).trim();
  const correct = b64(raw.correct_answer).trim();
  const wrong = (raw.incorrect_answers || []).map((a) => b64(a).trim());
  if (!text || !correct || wrong.length !== 3 || wrong.some((w) => !w)) return;
  const choices = [correct, ...wrong];
  if (new Set(choices.map((c) => c.toLowerCase())).size !== 4) return;
  if (text.length > 300 || choices.some((c) => c.length > 120)) return;
  const difficulty = b64(raw.difficulty);
  if (!['easy', 'medium', 'hard'].includes(difficulty)) return;
  const id = `otdb-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
  if (pool.has(id)) return;
  pool.set(id, { id, category, difficulty, text, choices, correct: 0 });
}

async function refill() {
  if (pool.size >= POOL_CAP || Date.now() < backoffUntil) return;
  try {
    if (!token) token = (await api('/api_token.php?command=request')).token;
    const cat = FETCH_CATEGORIES[catIndex++ % FETCH_CATEGORIES.length];
    const data = await api(
      `/api.php?amount=${BATCH_SIZE}&category=${cat}&type=multiple&encode=base64&token=${token}`,
    );
    if (data.response_code === 3 || data.response_code === 4) {
      token = null; // expired or exhausted: re-request next cycle
      return;
    }
    if (data.response_code !== 0) return;
    for (const raw of data.results || []) addResult(raw, CATEGORY_MAP[cat]);
    failures = 0;
    backoffUntil = 0;
  } catch (err) {
    failures += 1;
    backoffUntil = Date.now() + Math.min(MAX_BACKOFF_MS, FETCH_INTERVAL_MS * 2 ** failures);
    if (failures === 1) {
      console.log(`opentdb: fetch failed (${err.message}); playing from the local bank, will retry`);
    }
  }
}

function start() {
  if (!enabled) return;
  refill();
  setInterval(refill, FETCH_INTERVAL_MS).unref();
}

module.exports = {
  start,
  extras: () => [...pool.values()],
  poolSize: () => pool.size,
  isEnabled: () => enabled,
};
