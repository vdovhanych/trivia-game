'use strict';

/* Duel Trivia client — renders purely from the latest server snapshot
   plus the current question/reveal message. */

(() => {
  const $ = (sel) => document.querySelector(sel);

  // ── pixel art (inline SVG) ──────────────────────────────────────
  const PX = (cells, palette, size = 8) => {
    let rects = '';
    cells.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[ch]}"/>`;
      });
    });
    return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  };

  const AVATAR_P1 = PX([
    '.aaaaaa.',
    'aaaaaaaa',
    'aa.aa.aa',
    'aaaaaaaa',
    'aa....aa',
    'aaaaaaaa',
    '.aaaaaa.',
    '..a..a..',
  ], { a: '#FFB627' });

  const AVATAR_P2 = PX([
    '.bbbbbb.',
    'bbbbbbbb',
    'bb.bb.bb',
    'bbbbbbbb',
    'bb....bb',
    'bbbbbbbb',
    '.bbbbbb.',
    '..b..b..',
  ], { b: '#4EE1C1' });

  const TROPHY = PX([
    'g.wwwwww.g',
    'ggwwwwwwgg',
    'g.wwwwww.g',
    '..wwwwww..',
    '...wwww...',
    '....ww....',
    '....ww....',
    '...wwww...',
    '..wwwwww..',
    '..........',
  ], { w: '#FFB627', g: '#B87400' }, 10);

  const ICONS = {
    Ukraine: PX([
      'p.......', 'pbbbbbbb', 'pbbbbbbb', 'pbbbbbbb',
      'pyyyyyyy', 'pyyyyyyy', 'pyyyyyyy', 'p.......',
    ], { p: '#A7A5C6', b: '#5B8DEF', y: '#FFD84E' }),
    'Czech Republic': PX([
      '..c..c..', '..cccc..', '..cccc..', 'cccccccc',
      'cccccccc', 'cc.cc.cc', 'cc.cc.cc', 'cccccccc',
    ], { c: 'currentColor' }),
    'Video games': PX([
      '.cccccc.', 'cccccccc', 'c.cccc.c', 'cc.cc.cc',
      'c.cccc.c', 'cccccccc', 'cc....cc', '........',
    ], { c: 'currentColor' }),
    'Movies & TV': PX([
      'cc.cc.cc', 'cccccccc', 'cccccccc', 'c......c',
      'c......c', 'c......c', 'c......c', 'cccccccc',
    ], { c: 'currentColor' }),
    'Fun facts': PX([
      '..cccc..', '.cccccc.', '.cccccc.', '.cccccc.',
      '..cccc..', '...cc...', '...cc...', '...cc...',
    ], { c: 'currentColor' }),
    'Science & space': PX([
      '...cc...', '...cc...', '..cccc..', '..cccc..',
      '.cccccc.', '.cccccc.', 'cc.cc.cc', 'c..cc..c',
    ], { c: 'currentColor' }),
    Music: PX([
      '.....cc.', '.....cc.', '.....cc.', '.....cc.',
      '.....cc.', '.cccccc.', 'ccccccc.', '.ccccc..',
    ], { c: 'currentColor' }),
    'World geography': PX([
      '..cccc..', '.c.cc.c.', 'c..cc..c', 'cccccccc',
      'c..cc..c', 'c..cc..c', '.c.cc.c.', '..cccc..',
    ], { c: 'currentColor' }),
    History: PX([
      'cccccccc', 'cccccccc', '.c.cc.c.', '.c.cc.c.',
      '.c.cc.c.', '.c.cc.c.', 'cccccccc', 'cccccccc',
    ], { c: 'currentColor' }),
    'Food & drink': PX([
      '........', 'cccccc..', 'cccccccc', 'cccccc.c',
      'cccccc.c', 'cccccccc', 'cccccc..', '........',
    ], { c: 'currentColor' }),
  };

  // ── state ───────────────────────────────────────────────────────
  const store = {
    playerId: localStorage.getItem('duel_pid') || crypto.randomUUID(),
    name: localStorage.getItem('duel_name') || '',
  };
  localStorage.setItem('duel_pid', store.playerId);

  let ws = null;
  let roomCode = null;
  let snapshot = null;       // latest `state` message
  let question = null;       // latest `question` message
  let reveal = null;         // latest `reveal` message (cleared on next question)
  let gameover = null;
  let myAnswer = null;       // index I picked this turn
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let timerInterval = null;
  let pingInterval = null;
  const shownScores = {};    // playerId -> score currently displayed (for roll-up)

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ── tiny helpers ────────────────────────────────────────────────
  const me = () => snapshot?.players.find((p) => p.id === store.playerId) || null;
  const opponent = () => snapshot?.players.find((p) => p.id !== store.playerId) || null;
  const isMyTurn = () => snapshot?.activePlayerId === store.playerId;

  function showScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  }

  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function sendMsg(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function roomLink(code) {
    return `${location.origin}${location.pathname}#/room/${code}`;
  }

  // ── connection ──────────────────────────────────────────────────
  function connect(code) {
    roomCode = code.toUpperCase();
    intentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomCode)}`);

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      sendMsg({ type: 'join', name: store.name, playerId: store.playerId });
      clearInterval(pingInterval);
      pingInterval = setInterval(() => sendMsg({ type: 'ping' }), 25000);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', (ev) => {
      clearInterval(pingInterval);
      if (intentionalClose || [4001, 4002, 4004].includes(ev.code)) return;
      if (ev.code === 4000) return showLandingError('This game was opened in another tab or window.');
      if (ev.code === 4003) return showLandingError('This room has expired.');
      if (reconnectAttempts >= 8) {
        showLandingError('Lost connection to the game. Refresh to try again.');
        return;
      }
      const delay = Math.min(8000, 500 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      $('#game-status').textContent = 'Reconnecting…';
      reconnectTimer = setTimeout(() => connect(roomCode), delay);
    });
  }

  function leaveRoom() {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    clearInterval(pingInterval);
    if (ws) try { ws.close(); } catch { /* ignore */ }
    ws = null;
    roomCode = null;
    snapshot = question = reveal = gameover = null;
    myAnswer = null;
  }

  // ── message handling ────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        store.playerId = msg.playerId;
        localStorage.setItem('duel_pid', store.playerId);
        snapshot = msg;
        render();
        break;
      case 'state':
        snapshot = msg;
        if (msg.phase === 'finished' && !gameover) break; // gameover message follows
        render();
        break;
      case 'question':
        question = msg;
        reveal = null;
        gameover = null;
        myAnswer = null;
        render();
        break;
      case 'reveal':
        reveal = msg;
        render();
        break;
      case 'gameover':
        gameover = msg;
        question = null;
        reveal = null;
        render();
        break;
      case 'opponent_left':
        toast('Your opponent disconnected…');
        break;
      case 'opponent_reconnected':
        toast('Your opponent is back!');
        break;
      case 'error':
        handleServerError(msg);
        break;
      default:
        break;
    }
  }

  function handleServerError(msg) {
    if (msg.code === 'no_room') {
      leaveRoom();
      history.replaceState(null, '', location.pathname);
      showLandingError('That room doesn’t exist or has expired.');
    } else if (msg.code === 'room_full' || msg.code === 'in_progress') {
      leaveRoom();
      showLandingError(msg.message);
    } else {
      toast(msg.message || 'Something went wrong.');
    }
  }

  function showLandingError(text) {
    showScreen('screen-landing');
    $('#landing-actions').hidden = false;
    $('#landing-join').hidden = true;
    $('#landing-error').textContent = text;
  }

  // ── rendering ───────────────────────────────────────────────────
  function render() {
    if (!snapshot) return;
    if (snapshot.phase === 'waiting') renderLobby();
    else if (snapshot.phase === 'playing') renderGame();
    else if (snapshot.phase === 'finished' && gameover) renderGameover();
  }

  function playerAvatar(index) {
    return index === 0 ? AVATAR_P1 : AVATAR_P2;
  }

  function renderLobby() {
    showScreen('screen-lobby');
    $('#lobby-code').textContent = roomCode;
    const list = $('#lobby-players');
    list.innerHTML = '';
    snapshot.players.forEach((p, i) => {
      const li = document.createElement('li');
      const av = document.createElement('span');
      av.className = 'avatar';
      av.setAttribute('aria-hidden', 'true');
      av.innerHTML = playerAvatar(i);
      li.appendChild(av);
      li.appendChild(document.createTextNode(
        `${p.name}${p.id === store.playerId ? ' (you)' : ''}${p.connected ? '' : ' — offline'}`,
      ));
      list.appendChild(li);
    });
    if (snapshot.players.length < 2) {
      const li = document.createElement('li');
      li.className = 'slot-empty';
      li.textContent = 'Waiting for player 2…';
      list.appendChild(li);
    }

    const iAmHost = me()?.role === 'host';
    const ready = snapshot.players.length === 2;
    $('#btn-start').hidden = !iAmHost;
    $('#btn-start').disabled = !ready;
    const status = $('#lobby-status');
    if (!ready) {
      status.innerHTML = 'waiting for player 2<span class="cursor">▌</span>';
    } else if (iAmHost) {
      status.textContent = 'Both players are in — hit Start!';
    } else {
      status.textContent = 'Waiting for the host to start the game…';
    }
    $('#btn-share').hidden = !navigator.share;
  }

  function renderScoreboard() {
    snapshot.players.forEach((p, i) => {
      const el = $(i === 0 ? '#sb-p1' : '#sb-p2');
      el.querySelector('.avatar').innerHTML = playerAvatar(i);
      el.querySelector('.sb-name').innerHTML = '';
      el.querySelector('.sb-name').append(
        `${p.name}${p.id === store.playerId ? ' (you)' : ''}`,
      );
      if (!p.connected) {
        const off = document.createElement('span');
        off.className = 'off';
        off.textContent = ' offline';
        el.querySelector('.sb-name').appendChild(off);
      }
      el.classList.toggle('active', snapshot.activePlayerId === p.id);
      animateScore(el.querySelector('.sb-score'), p.id, p.score);
    });
  }

  function animateScore(el, playerId, target) {
    const from = shownScores[playerId] ?? 0;
    shownScores[playerId] = target;
    if (from === target || reducedMotion.matches) {
      el.textContent = String(target);
      return;
    }
    const start = performance.now();
    const dur = 600;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(from + (target - from) * t));
      if (t < 1 && shownScores[playerId] === target) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderGame() {
    showScreen('screen-game');
    renderScoreboard();
    $('#btn-claim').hidden = snapshot.claimableBy !== store.playerId;
    $('#round-counter').textContent = `ROUND ${snapshot.round}/${snapshot.totalRounds}`;

    const banner = $('#turn-banner');
    if (isMyTurn()) {
      banner.textContent = 'YOUR TURN';
      banner.classList.remove('theirs');
    } else {
      banner.textContent = `${opponent()?.name ?? 'OPPONENT'}’S TURN`;
      banner.classList.add('theirs');
    }

    if (!question) return;

    // category chip
    const chip = $('#category-chip');
    chip.querySelector('.cat-icon').innerHTML = ICONS[question.question.category] || '';
    chip.querySelector('.cat-name').textContent = question.question.category;

    $('#question-text').textContent = question.question.text;

    renderAnswers();
    renderTimer();
    renderRevealBits();

    const status = $('#game-status');
    if (reveal) status.textContent = '';
    else if (isMyTurn()) status.textContent = 'Pick an answer before the timer runs out!';
    else status.textContent = `Spectating — ${opponent()?.name ?? 'your opponent'} is answering.`;
  }

  function renderAnswers() {
    const wrap = $('#answers');
    const spectating = !isMyTurn();
    wrap.classList.toggle('spectating', spectating);

    // Rebuild buttons only when the question changes.
    if (wrap.dataset.turn !== String(question.turn)) {
      wrap.dataset.turn = String(question.turn);
      wrap.innerHTML = '';
      question.question.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'answer';
        btn.dataset.index = String(i);
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = String.fromCharCode(65 + i);
        key.setAttribute('aria-hidden', 'true');
        btn.appendChild(key);
        btn.appendChild(document.createTextNode(choice));
        btn.addEventListener('click', () => pickAnswer(i));
        wrap.appendChild(btn);
      });
    }

    const buttons = [...wrap.querySelectorAll('.answer')];
    buttons.forEach((btn, i) => {
      btn.disabled = spectating || myAnswer !== null || Boolean(reveal);
      btn.classList.toggle('picked', !reveal && myAnswer === i);
      if (reveal) {
        const correct = i === reveal.correctIndex;
        const picked = i === reveal.pickedIndex;
        btn.classList.toggle('correct', correct);
        btn.classList.toggle('wrong', picked && !correct);
        btn.classList.toggle('dim', !correct && !picked);
      } else {
        btn.classList.remove('correct', 'wrong', 'dim');
      }
    });
  }

  function pickAnswer(i) {
    if (!isMyTurn() || myAnswer !== null || reveal) return;
    myAnswer = i;
    sendMsg({ type: 'answer', choiceIndex: i });
    renderAnswers();
  }

  function renderRevealBits() {
    const banner = $('#reveal-banner');
    if (!reveal) {
      banner.hidden = true;
      banner.className = 'reveal-banner';
      return;
    }
    banner.hidden = false;
    const mine = reveal.answeredBy === store.playerId;
    const correct = reveal.pickedIndex === reveal.correctIndex;
    const who = mine ? 'You' : (opponent()?.name ?? 'Opponent');
    if (reveal.pickedIndex === null) {
      banner.textContent = `⏰ Time’s up! ${who} scored 0.`;
      banner.className = 'reveal-banner bad';
    } else if (correct) {
      banner.textContent = `✔ Correct! ${who} scored +${reveal.scoreDelta}.`;
      banner.className = 'reveal-banner good';
    } else {
      banner.textContent = `✘ Wrong answer — ${who} scored 0.`;
      banner.className = 'reveal-banner bad';
    }

    // fire effects once per reveal
    if (!banner.dataset.done || banner.dataset.done !== `${question?.turn}`) {
      banner.dataset.done = `${question?.turn}`;
      if (mine && !reducedMotion.matches) {
        if (correct) confettiBurst();
        else if (reveal.pickedIndex !== null) {
          $('#game-card').classList.add('shake');
          setTimeout(() => $('#game-card').classList.remove('shake'), 200);
        }
      }
    }
  }

  function confettiBurst() {
    const layer = $('#confetti-layer');
    const card = $('#game-card').getBoundingClientRect();
    const cx = card.left + card.width / 2;
    const cy = card.top + card.height / 2;
    const colors = ['#FFB627', '#4EE1C1', '#F2F0FF', '#FF5D73'];
    for (let i = 0; i < 26; i++) {
      const el = document.createElement('span');
      el.className = 'confetti';
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.background = colors[i % colors.length];
      el.style.setProperty('--dx', `${(Math.random() - 0.5) * 360}px`);
      el.style.setProperty('--dy', `${-80 - Math.random() * 220}px`);
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }
  }

  // ── timer ───────────────────────────────────────────────────────
  function renderTimer() {
    const blocksWrap = $('.timer-blocks');
    if (blocksWrap.children.length !== 20) {
      blocksWrap.innerHTML = '';
      for (let i = 0; i < 20; i++) blocksWrap.appendChild(document.createElement('i'));
    }
    clearInterval(timerInterval);
    const update = () => {
      const remaining = reveal ? 0 : Math.max(0, (question?.deadlineTs ?? 0) - Date.now());
      const secs = Math.ceil(remaining / 1000);
      const lit = Math.min(20, secs);
      [...blocksWrap.children].forEach((b, i) => b.classList.toggle('off', i >= lit));
      $('#timer-seconds').textContent = `${secs}s`;
      $('#timer').classList.toggle('danger', !reveal && secs > 0 && secs <= 5);
      if (remaining <= 0) clearInterval(timerInterval);
    };
    update();
    if (!reveal) timerInterval = setInterval(update, 250);
  }

  // ── game over ───────────────────────────────────────────────────
  function renderGameover() {
    showScreen('screen-over');
    clearInterval(timerInterval);

    const meP = me();
    const win = gameover.winnerId;
    const title = $('#over-title');
    if (!win) title.textContent = 'DRAW!';
    else if (win === store.playerId) title.textContent = gameover.forfeit ? 'YOU WIN BY FORFEIT!' : 'YOU WIN!';
    else title.textContent = 'YOU LOSE…';
    $('#trophy-art').innerHTML = TROPHY;

    const scoresWrap = $('#final-scores');
    scoresWrap.innerHTML = '';
    snapshot.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = `final-row ${i === 0 ? 'p1' : 'p2'}`;
      const name = document.createElement('span');
      name.textContent = `${p.name}${p.id === store.playerId ? ' (you)' : ''}`;
      if (p.id === win) {
        const crown = document.createElement('span');
        crown.className = 'crown';
        crown.textContent = '🏆';
        name.appendChild(crown);
      }
      const score = document.createElement('span');
      score.className = 'pixel';
      score.textContent = String(gameover.scores[p.id] ?? 0);
      row.append(name, score);
      scoresWrap.appendChild(row);
    });

    // category breakdown
    const [a, b] = snapshot.players;
    $('#bd-p1').textContent = a?.name ?? '';
    $('#bd-p2').textContent = b?.name ?? '';
    const tbody = $('#breakdown tbody');
    tbody.innerHTML = '';
    const cats = new Set();
    Object.values(gameover.breakdown).forEach((stats) => Object.keys(stats).forEach((c) => cats.add(c)));
    for (const cat of cats) {
      const tr = document.createElement('tr');
      const cell = (p) => {
        const s = p && gameover.breakdown[p.id]?.[cat];
        return s ? `${s.correct}/${s.total}` : '—';
      };
      const th = document.createElement('td');
      th.textContent = cat;
      const td1 = document.createElement('td');
      td1.textContent = cell(a);
      const td2 = document.createElement('td');
      td2.textContent = cell(b);
      tr.append(th, td1, td2);
      tbody.appendChild(tr);
    }

    // rematch status
    const votes = snapshot.rematchVotes || [];
    const iVoted = votes.includes(store.playerId);
    const opp = opponent();
    const btn = $('#btn-rematch');
    const status = $('#rematch-status');
    if (opp && !opp.connected) {
      btn.disabled = true;
      status.textContent = 'Your opponent left the room.';
    } else {
      btn.disabled = iVoted;
      btn.textContent = iVoted ? 'Waiting for opponent…' : 'Rematch';
      status.textContent = `${votes.length}/2 ready${votes.length === 1 && !iVoted ? ' — opponent wants a rematch!' : ''}`;
    }
  }

  // ── routing & landing ───────────────────────────────────────────
  function parseHash() {
    const m = location.hash.match(/^#\/room\/([A-Za-z0-9]{4})$/);
    return m ? m[1].toUpperCase() : null;
  }

  function initLanding() {
    showScreen('screen-landing');
    $('#name-input').value = store.name;
    const code = parseHash();
    $('#landing-error').textContent = '';
    if (code) {
      $('#landing-actions').hidden = true;
      $('#landing-join').hidden = false;
      $('#join-code-label').textContent = code;
    } else {
      $('#landing-actions').hidden = false;
      $('#landing-join').hidden = true;
    }
  }

  function saveName() {
    store.name = $('#name-input').value.trim().slice(0, 20);
    localStorage.setItem('duel_name', store.name);
  }

  async function createRoom() {
    saveName();
    const btn = $('#btn-create');
    btn.disabled = true;
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not create a room. Try again.');
      }
      const { code } = await res.json();
      location.hash = `#/room/${code}`;
      connect(code);
    } catch (err) {
      $('#landing-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function joinFromInput() {
    saveName();
    const code = $('#code-input').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      $('#landing-error').textContent = 'Enter the 4-character room code.';
      return;
    }
    location.hash = `#/room/${code}`;
    connect(code);
  }

  // ── event wiring ────────────────────────────────────────────────
  $('#btn-create').addEventListener('click', createRoom);
  $('#btn-have-code').addEventListener('click', () => {
    const entry = $('#code-entry');
    entry.hidden = !entry.hidden;
    $('#btn-have-code').setAttribute('aria-expanded', String(!entry.hidden));
    if (!entry.hidden) $('#code-input').focus();
  });
  $('#btn-join-code').addEventListener('click', joinFromInput);
  $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });
  $('#btn-join').addEventListener('click', () => {
    saveName();
    const code = parseHash();
    if (code) connect(code);
  });
  $('#btn-join-cancel').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    initLanding();
  });

  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomLink(roomCode));
      toast('Link copied — send it to your rival!');
    } catch {
      toast(`Copy this link: ${roomLink(roomCode)}`, 6000);
    }
  });
  $('#btn-share').addEventListener('click', () => {
    navigator.share({ title: 'Duel Trivia', text: 'Face me in a trivia duel!', url: roomLink(roomCode) })
      .catch(() => { /* user cancelled */ });
  });

  $('#btn-start').addEventListener('click', () => sendMsg({ type: 'start' }));
  $('#btn-claim').addEventListener('click', () => sendMsg({ type: 'claim_win' }));
  $('#btn-rematch').addEventListener('click', () => sendMsg({ type: 'rematch' }));
  $('#btn-new-game').addEventListener('click', () => {
    leaveRoom();
    history.replaceState(null, '', location.pathname);
    initLanding();
  });

  window.addEventListener('hashchange', () => {
    const code = parseHash();
    if (!code && roomCode) { leaveRoom(); initLanding(); }
    else if (code && code !== roomCode) { leaveRoom(); initLanding(); }
  });

  // keyboard shortcuts A–D / 1–4 on your turn
  window.addEventListener('keydown', (e) => {
    if (!snapshot || snapshot.phase !== 'playing' || !isMyTurn() || reveal) return;
    if (e.target instanceof HTMLInputElement) return;
    let idx = -1;
    if (/^[a-d]$/i.test(e.key)) idx = e.key.toLowerCase().charCodeAt(0) - 97;
    if (/^[1-4]$/.test(e.key)) idx = Number(e.key) - 1;
    if (idx >= 0) pickAnswer(idx);
  });

  // ── boot ────────────────────────────────────────────────────────
  const bootCode = parseHash();
  if (bootCode && store.name) {
    // Returning player (e.g. reopened tab): rejoin straight away.
    connect(bootCode);
    initLanding();
  } else {
    initLanding();
  }
})();
