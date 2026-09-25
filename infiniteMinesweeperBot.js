// Infinite Minesweeper helper: send actions and keep a live copy of the board.
// Paste into the DevTools console on infiniteminesweeper.com, then scroll or
// click once so the hook can grab the game's WebSocket. Then run loadAround().

const CHUNK = 64;            // chunks are 64x64; index = row * 64 + col
const chunks = new Map();    // "cx,cy" -> Uint8Array(4096) of raw cell bytes
let gameSocket = null;
let view = null;             // last position the game reported (chunk + cell)
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Timing knobs (ms). passWait: longest wait for the server to confirm a pass's
// actions before the next pass (it moves on as soon as everything is confirmed).
// loadWait: wait for chunk snapshots after subscribing.
const solverSettings = { passWait: 1000, loadWait: 500 };
let holdChain = Promise.resolve(), holdBusy = 0;   // held outgoing messages (click mode)
let pendingClick = null, guardUntil = 0, epoch = 0; // click-mode state
const gameSubs = new Set(), scriptChunks = new Set(); // who asked for which chunks

// --- socket hook ------------------------------------------------------------
// Counters for boardStatus(): shows whether frames are actually being processed
const stats = { sent: 0, received: 0, snapshots: 0, patches: 0, patchesForUnloadedChunks: 0,
                detached: 0, errors: 0, lastError: null, score: null, lastPoints: null,
                clicksExact: 0, clicksCorrected: 0, clickTimeouts: 0, clickFallbacks: 0, gameActionsBlocked: 0 };
const seenEvents = new WeakSet();

const _origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  if (this.url.includes('infiniteminesweeper.com/ws') && gameSocket !== this) {
    gameSocket = this;
    // Backup reader: touching ev.data triggers the capture hook below
    this.addEventListener('message', (ev) => ev.data, { capture: true });
    console.log('[board] socket captured; run loadAround() to fetch your area');
  }
  if (this !== gameSocket) return _origSend.call(this, data);
  stats.sent++;
  const ours = scriptSent.has(data);
  // Around a simulated click, hold the game's messages so its action can be
  // checked (and corrected if needed) before it reaches the server
  if (holdBusy || (!ours && (pendingClick || Date.now() < guardUntil))) {
    const copy = snapshot(data), ws = this;
    holdBusy++;
    holdChain = holdChain
      .then(() => (ours ? forward(ws, copy, 'script') : processHeld(ws, copy)))
      .catch((e) => console.warn('[click] held message error:', e))
      .finally(() => holdBusy--);
    return;
  }
  enqueue(data, handleOutgoing, ours ? 'script' : 'manual');
  return _origSend.call(this, data);
};

// The game hands each incoming buffer off (detaching it) as soon as it reads it,
// often before any listener of ours runs. So instead of relying on listener order,
// copy the frame the very first time anyone reads a socket message's .data.
const _dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
Object.defineProperty(MessageEvent.prototype, 'data', {
  configurable: true,
  enumerable: true,
  get() {
    const d = _dataGetter.call(this);
    if (gameSocket && this.target === gameSocket && !seenEvents.has(this)) {
      seenEvents.add(this);
      stats.received++;
      enqueue(d, handleIncoming);
    }
    return d;
  },
});

// Copy the frame immediately so later hand-offs can't empty it
function snapshot(data) {
  if (data instanceof Blob) return data;                       // Blobs are immutable
  const buf = data instanceof ArrayBuffer ? data : data.buffer;
  if (buf.detached || buf.byteLength === 0) return null;       // already handed off
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(buf.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

// Process frames strictly in order (gunzip is async)
function enqueue(data, handler, source) {
  const copy = snapshot(data);
  if (!copy) {
    if (stats.detached++ === 0) console.warn('[board] a frame was already detached; board may be missing updates');
    return;
  }
  queue = queue.then(async () => {
    const bytes = copy instanceof Blob ? new Uint8Array(await copy.arrayBuffer()) : copy;
    for (const [type, body] of fields(await gunzip(bytes))) handler(type, body, source);
  }).catch((e) => { stats.errors++; stats.lastError = e; console.warn('[board] frame skipped:', e); });
}

// Quick health check: if 'received' grows but 'snapshots'/'patches' stay 0, tell me
function boardStatus() {
  const loaded = [...chunks.values()];
  console.table({
    socket: gameSocket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][gameSocket.readyState] : 'not captured',
    ...stats,
    lastError: stats.lastError ? String(stats.lastError) : '',
    chunksLoaded: loaded.length,
    chunksWithRevealedCells: loaded.filter((c) => c.some((v) => v !== 0)).length,
    view: view ? `${whereAmI()} (chunk ${view.cx},${view.cy})` : 'unknown',
    clickMode: clickMode ? (calib && boardEl ? 'on, calibrated' : 'on, click one cell manually to calibrate') : 'off',
  });
}

// --- protobuf encode --------------------------------------------------------
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 127n);
    v >>= 7n;
    if (v > 0n) b |= 128;
    out.push(b);
  } while (v > 0n);
  return out;
}
const vField = (num, val) => [...varint((num << 3) | 0), ...varint(val)];
const bField = (num, bytes) => [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];
// Chunk coordinates are signed (zigzag): 0,-1,1,-2,2 -> 0,1,2,3,4
const zigzag = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
const unzigzag = (v) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);
const chunkMsg = (cx, cy) => [...vField(1, zigzag(cx)), ...vField(2, zigzag(cy))];

// --- protobuf decode --------------------------------------------------------
// Yields [fieldNumber, value]; value is a Number (varint) or Uint8Array (bytes/message)
function* fields(b) {
  let i = 0;
  const read = () => {
    let r = 0, m = 1, x;
    do { x = b[i++]; r += (x & 127) * m; m *= 128; } while (x & 128);
    return r;
  };
  while (i < b.length) {
    const key = read(), wire = key & 7, num = Math.floor(key / 8);
    if (wire === 0) yield [num, read()];
    else if (wire === 2) { const len = read(); yield [num, b.subarray(i, i + len)]; i += len; }
    else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error('unknown wire type ' + wire);
  }
}
const toObj = (b) => { const o = {}; for (const [k, v] of fields(b)) o[k] = v; return o; };
const readChunk = (b) => { const o = toObj(b); return [unzigzag(o[1] || 0), unzigzag(o[2] || 0)]; };
const key = (cx, cy) => `${cx},${cy}`;

// --- gzip -------------------------------------------------------------------
async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// --- message handlers -------------------------------------------------------
function handleIncoming(type, body) {
  if (type === 19) {                         // your profile, sent on connect
    const o = toObj(body); if (typeof o[5] === 'number') stats.score = o[5];
  } else if (type === 8) {                   // result of one of your actions
    const o = toObj(body);
    if (o[6] instanceof Uint8Array) { const r = toObj(o[6]); stats.score = r[1]; stats.lastPoints = r[2]; }
  } else if (type === 29) {                         // full chunk snapshots
    for (const [f, entry] of fields(body)) {
      if (f !== 1) continue;
      const o = toObj(entry);
      const [cx, cy] = readChunk(o[1]);
      if (o[3] && o[3].length === CHUNK * CHUNK) { chunks.set(key(cx, cy), Uint8Array.from(o[3])); stats.snapshots++; }
    }
  } else if (type === 16) {                  // live patches: rectangles of new cell bytes
    let grid = null;
    for (const [f, v] of fields(body)) {
      if (f === 1) grid = chunks.get(key(...readChunk(v)));
      if (f === 3 && !grid) stats.patchesForUnloadedChunks++;
      if (f === 3 && grid) {
        stats.patches++;
        const r = toObj(v), x = r[1] || 0, y = r[2] || 0, w = r[3] || 0, h = r[4] || 0;
        const data = r[5] instanceof Uint8Array ? r[5] : new Uint8Array(0);
        for (let i = 0; i < data.length && i < w * h; i++)
          grid[(y + Math.floor(i / w)) * CHUNK + x + (i % w)] = data[i];
      }
    }
  }
}

function handleOutgoing(type, body, source) {
  if (type === 4) { logAction(body, source); if (source === 'manual') learnFromManualClick(body); }
  else if (type === 12) {                         // subscribe: untouched chunks get no snapshot
    for (const [f, v] of fields(body))
      if (f === 1) {
        const k = key(...readChunk(v));
        if (!chunks.has(k)) chunks.set(k, new Uint8Array(CHUNK * CHUNK));
        if (source === 'manual') gameSubs.add(k);
      }
  } else if (type === 13) {                  // unsubscribe: no more updates, forget it
    for (const [f, v] of fields(body)) {
      if (f !== 1) continue;
      const k = key(...readChunk(v));
      if (source === 'manual') gameSubs.delete(k);
      chunks.delete(k);
    }
  } else if (type === 5) {                   // the game reporting where you are
    const o = toObj(body), [cx, cy] = readChunk(o[1]), idx = o[2] || 0;
    const next = { cx, cy, col: idx % CHUNK, row: Math.floor(idx / CHUNK), w: o[3] || 0, h: o[4] || 0 };
    if (!view || ['cx', 'cy', 'col', 'row', 'w', 'h'].some((k) => view[k] !== next[k])) epoch++;  // view moved
    view = next;
  }
}

// --- reading the board ------------------------------------------------------
// Raw byte: 0 hidden, 1 revealed mine, 2-9 number 0-7, 10+ flag (value-10 = color)
function describe(raw) {
  if (raw === undefined) return { state: 'unknown' };
  if (raw === 0) return { state: 'hidden', raw };
  if (raw === 1) return { state: 'mine', raw };
  if (raw < 10) return { state: 'number', number: raw - 2, raw };
  return { state: 'flag', color: raw - 10, raw };
}

function toLocal(x, y) {
  const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
  return [cx, cy, x - cx * CHUNK, y - cy * CHUNK];
}
const toGlobal = (cx, cy, col, row) => [cx * CHUNK + col, cy * CHUNK + row];

const getCellLocal = (cx, cy, col, row) => describe(chunks.get(key(cx, cy))?.[row * CHUNK + col]);
const getCell = (x, y) => getCellLocal(...toLocal(x, y));

// Where the game last said you are, in global coordinates
const whereAmI = () => (view ? toGlobal(view.cx, view.cy, view.col, view.row) : null);

// Ask the server for fresh snapshots of chunks around you (radius in chunks)
// Fetch fresh snapshots for a list of [cx, cy] chunks. The server doesn't resend
// snapshots for chunks this connection already watches, so do what the game does
// when scrolling: unsubscribe, then subscribe again.
async function loadChunks(list, { quiet = false } = {}) {
  if (!gameSocket) throw new Error('Scroll or click once first so the socket is captured');
  if (!list.length) return;
  const msgList = list.flatMap(([cx, cy]) => bField(1, chunkMsg(cx, cy)));
  for (const m of [bField(13, msgList), bField(12, [...msgList, ...vField(2, CHUNK)])]) {
    const gz = await gzip(new Uint8Array(m));
    scriptSent.add(gz);
    gameSocket.send(gz);
  }
  list.forEach(([cx, cy]) => scriptChunks.add(key(cx, cy)));
  await sleep(solverSettings.loadWait);   // give the snapshots time to arrive
  await queue;
  if (!quiet) console.log(`[board] loaded ${list.length} chunks`);
}

async function loadAround(radius = 1, cx = view?.cx, cy = view?.cy) {
  if (cx === undefined) throw new Error('Position unknown: scroll a little, or pass cx, cy');
  const list = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) list.push([cx + dx, cy + dy]);
  await loadChunks(list, { quiet: true });
  console.log(`[board] loaded ${list.length} chunks around ${cx},${cy}`);
}

// Chunks covering a cell rectangle
function chunksIn(x0, y0, x1, y1) {
  const out = [];
  for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++)
    for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) out.push([cx, cy]);
  return out;
}

// Make sure every chunk touching the rectangle is loaded
async function ensureLoaded(x0, y0, x1, y1) {
  const missing = chunksIn(x0, y0, x1, y1).filter(([cx, cy]) => !chunks.has(key(cx, cy)));
  if (missing.length) await loadChunks(missing, { quiet: true });
}

// Stop watching chunks the script loaded that are no longer needed (never ones
// the game itself is showing), so traffic doesn't grow as the solver travels
async function releaseChunks(keep) {
  const drop = [...scriptChunks].filter((k) => !keep.has(k) && !gameSubs.has(k));
  if (!drop.length || !gameSocket) return;
  const gz = await gzip(new Uint8Array(bField(13, drop.flatMap((k) => bField(1, chunkMsg(...k.split(',').map(Number)))))));
  scriptSent.add(gz);
  gameSocket.send(gz);
  drop.forEach((k) => scriptChunks.delete(k));
}

// ASCII view: # hidden, . empty, 1-8 numbers, F flag, * mine, ? not loaded
function printArea(x, y, w = 30, h = 20) {
  const ch = { unknown: '?', hidden: '#', mine: '*', flag: 'F' };
  const lines = [];
  for (let j = 0; j < h; j++) {
    let s = '';
    for (let i = 0; i < w; i++) {
      const c = getCell(x + i, y + j);
      s += c.state === 'number' ? (c.number === 0 ? '.' : c.number) : ch[c.state];
    }
    lines.push(s);
  }
  console.log(lines.join('\n'));
}

// --- action log ---------------------------------------------------------------
// Every flag/reveal/chord sent (by you or the script) is printed and kept in actionLog.
// Turn printing off with: logActions = false
let logActions = true;
const actionLog = [];
const scriptSent = new WeakSet();

function logAction(body, source) {
  const o = toObj(body);
  const [cx, cy] = readChunk(o[2]), idx = o[3] || 0;
  const col = idx % CHUNK, row = Math.floor(idx / CHUNK);
  const [x, y] = toGlobal(cx, cy, col, row);
  const action = o[4] === 1 ? 'FLAG' : o[5] === 1 ? 'CHORD' : 'REVEAL';
  const entry = { time: new Date(o[1] || Date.now()), action, x, y, cx, cy, col, row, source };
  actionLog.push(entry);
  if (logActions)
    console.log(`[action] ${entry.time.toLocaleTimeString()}  ${action.padEnd(6)}  (${x}, ${y})` +
      `   chunk ${cx},${cy} col ${col} row ${row}   [${source}]`);
}

// Print everything logged so far as a table
const showActionLog = () => console.table(actionLog.map(({ time, action, x, y, source }) =>
  ({ time: time.toLocaleTimeString(), action, x, y, source })));

// --- click mode -----------------------------------------------------------------
// Instead of sending raw messages, simulate mouse clicks on the board so the game
// runs its normal click handling (score, animations, sounds...). The script
// learns where cells are on screen from your own clicks, and every action the
// game sends in response to a simulated click is checked before it goes out:
// if the click landed on the wrong cell, the message is corrected to the
// intended cell (keeping the game's request id), so a misclick can never act on
// the wrong cell. Off by default (it didn't fix the score display); turn on with:
// clickMode = true
let clickMode = false;
let boardEl = null;          // the element your clicks land on (learned)
let lastPointer = null;      // your last real pointerdown
let calib = null;            // { s, ox, oy, epoch, vx, vy }: screen = o + (cell + 0.5) * s
const samples = [];          // { px, py, x, y, epoch }: screen point -> cell it hit
let consecutiveTimeouts = 0;

// Learn from your real clicks; also detect the view moving (drag / wheel)
window.addEventListener('pointerdown', (e) => {
  if (e.isTrusted) lastPointer = { px: e.clientX, py: e.clientY, t: Date.now(), el: e.target, epoch };
}, true);
window.addEventListener('pointermove', (e) => {
  if (e.isTrusted && e.buttons && lastPointer &&
      Math.hypot(e.clientX - lastPointer.px, e.clientY - lastPointer.py) > 4) epoch++;
}, true);
window.addEventListener('wheel', (e) => { if (e.isTrusted) epoch++; }, true);
window.addEventListener('resize', () => epoch++);

function addSample(px, py, x, y, ep) {
  samples.push({ px, py, x, y, epoch: ep });
  if (samples.length > 50) samples.shift();
  fitCalibration();
}

function learnFromManualClick(body) {
  const o = toObj(body), p = lastPointer;
  if (!p || pendingClick) return;
  const ts = o[1] || 0;
  if (ts < p.t - 50 || ts - p.t > 1500) return;       // not from that click
  const [cx, cy] = readChunk(o[2]), idx = o[3] || 0;
  const [x, y] = toGlobal(cx, cy, idx % CHUNK, Math.floor(idx / CHUNK));
  boardEl = p.el;
  lastPointer = null;
  addSample(p.px, p.py, x, y, p.epoch);
}

// Cell size guess before we have 2+ samples: board width / cells across (from the
// game's view messages). Only a starting point; real clicks refine it.
function priorCellSize() {
  if (calib?.s) return calib.s;
  if (boardEl && view?.w) return boardEl.getBoundingClientRect().width / view.w;
  return null;
}

function fitCalibration() {
  const cur = samples.filter((q) => q.epoch === epoch).slice(-15);
  let s = priorCellSize();
  if (cur.length >= 2) {                     // least-squares slope over both axes
    const mx = cur.reduce((a, q) => a + q.x, 0) / cur.length, my = cur.reduce((a, q) => a + q.y, 0) / cur.length;
    const mpx = cur.reduce((a, q) => a + q.px, 0) / cur.length, mpy = cur.reduce((a, q) => a + q.py, 0) / cur.length;
    let num = 0, den = 0;
    for (const q of cur) { num += (q.x - mx) * (q.px - mpx) + (q.y - my) * (q.py - mpy); den += (q.x - mx) ** 2 + (q.y - my) ** 2; }
    if (den >= 4) s = num / den;
  }
  if (!s || !cur.length) return;
  // Each sample says: its point lies inside its cell. Intersect those ranges.
  for (let drop = 0; drop < cur.length; drop++) {
    const use = cur.slice(drop);
    const loX = Math.max(...use.map((q) => q.px - (q.x + 1) * s)), hiX = Math.min(...use.map((q) => q.px - q.x * s));
    const loY = Math.max(...use.map((q) => q.py - (q.y + 1) * s)), hiY = Math.min(...use.map((q) => q.py - q.y * s));
    if (loX <= hiX && loY <= hiY) {
      calib = { s, ox: (loX + hiX) / 2, oy: (loY + hiY) / 2, epoch, vx: viewX(), vy: viewY() };
      return;
    }
  }
}
const viewX = () => (view ? view.cx * CHUNK + view.col : null);
const viewY = () => (view ? view.cy * CHUNK + view.row : null);

// Where on screen to click for cell (x, y); null if unknown or not on the board
function screenPos(x, y) {
  if (!boardEl || !calib) return null;
  if (calib.epoch !== epoch) fitCalibration();
  let { s, ox, oy } = calib;
  if (calib.epoch !== epoch && view && calib.vx !== null) {
    // View moved since the last good fit: shift by how far the game says it moved
    ox -= (viewX() - calib.vx) * s;
    oy -= (viewY() - calib.vy) * s;
  }
  const px = ox + (x + 0.5) * s, py = oy + (y + 0.5) * s;
  const r = boardEl.getBoundingClientRect(), m = s * 0.3;
  if (px < r.left + m || px > r.right - m || py < r.top + m || py > r.bottom - m) return null;
  const hit = document.elementFromPoint(px, py);
  if (hit !== boardEl && !boardEl.contains(hit)) return null;   // covered by UI
  return { px, py };
}

function dispatchClick(el, px, py, button) {
  const base = { bubbles: true, cancelable: true, composed: true, view: window,
    clientX: px, clientY: py, screenX: window.screenX + px, screenY: window.screenY + py,
    pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const P = (type, extra) => el.dispatchEvent(new PointerEvent(type, { ...base, ...extra }));
  const M = (type, extra) => el.dispatchEvent(new MouseEvent(type, { ...base, ...extra }));
  const pressed = button === 2 ? 2 : 1;
  P('pointermove', { button: -1, buttons: 0 });
  M('mousemove', { button: 0, buttons: 0 });
  // Like a real browser: if pointerdown is cancelled, mousedown/up are not sent
  const compat = P('pointerdown', { button, buttons: pressed });
  if (compat) M('mousedown', { button, buttons: pressed });
  P('pointerup', { button, buttons: 0 });
  if (compat) M('mouseup', { button, buttons: 0 });
  if (button === 0) M('click', { button: 0, buttons: 0 });
  else { M('auxclick', { button: 2, buttons: 0 }); M('contextmenu', { button: 2, buttons: 0 }); }
}

async function clickAction(action, x, y) {
  const pos = screenPos(x, y);
  if (!pos) return false;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const pc = { x, y, action, resolve, ...pos, epoch, done: false };
  pendingClick = pc;
  try {
    dispatchClick(boardEl, pos.px, pos.py, action === ACTION.FLAG ? 2 : 0);
  } catch (e) {
    console.warn('[click] dispatch failed:', e);
  }
  const got = await Promise.race([done, sleep(1500).then(() => null)]);
  pendingClick = null;
  if (!got) {
    // The game didn't send anything: block any late action from this click
    pc.done = true;
    guardUntil = Date.now() + 2000;
    stats.clickTimeouts++;
    if (++consecutiveTimeouts >= 3) {
      clickMode = false;
      console.warn('[click] the game is not responding to simulated clicks; switched to direct messages');
    }
    return false;
  }
  consecutiveTimeouts = 0;
  guardUntil = Date.now() + 300;           // drop any duplicate action from the same click
  addSample(pos.px, pos.py, got.x, got.y, pc.epoch);
  return true;
}

// Decide what to do with a game message sent around a simulated click
async function processHeld(ws, copy) {
  const raw = await gunzip(copy instanceof Blob ? new Uint8Array(await copy.arrayBuffer()) : copy);
  const actionField = [...fields(raw)].find(([t]) => t === 4);
  if (!actionField) return forward(ws, copy, 'manual');        // not an action: pass through
  const o = toObj(actionField[1]);
  const [cx, cy] = readChunk(o[2]), idx = o[3] || 0;
  const [gx, gy] = toGlobal(cx, cy, idx % CHUNK, Math.floor(idx / CHUNK));
  const pc = pendingClick;
  if (!pc || pc.done) {                     // an action nobody asked for: never send it
    stats.gameActionsBlocked++;
    console.warn(`[click] blocked an unexpected game action at (${gx}, ${gy})`);
    return;
  }
  pc.done = true;
  let out = copy;
  if (gx !== pc.x || gy !== pc.y || (o[4] || 0) !== pc.action[0] || (o[5] || 0) !== pc.action[1]) {
    const [tcx, tcy, col, row] = toLocal(pc.x, pc.y);
    out = await gzip(buildAction(pc.action, tcx, tcy, row * CHUNK + col, o[1]));   // keep request id
    stats.clicksCorrected++;
  } else stats.clicksExact++;
  pc.resolve({ x: gx, y: gy });
  forward(ws, out, 'script-click');
}

function forward(ws, bytes, source) {
  enqueue(bytes, handleOutgoing, source);
  _origSend.call(ws, bytes);
}

// --- UI resync ----------------------------------------------------------------
// The game's score display doesn't pick up automated actions, but the server
// sends your current totals whenever the game connects. resyncUI() drops the
// connection so the game reconnects and refreshes its UI, without a page reload.
// The script picks up the new connection by itself.
async function resyncUI() {
  if (!gameSocket) throw new Error('Socket not captured yet');
  const old = gameSocket;
  old.close();
  for (let i = 0; i < 50 && gameSocket === old; i++) await sleep(200);
  if (gameSocket === old) {
    console.warn('[resync] the game did not reconnect within 10 s; reload the page instead');
    return false;
  }
  await sleep(1500);                     // let the game resubscribe and snapshots arrive
  await queue;
  console.log('[resync] reconnected; score is now', stats.score ?? '(shown in the game)');
  return true;
}

// --- actions ------------------------------------------------------------------
// Fields 4 and 5 select the action: reveal = (0,0), flag = (1,0), chord = (0,1)
const ACTION = { REVEAL: [0, 0], FLAG: [1, 0], CHORD: [0, 1] };

function buildAction([f4, f5], chunkX, chunkY, cellIndex, ts = Date.now()) {
  const inner = [
    ...vField(1, ts),                       // client timestamp in ms (the game uses it as a request id)
    ...bField(2, chunkMsg(chunkX, chunkY)), // which chunk
    ...vField(3, cellIndex),                // row * 64 + col inside the chunk
    ...vField(4, f4),                       // 1 = flag
    ...vField(5, f5),                       // 1 = chord
  ];
  return new Uint8Array(bField(4, inner));
}

async function sendAction(action, chunkX, chunkY, col, row) {
  if (!gameSocket) throw new Error('Scroll or click once first so the socket is captured');
  const msg = await gzip(buildAction(action, chunkX, chunkY, row * CHUNK + col));
  scriptSent.add(msg);                       // lets the log tell script actions from clicks
  gameSocket.send(msg);
}

// Every action goes through act(): a simulated click when possible (so the game's
// own UI - score, animations - stays in sync), otherwise a direct message.
async function act(action, x, y) {
  if (clickMode && (await clickAction(action, x, y))) return 'click';
  if (clickMode) stats.clickFallbacks++;
  await sendAction(action, ...toLocal(x, y));
  return 'direct';
}

const flagGlobal   = (x, y) => act(ACTION.FLAG, x, y);
const revealGlobal = (x, y) => act(ACTION.REVEAL, x, y);
const chordGlobal  = (x, y) => act(ACTION.CHORD, x, y);
const flagLocal    = (cx, cy, col, row) => flagGlobal(...toGlobal(cx, cy, col, row));
const revealLocal  = (cx, cy, col, row) => revealGlobal(...toGlobal(cx, cy, col, row));
const chordLocal   = (cx, cy, col, row) => chordGlobal(...toGlobal(cx, cy, col, row));

// --- solver -------------------------------------------------------------------
// solveRadius(size): one pass of guaranteed-safe moves over a size x size square
// centred on whereAmI(). Only certain deductions are used:
//   1. a number whose mines are all found -> its other hidden neighbours are safe
//   2. a number with exactly as many hidden neighbours as missing mines -> all mines
//   3. subset rule: if A's hidden cells are a subset of B's, the extra cells of B
//      hold exactly (B's missing mines - A's missing mines) mines
// Flags and revealed mines (byte 1) both count as known mines.

const cellKey = (x, y) => `${x},${y}`;
const parseKey = (k) => k.split(',').map(Number);
const neighbours = (x, y) => {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push([x + dx, y + dy]);
  return out;
};
const isMine = (c) => c.state === 'flag' || c.state === 'mine';

// Pure analysis of the current local state; returns what is safe to do
function planSolve(x0, y0, x1, y1) {
  const inArea = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const constraints = [];
  let unknownCells = 0, contradictions = 0;

  // Numbers just outside the square still constrain cells inside it
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const c = getCell(x, y);
      if (inArea(x, y) && c.state === 'unknown') unknownCells++;
      if (c.state !== 'number') continue;
      const hidden = [];
      let mines = 0, flagsOnly = true, unknown = false;
      for (const [nx, ny] of neighbours(x, y)) {
        const n = getCell(nx, ny);
        if (n.state === 'unknown') unknown = true;
        else if (n.state === 'hidden') hidden.push(cellKey(nx, ny));
        else if (isMine(n)) { mines++; if (n.state === 'mine') flagsOnly = false; }
      }
      if (unknown || hidden.length === 0) continue;
      const missing = c.number - mines;
      if (missing < 0 || missing > hidden.length) { contradictions++; continue; }
      constraints.push({ x, y, hidden, set: new Set(hidden), missing, flagsOnly });
    }
  }

  const safe = new Set(), mines = new Set();
  const markSafe = (k) => { if (inArea(...parseKey(k))) safe.add(k); };
  const markMine = (k) => { if (inArea(...parseKey(k))) mines.add(k); };

  // Rules 1 and 2
  for (const c of constraints) {
    if (c.missing === 0) c.hidden.forEach(markSafe);
    else if (c.missing === c.hidden.length) c.hidden.forEach(markMine);
  }

  // Rule 3 (subset), comparing only constraints that share a hidden cell
  const byCell = new Map();
  for (const c of constraints) for (const k of c.hidden) {
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(c);
  }
  for (const a of constraints) {
    const others = new Set(byCell.get(a.hidden[0]));
    for (const b of others) {
      if (b === a || b.hidden.length <= a.hidden.length) continue;
      if (!a.hidden.every((k) => b.set.has(k))) continue;
      const extra = b.hidden.filter((k) => !a.set.has(k));
      const d = b.missing - a.missing;
      if (d === 0) extra.forEach(markSafe);
      else if (d === extra.length) extra.forEach(markMine);
    }
  }

  // Never act on a cell that was deduced both ways (would mean bad data)
  for (const k of safe) if (mines.has(k)) { safe.delete(k); mines.delete(k); contradictions++; }

  // Prefer chords: one click reveals every hidden neighbour of a finished number.
  // Only chord where all its mines are flags (unsure how chord treats hit mines).
  const chords = [], covered = new Set();
  const candidates = constraints
    .filter((c) => c.missing === 0 && c.flagsOnly && inArea(c.x, c.y))
    .sort((p, q) => q.hidden.length - p.hidden.length);
  for (const c of candidates) {
    const fresh = c.hidden.filter((k) => !covered.has(k));
    if (fresh.length < 2) continue;              // a single cell is just a reveal
    chords.push(cellKey(c.x, c.y));
    c.hidden.forEach((k) => covered.add(k));
  }
  const reveals = [...safe].filter((k) => !covered.has(k));

  return { flags: [...mines], chords, reveals, unknownCells, contradictions };
}

let solving = false, stopRequested = false;
const stopSolve = () => { stopRequested = true; };

// Cell rectangle of a size x size square centred on [x, y]
function areaAround([x, y], size) {
  const half = Math.floor(size / 2);
  return [x - half, y - half, x - half + size - 1, y - half + size - 1];
}
const rectText = ([x0, y0, x1, y1]) => `(${x0},${y0})-(${x1},${y1})`;

function countHidden([x0, y0, x1, y1]) {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (getCell(x, y).state === 'hidden') n++;
  return n;
}
const planSize = (p) => p.flags.length + p.chords.length + p.reveals.length;

// One pass over a rectangle: plan, act with a delay between actions, then check
// the results against the board once the server has replied.
async function runPass(rect, { delay = 250, passWait = solverSettings.passWait, quiet = false } = {}) {
  const [x0, y0, x1, y1] = rect;
  await ensureLoaded(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
  const plan = planSolve(x0, y0, x1, y1);
  const done = { flags: [], chords: [], reveals: [], skipped: 0 };
  const check = { flagged: 0, revealed: 0, hitMine: [], notUpdated: [] };
  if (!quiet) console.log(`[solve] area ${rectText(rect)}: ${plan.flags.length} flags, ` +
    `${plan.chords.length} chords, ${plan.reveals.length} reveals` +
    (plan.contradictions ? `, ${plan.contradictions} contradictions skipped` : ''));
  if (!planSize(plan)) return { plan, done, check };

  const chordCells = [];                 // cells each executed chord should open
  const steps = [                        // flags first, then chords, then single reveals
    ...plan.flags.map((k) => ['flags', k]),
    ...plan.chords.map((k) => ['chords', k]),
    ...plan.reveals.map((k) => ['reveals', k]),
  ];
  for (const [kind, k] of steps) {
    if (stopRequested) break;
    const [x, y] = parseKey(k);
    const c = getCell(x, y);
    // Re-check just before acting: another player may have got there first
    const stillValid = kind === 'chords'
      ? c.state === 'number' && neighbours(x, y).some(([a, b]) => getCell(a, b).state === 'hidden')
      : c.state === 'hidden';
    if (!stillValid) { done.skipped++; continue; }
    if (kind === 'flags') await flagGlobal(x, y);
    else if (kind === 'chords') {
      chordCells.push(...neighbours(x, y).filter(([a, b]) => getCell(a, b).state === 'hidden').map(([a, b]) => cellKey(a, b)));
      await chordGlobal(x, y);
    } else await revealGlobal(x, y);
    done[kind].push(k);
    await sleep(delay);
  }

  // Wait until the board shows every action's result, or passWait runs out
  const openCells = new Set([...done.reveals, ...chordCells]);
  const pendingCount = () => done.flags.filter((k) => getCell(...parseKey(k)).state !== 'flag').length +
    [...openCells].filter((k) => getCell(...parseKey(k)).state === 'hidden').length;
  const waitStart = Date.now();
  do { await sleep(50); await queue; } while (pendingCount() > 0 && Date.now() - waitStart < passWait);
  for (const k of done.flags) {
    const st = getCell(...parseKey(k)).state;
    if (st === 'flag') check.flagged++; else check.notUpdated.push(`flag ${k} -> ${st}`);
  }
  for (const k of new Set([...done.reveals, ...chordCells])) {
    const st = getCell(...parseKey(k)).state;
    if (st === 'number') check.revealed++;
    else if (st === 'mine') check.hitMine.push(k);
    else check.notUpdated.push(`reveal ${k} -> ${st}`);
  }
  if (check.hitMine.length) console.warn('[solve] revealed a mine (should never happen):', check.hitMine);
  if (!quiet) {
    console.log(`[solve] sent ${done.flags.length} flags, ${done.chords.length} chords, ${done.reveals.length} reveals ` +
      `(${done.skipped} skipped); board confirms ${check.flagged} flags, ${check.revealed} revealed cells`);
    if (check.notUpdated.length)
      console.warn(`[solve] ${check.notUpdated.length} actions not reflected on the board yet, e.g.`, check.notUpdated.slice(0, 5));
  }
  return { plan, done, check };
}

// Run fn with the "solving" lock held
async function exclusive(fn) {
  if (solving) { console.warn('[solve] already running (stopSolve() to cancel)'); return null; }
  solving = true; stopRequested = false;
  try { return await fn(); } finally { solving = false; }
}
const startPoint = (center) => {
  const c = center ?? whereAmI();
  if (!c) throw new Error('Position unknown: scroll a little first, or pass { center: [x, y] }');
  return c;
};

// One pass over a size x size square around you (or options.center)
async function solveRadius(size = 20, { delay = 250, passWait, dryRun = false, center } = {}) {
  const rect = areaAround(startPoint(center), size);
  if (dryRun) {
    await ensureLoaded(rect[0] - 2, rect[1] - 2, rect[2] + 2, rect[3] + 2);
    const plan = planSolve(...rect);
    console.log(`[solve] area ${rectText(rect)}: ${plan.flags.length} flags, ${plan.chords.length} chords, ${plan.reveals.length} reveals`);
    return plan;
  }
  return exclusive(() => runPass(rect, { delay, passWait }));
}

// Repeat passes over the same area until it is solved or no safe move is left
async function areaLoop(rect, { delay = 250, passWait, maxPasses = 100, quiet = false } = {}) {
  const total = { passes: 0, flags: 0, chords: 0, reveals: 0 };
  let status = 'max passes reached';
  while (total.passes < maxPasses) {
    if (stopRequested) { status = 'stopped'; break; }
    const { plan, done, check } = await runPass(rect, { delay, passWait, quiet: true });
    if (!planSize(plan)) { status = countHidden(rect) === 0 ? 'solved' : 'stuck (needs a guess)'; break; }
    total.passes++;
    total.flags += done.flags.length; total.chords += done.chords.length; total.reveals += done.reveals.length;
    const sent = done.flags.length + done.chords.length + done.reveals.length;
    if (!quiet) console.log(`[area] pass ${total.passes}: ${done.flags.length} flags, ${done.chords.length} chords, ` +
      `${done.reveals.length} reveals`);
    if (check.hitMine.length) { status = 'hit a mine (stopped to be safe)'; break; }
    if (sent > 0 && check.flagged + check.revealed === 0) { status = 'no progress (actions not taking effect)'; break; }
  }
  const hiddenLeft = countHidden(rect);
  if (!quiet) console.log(`[area] ${rectText(rect)} ${status}: ${total.passes} passes, ${total.flags} flags, ` +
    `${total.chords} chords, ${total.reveals} reveals, ${hiddenLeft} hidden cells left`);
  return { status, ...total, hiddenLeft };
}

async function solveArea(size = 40, { delay = 250, passWait, maxPasses = 100, center } = {}) {
  const rect = areaAround(startPoint(center), size);
  return exclusive(() => areaLoop(rect, { delay, passWait, maxPasses }));
}

// Find the nearby area with the most guaranteed moves. Candidate areas sit on a
// grid around the current one (step = size - overlap, so neighbours overlap a
// little), searched ring by ring outward. Returns null if nothing nearby has work.
async function pickNextArea(center, size, step, maxRings) {
  for (let ring = 1; ring <= maxRings; ring++) {
    const reach = ring * step + Math.ceil(size / 2) + 2;
    await ensureLoaded(center[0] - reach, center[1] - reach, center[0] + reach, center[1] + reach);
    let best = null;
    for (let j = -ring; j <= ring; j++) for (let i = -ring; i <= ring; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const c = [center[0] + i * step, center[1] + j * step];
      const work = planSize(planSolve(...areaAround(c, size)));
      if (work > 0 && (!best || work > best.work)) best = { center: c, work };
    }
    if (best) return best;
    if (stopRequested) return null;
  }
  return null;
}

// Load any missing chunks for several rectangles in one go
async function ensureRects(rects) {
  const need = new Map();
  for (const [x0, y0, x1, y1] of rects)
    for (const c of chunksIn(x0 - 2, y0 - 2, x1 + 2, y1 + 2)) if (!chunks.has(key(...c))) need.set(key(...c), c);
  if (need.size) await loadChunks([...need.values()], { quiet: true });
}

// "nearest" mode: the closest area to the starting point (on a grid of areas
// anchored there) that still has a guaranteed move. Solved areas are skipped for
// good; stuck ones are skipped until the solver works next to them again.
async function pickNearestToStart(start, size, step, areaState, maxRadius) {
  const offsets = [];
  for (let j = -maxRadius; j <= maxRadius; j++)
    for (let i = -maxRadius; i <= maxRadius; i++) if (i * i + j * j <= maxRadius * maxRadius) offsets.push([i, j]);
  offsets.sort((p, q) => p[0] ** 2 + p[1] ** 2 - (q[0] ** 2 + q[1] ** 2));
  // Check candidates in batches of equal (rounded) distance, loading each batch at once
  for (let n = 0; n < offsets.length;) {
    const band = Math.round(Math.hypot(...offsets[n]));
    const batch = [];
    while (n < offsets.length && Math.round(Math.hypot(...offsets[n])) === band) {
      const [i, j] = offsets[n++];
      if (!areaState.has(`${i},${j}`)) batch.push([i, j]);
    }
    if (!batch.length) continue;
    const centerOf = ([i, j]) => [start[0] + i * step, start[1] + j * step];
    await ensureRects(batch.map((g) => areaAround(centerOf(g), size)));
    for (const g of batch) {                       // already sorted by distance
      const rect = areaAround(centerOf(g), size);
      const work = planSize(planSolve(...rect));
      if (work > 0) return { center: centerOf(g), grid: g, work };
      areaState.set(`${g[0]},${g[1]}`, countHidden(rect) === 0 ? 'solved' : 'stuck');
    }
    if (stopRequested) return null;
  }
  return null;
}

// Solve an area completely, pick the next area, and repeat.
//   mode 'mostWork' (default): move to the neighbouring area with the most safe moves
//   mode 'nearest': always the closest unfinished area to where autoSolve started
async function autoSolve(size = 40, { delay = 250, passWait, overlap = Math.round(size / 5), mode = 'mostWork',
                                      maxRings = 3, maxRadius = 25, maxAreas = Infinity, center } = {}) {
  const start = startPoint(center);
  let here = start, grid = [0, 0];
  const step = Math.max(1, size - overlap);
  const areaState = new Map();                    // nearest mode: "i,j" -> 'solved' | 'stuck'
  return exclusive(async () => {
    const total = { areas: 0, flags: 0, chords: 0, reveals: 0 };
    const started = Date.now();
    while (total.areas < maxAreas && !stopRequested) {
      const rect = areaAround(here, size);
      const r = await areaLoop(rect, { delay, passWait, quiet: true });
      total.areas++;
      total.flags += r.flags; total.chords += r.chords; total.reveals += r.reveals;
      console.log(`[auto] area ${total.areas} ${rectText(rect)}: ${r.status}; ` +
        `${r.flags} flags, ${r.chords} chords, ${r.reveals} reveals (totals: ${total.flags} flags, ` +
        `${total.chords} chords, ${total.reveals} reveals)`);
      if (r.status.startsWith('hit a mine') || r.status.startsWith('no progress') || stopRequested) break;

      let next;
      if (mode === 'nearest') {
        areaState.set(`${grid[0]},${grid[1]}`, r.status === 'solved' ? 'solved' : 'stuck');
        // Work done here may unblock the overlapping neighbours: check them again
        if (r.flags + r.chords + r.reveals > 0)
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const k = `${grid[0] + di},${grid[1] + dj}`;
            if ((di || dj) && areaState.get(k) === 'stuck') areaState.delete(k);
          }
        next = await pickNearestToStart(start, size, step, areaState, maxRadius);
      } else {
        next = await pickNextArea(here, size, step, maxRings);
      }
      if (!next) { console.log('[auto] no area with a safe move found within range; stopping'); break; }
      // Keep chunks around the next area and around your own view; drop the rest
      const keep = new Set(chunksIn(...areaAround(next.center, size + 2 * (step + 4))).map(([a, b]) => key(a, b)));
      if (view) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keep.add(key(view.cx + dx, view.cy + dy));
      await releaseChunks(keep);
      console.log(`[auto] moving to ${next.center} (${next.work} safe moves waiting)`);
      here = next.center;
      if (next.grid) grid = next.grid;
    }
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[auto] finished after ${mins} min: ${total.areas} areas, ${total.flags} flags, ` +
      `${total.chords} chords, ${total.reveals} reveals`);
    return { ...total, lastCenter: here };
  });
}

// Examples:
// await loadAround(1);                 // snapshot the 3x3 chunks around you
// whereAmI();                          // -> [x, y] global
// printArea(...whereAmI(), 40, 20);    // draw part of the board in the console
// getCell(5798, 1820);                 // -> { state: 'flag', color: 1, raw: 11 }
// await revealGlobal(5798, 1821);
// await resyncUI();                  // refresh the game's score display after solving
// boardStatus();                      // health check if the board looks wrong
// await solveRadius(30);             // one safe solving pass over a 30x30 square
// await solveArea(40);                 // repeat passes until the 40x40 area is done
// await autoSolve(40);                 // solve area after area, moving to where work is
// await autoSolve(40, { mode: 'nearest' });  // always the closest unfinished area to the start
// await autoSolve(40, { delay: 100, passWait: 500 });  // faster actions, shorter wait between passes
// solverSettings.loadWait = 300;       // wait after loading chunks
// stopSolve();                         // stop any of these after the current action
// await solveRadius(30, { dryRun: true });  // just show what it would do
// showActionLog();                    // table of every action sent this session
