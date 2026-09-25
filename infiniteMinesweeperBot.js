/* ===========================================================================
 * Infinite Minesweeper Bot - single-file console tool for infiniteminesweeper.com
 * ===========================================================================
 *
 * WHAT IT DOES
 *   Hooks the game's WebSocket to keep a live copy of the board in memory, then
 *   plays guaranteed-safe moves (flags, chords, reveals). It never guesses.
 *
 * HOW TO USE
 *   1. Open infiniteminesweeper.com and open the DevTools console.
 *   2. Paste this whole file and press Enter.
 *   3. Scroll or click once so the socket hook can grab the game's connection.
 *   4. await loadAround();  then  await autoSolve();
 *
 *   Every command is also available under the `msbot` object (msbot.autoSolve(...)),
 *   and re-pasting the file is safe: it disposes the previous copy first.
 *
 * CONFIGURATION
 *   Section 1 below is meant to be edited before pasting. Section 2 holds the
 *   shipped defaults (also kept in config.defaults.js) so resetConfig() can put
 *   everything back at runtime without re-pasting.
 *
 * FILE MAP
 *   1. Config (edit me)            10. Chunk loading
 *   2. Shipped defaults            11. Action log
 *   3. Config plumbing             12. Click mode
 *   4. State + install/dispose     13. Actions
 *   5. Socket hook                 14. Solver: deduction
 *   6. Protobuf                    15. Solver: one area
 *   7. Gzip                        16. Solver: autoSolve
 *   8. Message handlers            17. Diagnostics
 *   9. Reading the board           18. Public API
 *
 * See README.md for the protocol notes, the full command reference and the
 * meaning of every setting.
 * ======================================================================== */

(() => {
'use strict';

// ===========================================================================
// 1. CONFIG - edit these values, then paste the file
//    Settings can also be changed live:  setConfig({ solver: { actionDelay: 120 } })
//    Put everything back to the defaults in section 2:  resetConfig()
// ===========================================================================

const CONFIG = {
  solver: {
    passSize: 20,            // default square size for solveRadius()
    areaSize: 100,           // default square size for solveArea() / autoSolve()
    actionDelay: 10,         // ms between two actions sent to the server
    passWait: 20,            // ms to wait for the server to confirm a pass's actions
    maxPasses: 1000,         // give up on an area after this many passes
  },
  auto: {
    mode: 'nearest',         // 'mostWork' = richest nearby area, 'nearest' = closest to the start
    overlapRatio: 0.2,       // neighbouring areas overlap by round(size * this)
    maxRings: Infinity,      // 'mostWork': how many rings of areas to search outward
    maxRadius: Infinity,     // 'nearest': how many areas out from the start to consider
    giveUpAfterEmpty: 3,     // stop looking after this many rings/bands of areas with nothing revealed in them (bounds an Infinity radius)
    maxAreas: Infinity,      // stop after this many areas
    keepMargin: 4,           // extra chunks kept loaded around the next area
  },
  board: {
    loadRadius: 1,           // default radius (in chunks) for loadAround()
    loadWait: 500,           // ms to wait for chunk snapshots after subscribing
    solverPadding: 2,        // cells of context loaded around a solved rectangle
  },
  memory: {
    maxScriptChunks: 300,    // cap on chunks the bot keeps subscribed; least recently used beyond it are released (0 = no cap)
    releaseOnFinish: true,   // when a solver command ends, release every chunk it loaded except those around your view
  },
  click: {
    enabled: false,          // true = act by simulating real mouse clicks (see README)
    responseWait: 1500,      // ms to wait for the game to react to a simulated click
    guardAfterClick: 300,    // ms to keep dropping duplicate actions after a click
    guardAfterTimeout: 2000, // ms to block late actions after a click timed out
    maxTimeouts: 3,          // turn click mode off after this many timeouts in a row
    maxSamples: 50,          // remembered screen-point -> cell samples
    fitSamples: 15,          // most recent samples used to fit the cell grid
    minSpread: 4,            // minimum sample spread before trusting a fitted cell size
    edgeMargin: 0.3,         // keep clicks this fraction of a cell away from the board edge
    dragThreshold: 4,        // px of pointer movement counted as dragging the view
    matchBefore: 50,         // ms an action may predate its pointerdown and still match
    matchAfter: 1500,        // ms an action may trail its pointerdown and still match
  },
  logging: {
    actions: false,          // print every action as it is sent
    maxEntries: 5000,        // actionLog ring-buffer size
  },
  display: {
    areaWidth: 30,           // default width for printArea()
    areaHeight: 20,          // default height for printArea()
  },
  net: {
    socketUrlMatch: 'infiniteminesweeper.com/ws',  // substring identifying the game socket
    resyncTimeout: 10000,    // ms to wait for the game to reconnect in resyncUI()
    resyncPoll: 200,         // ms between reconnect checks
    resyncSettle: 1500,      // ms to let the game resubscribe after reconnecting
  },
};

// ===========================================================================
// 2. SHIPPED DEFAULTS - do not edit
//    Identical to the block above as shipped, and mirrored in config.defaults.js
//    (run `node tools/check-defaults.js` to verify the two still match).
//    resetConfig() copies these back over the live config.
// ===========================================================================

/* DEFAULTS:START */
const DEFAULT_CONFIG = {
  solver: {
    passSize: 20,
    areaSize: 100,
    actionDelay: 10,
    passWait: 20,
    maxPasses: 1000,
  },
  auto: {
    mode: 'nearest',
    overlapRatio: 0.2,
    maxRings: Infinity,
    maxRadius: Infinity,
    giveUpAfterEmpty: 3,
    maxAreas: Infinity,
    keepMargin: 4,
  },
  board: {
    loadRadius: 1,
    loadWait: 500,
    solverPadding: 2,
  },
  memory: {
    maxScriptChunks: 300,
    releaseOnFinish: true,
  },
  click: {
    enabled: false,
    responseWait: 1500,
    guardAfterClick: 300,
    guardAfterTimeout: 2000,
    maxTimeouts: 3,
    maxSamples: 50,
    fitSamples: 15,
    minSpread: 4,
    edgeMargin: 0.3,
    dragThreshold: 4,
    matchBefore: 50,
    matchAfter: 1500,
  },
  logging: {
    actions: false,
    maxEntries: 5000,
  },
  display: {
    areaWidth: 30,
    areaHeight: 20,
  },
  net: {
    socketUrlMatch: 'infiniteminesweeper.com/ws',
    resyncTimeout: 10000,
    resyncPoll: 200,
    resyncSettle: 1500,
  },
};
/* DEFAULTS:END */

// ===========================================================================
// 3. CONFIG PLUMBING
// ===========================================================================

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (Array.isArray(v) ? v.map(clone)
  : isPlainObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  : v);

// Recursive assign: nested objects are merged, everything else is replaced
function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (isPlainObject(v) && isPlainObject(target[k])) mergeInto(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}
deepFreeze(DEFAULT_CONFIG);

// "solver.actionDelay" -> value, for tables and diffs
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

// The live settings every function reads. Missing keys fall back to the defaults,
// so deleting a line from CONFIG is always safe.
const config = mergeInto(clone(DEFAULT_CONFIG), CONFIG);

// Catch typos in CONFIG (a key the bot never reads would silently do nothing)
const knownSettings = flatten(DEFAULT_CONFIG);
const unknownKeys = Object.keys(flatten(CONFIG)).filter((k) => !(k in knownSettings));
if (unknownKeys.length) console.warn('[config] unknown setting(s) ignored:', unknownKeys.join(', '));

const showConfig = () => console.table(Object.entries(flatten(config))
  .map(([setting, value]) => ({ setting, value, default: knownSettings[setting] })));
const setConfig = (patch) => mergeInto(config, patch);
const resetConfig = () => {
  for (const k of Object.keys(config)) delete config[k];
  mergeInto(config, clone(DEFAULT_CONFIG));
  console.log('[config] reset to defaults');
  return config;
};
// Only the settings that differ from the shipped defaults
const configDiff = () => {
  const defaults = flatten(DEFAULT_CONFIG), current = flatten(config);
  const out = {};
  for (const [k, v] of Object.entries(current)) if (v !== defaults[k]) out[k] = { value: v, default: defaults[k] };
  return out;
};

// ===========================================================================
// 4. STATE + INSTALL / DISPOSE
// ===========================================================================

const CHUNK = 64;                   // chunks are 64x64 cells; index = row * 64 + col
const NO_SOCKET = 'Socket not captured yet: scroll or click once in the game first';

const chunks = new Map();           // "cx,cy" -> Uint8Array(4096) of raw cell bytes
const gameSubs = new Set();         // chunks the game itself subscribed to
const scriptChunks = new Set();     // chunks this script subscribed to
const chunkTouched = new Map();     // script chunk key -> tick of last use (for LRU pruning)
let touchTick = 0;
const scriptSent = new WeakSet();   // outgoing frames this script created
const seenEvents = new WeakSet();   // MessageEvents already copied

let gameSocket = null;
let view = null;                    // last position the game reported (chunk + cell)
let queue = Promise.resolve();      // frames are processed strictly in order
let holdChain = Promise.resolve(), holdBusy = 0;    // held outgoing messages (click mode)
let pendingClick = null, guardUntil = 0, epoch = 0; // click-mode state
let disposed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Counters for boardStatus(): shows whether frames are actually being processed
const stats = {
  sent: 0, received: 0, snapshots: 0, patches: 0, patchesForUnloadedChunks: 0,
  detached: 0, errors: 0, lastError: null, score: null, lastPoints: null,
  clicksExact: 0, clicksCorrected: 0, clickTimeouts: 0, clickFallbacks: 0, gameActionsBlocked: 0,
};

// Keep the pristine browser functions across re-pastes so hooks never stack
const g = globalThis;
g.__msbotOriginals ??= {
  send: WebSocket.prototype.send,
  messageData: Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get,
};
const ORIGINAL = g.__msbotOriginals;
const _origSend = ORIGINAL.send;

// A previous paste of this file keeps running otherwise: stop it first
g.__msbot?.dispose?.('replaced by a newer paste');

const listeners = new AbortController();    // all DOM listeners this copy installs
const listenerOpts = { capture: true, signal: listeners.signal };

// Unhook everything. Called automatically when the file is re-pasted.
function dispose(reason = 'disposed') {
  if (disposed) return;
  disposed = true;
  stopRequested = true;                     // let any running solver finish its action and stop
  WebSocket.prototype.send = ORIGINAL.send;
  Object.defineProperty(MessageEvent.prototype, 'data',
    { configurable: true, enumerable: true, get: ORIGINAL.messageData });
  listeners.abort();
  console.log(`[msbot] ${reason}`);
}

// ===========================================================================
// 5. SOCKET HOOK
// ===========================================================================

WebSocket.prototype.send = function (data) {
  if (this.url.includes(config.net.socketUrlMatch) && gameSocket !== this) {
    gameSocket = this;
    // Backup reader: touching ev.data triggers the capture hook below
    this.addEventListener('message', (ev) => ev.data, listenerOpts);
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
Object.defineProperty(MessageEvent.prototype, 'data', {
  configurable: true,
  enumerable: true,
  get() {
    const d = ORIGINAL.messageData.call(this);
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

// Send a frame this script built. It goes through the hook above, which logs it
// as a script action; scriptSent marks it so it is not mistaken for your click.
async function sendScript(bytes) {
  if (!gameSocket) throw new Error(NO_SOCKET);
  const gz = await gzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  scriptSent.add(gz);
  gameSocket.send(gz);
}

// ===========================================================================
// 6. PROTOBUF (hand-rolled: only the few field types the game uses)
// ===========================================================================

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
const chunkKey = (cx, cy) => `${cx},${cy}`;

// ===========================================================================
// 7. GZIP (every frame in both directions is gzipped)
// ===========================================================================

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ===========================================================================
// 8. MESSAGE HANDLERS
// ===========================================================================

function handleIncoming(type, body) {
  if (type === 19) {                         // your profile, sent on connect
    const o = toObj(body);
    if (typeof o[5] === 'number') stats.score = o[5];
  } else if (type === 8) {                    // result of one of your actions
    const o = toObj(body);
    if (o[6] instanceof Uint8Array) { const r = toObj(o[6]); stats.score = r[1]; stats.lastPoints = r[2]; }
  } else if (type === 29) {                   // full chunk snapshots
    for (const [f, entry] of fields(body)) {
      if (f !== 1) continue;
      const o = toObj(entry);
      const [cx, cy] = readChunk(o[1]);
      if (o[3] && o[3].length === CHUNK * CHUNK) {
        chunks.set(chunkKey(cx, cy), Uint8Array.from(o[3]));
        stats.snapshots++;
      }
    }
  } else if (type === 16) {                   // live patches: rectangles of new cell bytes
    let grid = null;
    for (const [f, v] of fields(body)) {
      if (f === 1) grid = chunks.get(chunkKey(...readChunk(v)));
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
  if (type === 4) {                           // an action (flag / reveal / chord)
    logAction(body, source);
    if (source === 'manual') learnFromManualClick(body);
  } else if (type === 12) {                   // subscribe: untouched chunks get no snapshot
    for (const [f, v] of fields(body)) {
      if (f !== 1) continue;
      const k = chunkKey(...readChunk(v));
      if (!chunks.has(k)) chunks.set(k, new Uint8Array(CHUNK * CHUNK));
      if (source === 'manual') gameSubs.add(k);
    }
  } else if (type === 13) {                   // unsubscribe: no more updates, forget it
    for (const [f, v] of fields(body)) {
      if (f !== 1) continue;
      const k = chunkKey(...readChunk(v));
      if (source === 'manual') gameSubs.delete(k);
      chunks.delete(k);
    }
  } else if (type === 5) {                    // the game reporting where you are
    const o = toObj(body), [cx, cy] = readChunk(o[1]), idx = o[2] || 0;
    const next = { cx, cy, col: idx % CHUNK, row: Math.floor(idx / CHUNK), w: o[3] || 0, h: o[4] || 0 };
    if (!view || ['cx', 'cy', 'col', 'row', 'w', 'h'].some((k) => view[k] !== next[k])) epoch++;  // view moved
    view = next;
  }
}

// ===========================================================================
// 9. READING THE BOARD
// ===========================================================================

// Raw cell byte: 0 hidden, 1 revealed mine, 2-9 number 0-7, 10+ flag (value-10 = colour)
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

const getCellLocal = (cx, cy, col, row) => describe(chunks.get(chunkKey(cx, cy))?.[row * CHUNK + col]);
const getCell = (x, y) => getCellLocal(...toLocal(x, y));

// Where the game last said you are, in global coordinates
const whereAmI = () => (view ? toGlobal(view.cx, view.cy, view.col, view.row) : null);

// ASCII view: # hidden, . empty, 1-8 numbers, F flag, * mine, ? not loaded
function printArea(x, y, w = config.display.areaWidth, h = config.display.areaHeight) {
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

// ===========================================================================
// 10. CHUNK LOADING
// ===========================================================================

const chunkListMsg = (list) => list.flatMap(([cx, cy]) => bField(1, chunkMsg(cx, cy)));

// Fetch fresh snapshots for a list of [cx, cy] chunks. The server doesn't resend
// snapshots for chunks this connection already watches, so do what the game does
// when scrolling: unsubscribe, then subscribe again.
async function loadChunks(list, { quiet = false } = {}) {
  if (!gameSocket) throw new Error(NO_SOCKET);
  if (!list.length) return;
  const msgList = chunkListMsg(list);
  await sendScript(bField(13, msgList));
  await sendScript(bField(12, [...msgList, ...vField(2, CHUNK)]));
  list.forEach(([cx, cy]) => { scriptChunks.add(chunkKey(cx, cy)); chunkTouched.set(chunkKey(cx, cy), ++touchTick); });
  await sleep(config.board.loadWait);         // give the snapshots time to arrive
  await queue;
  if (!quiet) console.log(`[board] loaded ${list.length} chunks`);
}

// Snapshot the chunks around you (radius in chunks: 1 = the 3x3 block)
async function loadAround(radius = config.board.loadRadius, cx = view?.cx, cy = view?.cy) {
  if (cx === undefined) throw new Error('Position unknown: scroll a little, or pass cx, cy');
  const list = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) list.push([cx + dx, cy + dy]);
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

// Load any missing chunk touching one of these cell rectangles, in one request.
// Every chunk asked for counts as "used" for the LRU, and afterwards the bot
// trims its subscriptions back under memory.maxScriptChunks, never touching
// the chunks it was just asked for.
async function ensureRects(rects) {
  const wanted = new Map();
  for (const [x0, y0, x1, y1] of rects)
    for (const c of chunksIn(x0, y0, x1, y1)) wanted.set(chunkKey(...c), c);
  const need = [...wanted].filter(([k]) => !chunks.has(k)).map(([, c]) => c);
  if (need.length) await loadChunks(need, { quiet: true });
  for (const k of wanted.keys()) if (scriptChunks.has(k)) chunkTouched.set(k, ++touchTick);
  await pruneChunks(new Set(wanted.keys()));
}
const ensureLoaded = (x0, y0, x1, y1) => ensureRects([[x0, y0, x1, y1]]);

// The rectangle a solver pass needs loaded: the area plus its ring of context
const withPadding = ([x0, y0, x1, y1], pad = config.board.solverPadding) =>
  [x0 - pad, y0 - pad, x1 + pad, y1 + pad];

// Tell the server to stop sending these chunks and forget them locally. This is
// what actually frees memory: the server stops pushing patches for them, the
// handler for message 13 drops the cell data, and the game stops receiving them.
async function unsubscribeChunks(keys) {
  if (!keys.length || !gameSocket) return;
  await sendScript(bField(13, chunkListMsg(keys.map((k) => k.split(',').map(Number)))));
  for (const k of keys) { scriptChunks.delete(k); chunkTouched.delete(k); }
}

// Stop watching every chunk the script loaded except those in `keep` (never one
// the game itself is showing), so traffic doesn't grow as the solver travels
const releaseChunks = (keep = new Set()) =>
  unsubscribeChunks([...scriptChunks].filter((k) => !keep.has(k) && !gameSubs.has(k)));

// Keep the script's own subscriptions under memory.maxScriptChunks by releasing
// the least recently used ones. `protect` is a Set of keys that must stay.
async function pruneChunks(protect = new Set()) {
  const cap = config.memory.maxScriptChunks;
  if (!cap || scriptChunks.size <= cap) return 0;
  const drop = [...scriptChunks]
    .filter((k) => !protect.has(k) && !gameSubs.has(k))
    .sort((a, b) => (chunkTouched.get(a) ?? 0) - (chunkTouched.get(b) ?? 0))
    .slice(0, scriptChunks.size - cap);
  await unsubscribeChunks(drop);
  return drop.length;
}

// The chunks around your own view: the ones worth keeping when everything else goes
function viewChunks() {
  const keep = new Set();
  if (view) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keep.add(chunkKey(view.cx + dx, view.cy + dy));
  return keep;
}

// What the bot is holding right now (returned as well as printed)
function memoryStatus({ quiet = false } = {}) {
  const info = {
    chunksInMemory: chunks.size,
    boardBytes: chunks.size * CHUNK * CHUNK,
    subscribedByBot: scriptChunks.size,
    subscribedByGame: gameSubs.size,
    chunkCap: config.memory.maxScriptChunks || 'none',
    actionLogEntries: actionLog.length,
    clickSamples: samples.length,
  };
  const heap = globalThis.performance?.memory;           // Chrome only
  if (heap) info.jsHeapMB = +(heap.usedJSHeapSize / 1048576).toFixed(1);
  if (!quiet) console.table(info);
  return info;
}

// Manual sweep: release everything the bot loaded (except around your view),
// and empty the action log. Board data for released chunks is gone until reloaded.
async function cleanup({ keepView = true } = {}) {
  const before = chunks.size;
  await releaseChunks(keepView ? viewChunks() : new Set());
  actionLog.length = 0;
  stats.lastError = null;
  await queue;                                           // let the unsubscribes drop the data
  console.log(`[memory] released ${before - chunks.size} chunks; ${chunks.size} still in memory`);
  return memoryStatus({ quiet: true });
}

// ===========================================================================
// 11. ACTION LOG
// Every flag/reveal/chord sent (by you or the script) is printed and kept in
// actionLog. Turn printing off with: setConfig({ logging: { actions: false } })
// ===========================================================================

const actionLog = [];

// One outgoing action message (field 4) -> everything useful about it
function decodeAction(body) {
  const o = toObj(body);
  const [cx, cy] = readChunk(o[2]), idx = o[3] || 0;
  const col = idx % CHUNK, row = Math.floor(idx / CHUNK);
  const [x, y] = toGlobal(cx, cy, col, row);
  const flag = o[4] || 0, chord = o[5] || 0;
  return { ts: o[1] || 0, cx, cy, idx, col, row, x, y, flag, chord,
           action: flag === 1 ? 'FLAG' : chord === 1 ? 'CHORD' : 'REVEAL' };
}

function logAction(body, source) {
  const a = decodeAction(body);
  const entry = { time: new Date(a.ts || Date.now()), action: a.action, x: a.x, y: a.y,
                  cx: a.cx, cy: a.cy, col: a.col, row: a.row, source };
  actionLog.push(entry);
  if (actionLog.length > config.logging.maxEntries) actionLog.shift();
  if (config.logging.actions)
    console.log(`[action] ${entry.time.toLocaleTimeString()}  ${a.action.padEnd(6)}  (${a.x}, ${a.y})` +
      `   chunk ${a.cx},${a.cy} col ${a.col} row ${a.row}   [${source}]`);
}

// Print everything logged so far as a table
const showActionLog = () => console.table(actionLog.map(({ time, action, x, y, source }) =>
  ({ time: time.toLocaleTimeString(), action, x, y, source })));

// ===========================================================================
// 12. CLICK MODE
// Instead of sending raw messages, simulate mouse clicks on the board so the game
// runs its normal click handling (score, animations, sounds...). The script learns
// where cells are on screen from your own clicks, and every action the game sends
// in response to a simulated click is checked before it goes out: if the click
// landed on the wrong cell, the message is corrected to the intended cell (keeping
// the game's request id), so a misclick can never act on the wrong cell.
// Off by default (it didn't fix the score display); turn on with:
//   setConfig({ click: { enabled: true } })
// ===========================================================================

let boardEl = null;          // the element your clicks land on (learned)
let lastPointer = null;      // your last real pointerdown
let calib = null;            // { s, ox, oy, epoch, vx, vy }: screen = o + (cell + 0.5) * s
const samples = [];          // { px, py, x, y, epoch }: screen point -> cell it hit
let consecutiveTimeouts = 0;

// Learn from your real clicks; also detect the view moving (drag / wheel)
window.addEventListener('pointerdown', (e) => {
  if (e.isTrusted) lastPointer = { px: e.clientX, py: e.clientY, t: Date.now(), el: e.target, epoch };
}, listenerOpts);
window.addEventListener('pointermove', (e) => {
  if (e.isTrusted && e.buttons && lastPointer &&
      Math.hypot(e.clientX - lastPointer.px, e.clientY - lastPointer.py) > config.click.dragThreshold) epoch++;
}, listenerOpts);
window.addEventListener('wheel', (e) => { if (e.isTrusted) epoch++; }, listenerOpts);
window.addEventListener('resize', () => epoch++, listenerOpts);

function addSample(px, py, x, y, ep) {
  samples.push({ px, py, x, y, epoch: ep });
  while (samples.length > config.click.maxSamples) samples.shift();
  fitCalibration();
}

function learnFromManualClick(body) {
  const p = lastPointer;
  if (!p || pendingClick) return;
  const a = decodeAction(body);
  if (a.ts < p.t - config.click.matchBefore || a.ts - p.t > config.click.matchAfter) return;   // not from that click
  boardEl = p.el;
  lastPointer = null;
  addSample(p.px, p.py, a.x, a.y, p.epoch);
}

// Cell size guess before we have 2+ samples: board width / cells across (from the
// game's view messages). Only a starting point; real clicks refine it.
function priorCellSize() {
  if (calib?.s) return calib.s;
  if (boardEl && view?.w) return boardEl.getBoundingClientRect().width / view.w;
  return null;
}

function fitCalibration() {
  const cur = samples.filter((q) => q.epoch === epoch).slice(-config.click.fitSamples);
  let s = priorCellSize();
  if (cur.length >= 2) {                     // least-squares slope over both axes
    const mx = cur.reduce((a, q) => a + q.x, 0) / cur.length, my = cur.reduce((a, q) => a + q.y, 0) / cur.length;
    const mpx = cur.reduce((a, q) => a + q.px, 0) / cur.length, mpy = cur.reduce((a, q) => a + q.py, 0) / cur.length;
    let num = 0, den = 0;
    for (const q of cur) {
      num += (q.x - mx) * (q.px - mpx) + (q.y - my) * (q.py - mpy);
      den += (q.x - mx) ** 2 + (q.y - my) ** 2;
    }
    if (den >= config.click.minSpread) s = num / den;
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
  const r = boardEl.getBoundingClientRect(), m = s * config.click.edgeMargin;
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
  const got = await Promise.race([done, sleep(config.click.responseWait).then(() => null)]);
  pendingClick = null;
  if (!got) {
    // The game didn't send anything: block any late action from this click
    pc.done = true;
    guardUntil = Date.now() + config.click.guardAfterTimeout;
    stats.clickTimeouts++;
    if (++consecutiveTimeouts >= config.click.maxTimeouts) {
      config.click.enabled = false;
      console.warn('[click] the game is not responding to simulated clicks; switched to direct messages');
    }
    return false;
  }
  consecutiveTimeouts = 0;
  guardUntil = Date.now() + config.click.guardAfterClick;   // drop duplicate actions from the same click
  addSample(pos.px, pos.py, got.x, got.y, pc.epoch);
  return true;
}

// Decide what to do with a game message sent around a simulated click
async function processHeld(ws, copy) {
  const raw = await gunzip(copy instanceof Blob ? new Uint8Array(await copy.arrayBuffer()) : copy);
  const actionField = [...fields(raw)].find(([t]) => t === 4);
  if (!actionField) return forward(ws, copy, 'manual');        // not an action: pass through
  const a = decodeAction(actionField[1]);
  const pc = pendingClick;
  if (!pc || pc.done) {                     // an action nobody asked for: never send it
    stats.gameActionsBlocked++;
    console.warn(`[click] blocked an unexpected game action at (${a.x}, ${a.y})`);
    return;
  }
  pc.done = true;
  let out = copy;
  if (a.x !== pc.x || a.y !== pc.y || a.flag !== pc.action[0] || a.chord !== pc.action[1]) {
    const [tcx, tcy, col, row] = toLocal(pc.x, pc.y);
    out = await gzip(buildAction(pc.action, tcx, tcy, row * CHUNK + col, a.ts));   // keep request id
    stats.clicksCorrected++;
  } else stats.clicksExact++;
  pc.resolve({ x: a.x, y: a.y });
  forward(ws, out, 'script-click');
}

function forward(ws, bytes, source) {
  enqueue(bytes, handleOutgoing, source);
  _origSend.call(ws, bytes);
}

// ===========================================================================
// 13. ACTIONS
// ===========================================================================

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

const sendAction = (action, chunkX, chunkY, col, row) =>
  sendScript(buildAction(action, chunkX, chunkY, row * CHUNK + col));

// Every action goes through act(): a simulated click when possible (so the game's
// own UI - score, animations - stays in sync), otherwise a direct message.
async function act(action, x, y) {
  if (config.click.enabled && (await clickAction(action, x, y))) return 'click';
  if (config.click.enabled) stats.clickFallbacks++;
  await sendAction(action, ...toLocal(x, y));
  return 'direct';
}

const flagGlobal   = (x, y) => act(ACTION.FLAG, x, y);
const revealGlobal = (x, y) => act(ACTION.REVEAL, x, y);
const chordGlobal  = (x, y) => act(ACTION.CHORD, x, y);
const flagLocal    = (cx, cy, col, row) => flagGlobal(...toGlobal(cx, cy, col, row));
const revealLocal  = (cx, cy, col, row) => revealGlobal(...toGlobal(cx, cy, col, row));
const chordLocal   = (cx, cy, col, row) => chordGlobal(...toGlobal(cx, cy, col, row));

// The game's score display doesn't pick up automated actions, but the server
// sends your current totals whenever the game connects. resyncUI() drops the
// connection so the game reconnects and refreshes its UI, without a page reload.
// The script picks up the new connection by itself.
async function resyncUI() {
  if (!gameSocket) throw new Error(NO_SOCKET);
  const old = gameSocket;
  old.close();
  const deadline = Date.now() + config.net.resyncTimeout;
  while (gameSocket === old && Date.now() < deadline) await sleep(config.net.resyncPoll);
  if (gameSocket === old) {
    console.warn(`[resync] the game did not reconnect within ${config.net.resyncTimeout / 1000} s; reload the page instead`);
    return false;
  }
  await sleep(config.net.resyncSettle);      // let the game resubscribe and snapshots arrive
  await queue;
  console.log('[resync] reconnected; score is now', stats.score ?? '(shown in the game)');
  return true;
}

// ===========================================================================
// 14. SOLVER: DEDUCTION
// Only certain deductions are used - the bot never guesses:
//   1. a number whose mines are all found -> its other hidden neighbours are safe
//   2. a number with exactly as many hidden neighbours as missing mines -> all mines
//   3. subset rule: if A's hidden cells are a subset of B's, the extra cells of B
//      hold exactly (B's missing mines - A's missing mines) mines
// Flags and revealed mines (byte 1) both count as known mines.
// ===========================================================================

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

const planSize = (p) => p.flags.length + p.chords.length + p.reveals.length;

// ===========================================================================
// 15. SOLVER: ONE AREA
// ===========================================================================

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

// One pass over a rectangle: plan, act with a delay between actions, then check
// the results against the board once the server has replied.
async function runPass(rect, { delay = config.solver.actionDelay, passWait = config.solver.passWait, quiet = false } = {}) {
  await ensureLoaded(...withPadding(rect));
  const plan = planSolve(...rect);
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
      chordCells.push(...neighbours(x, y)
        .filter(([a, b]) => getCell(a, b).state === 'hidden')
        .map(([a, b]) => cellKey(a, b)));
      await chordGlobal(x, y);
    } else await revealGlobal(x, y);
    done[kind].push(k);
    await sleep(delay);
  }

  // Wait until the board shows every action's result, or passWait runs out
  const openCells = new Set([...done.reveals, ...chordCells]);
  const pendingCount = () =>
    done.flags.filter((k) => getCell(...parseKey(k)).state !== 'flag').length +
    [...openCells].filter((k) => getCell(...parseKey(k)).state === 'hidden').length;
  const waitStart = Date.now();
  do { await sleep(50); await queue; } while (pendingCount() > 0 && Date.now() - waitStart < passWait);

  for (const k of done.flags) {
    const st = getCell(...parseKey(k)).state;
    if (st === 'flag') check.flagged++; else check.notUpdated.push(`flag ${k} -> ${st}`);
  }
  for (const k of openCells) {
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
  try { return await fn(); } finally {
    solving = false;
    if (config.memory.releaseOnFinish)
      await releaseChunks(viewChunks()).catch((e) => console.warn('[memory] release failed:', e));
  }
}
const startPoint = (center) => {
  const c = center ?? whereAmI();
  if (!c) throw new Error('Position unknown: scroll a little first, or pass { center: [x, y] }');
  return c;
};

// One pass over a size x size square around you (or options.center)
async function solveRadius(size = config.solver.passSize,
                           { delay, passWait, dryRun = false, center } = {}) {
  const rect = areaAround(startPoint(center), size);
  if (dryRun) {
    await ensureLoaded(...withPadding(rect));
    const plan = planSolve(...rect);
    console.log(`[solve] area ${rectText(rect)}: ${plan.flags.length} flags, ` +
      `${plan.chords.length} chords, ${plan.reveals.length} reveals`);
    return plan;
  }
  return exclusive(() => runPass(rect, { delay, passWait }));
}

// Repeat passes over the same area until it is solved or no safe move is left
async function areaLoop(rect, { delay, passWait, maxPasses = config.solver.maxPasses, quiet = false } = {}) {
  const total = { passes: 0, flags: 0, chords: 0, reveals: 0 };
  let status = 'max passes reached';
  while (total.passes < maxPasses) {
    if (stopRequested) { status = 'stopped'; break; }
    const { plan, done, check } = await runPass(rect, { delay, passWait, quiet: true });
    if (!planSize(plan)) { status = countHidden(rect) === 0 ? 'solved' : 'stuck (needs a guess)'; break; }
    total.passes++;
    total.flags += done.flags.length; total.chords += done.chords.length; total.reveals += done.reveals.length;
    const sent = done.flags.length + done.chords.length + done.reveals.length;
    if (!quiet) console.log(`[area] pass ${total.passes}: ${done.flags.length} flags, ` +
      `${done.chords.length} chords, ${done.reveals.length} reveals`);
    if (check.hitMine.length) { status = 'hit a mine (stopped to be safe)'; break; }
    if (sent > 0 && check.flagged + check.revealed === 0) { status = 'no progress (actions not taking effect)'; break; }
  }
  const hiddenLeft = countHidden(rect);
  if (!quiet) console.log(`[area] ${rectText(rect)} ${status}: ${total.passes} passes, ${total.flags} flags, ` +
    `${total.chords} chords, ${total.reveals} reveals, ${hiddenLeft} hidden cells left`);
  return { status, ...total, hiddenLeft };
}

async function solveArea(size = config.solver.areaSize,
                         { delay, passWait, maxPasses, center } = {}) {
  const rect = areaAround(startPoint(center), size);
  return exclusive(() => areaLoop(rect, { delay, passWait, maxPasses }));
}

// ===========================================================================
// 16. SOLVER: AUTOSOLVE (area after area)
// ===========================================================================

// 'mostWork': the nearby area with the most guaranteed moves. Candidate areas sit
// on a grid around the current one (step = size - overlap, so neighbours overlap a
// little), searched ring by ring outward. Returns null if nothing nearby has work.
async function pickNextArea(center, size, step, maxRings) {
  let emptyRings = 0;
  for (let ring = 1; ring <= maxRings; ring++) {
    const reach = ring * step + Math.ceil(size / 2) + config.board.solverPadding;
    await ensureLoaded(center[0] - reach, center[1] - reach, center[0] + reach, center[1] + reach);
    let best = null, allEmpty = true;
    for (let j = -ring; j <= ring; j++) for (let i = -ring; i <= ring; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const c = [center[0] + i * step, center[1] + j * step];
      const rect = areaAround(c, size);
      const work = planSize(planSolve(...rect));
      if (work > 0 && (!best || work > best.work)) best = { center: c, work };
      if (allEmpty && !isUntouched(rect)) allEmpty = false;
    }
    if (best) return best;
    if (stopRequested) return null;
    // Nothing but untouched board for several rings in a row: there is nothing out there
    emptyRings = allEmpty ? emptyRings + 1 : 0;
    if (emptyRings >= config.auto.giveUpAfterEmpty) return null;
  }
  return null;
}

// True when nothing in the rectangle has ever been revealed or flagged
const isUntouched = (rect) => countHidden(rect) === (rect[2] - rect[0] + 1) * (rect[3] - rect[1] + 1);

// 'nearest': the closest area to the starting point (on a grid of areas anchored
// there) that still has a guaranteed move. Solved areas are skipped for good;
// stuck ones are skipped until the solver works next to them again.
// Candidates are generated one band at a time (areas whose distance from the
// start, in grid steps, rounds to the same number) instead of all up front, so
// maxRadius = Infinity is fine: the search ends when it finds work, when it
// has seen giveUpAfterEmpty untouched bands in a row, or when stopSolve() is called.
async function pickNearestToStart(start, size, step, areaState, maxRadius) {
  const centerOf = ([i, j]) => [start[0] + i * step, start[1] + j * step];
  let emptyBands = 0;
  for (let band = 0; band <= maxRadius; band++) {
    // Offsets with round(distance) === band lie within +-band on both axes
    const batch = [];
    for (let j = -band; j <= band; j++) for (let i = -band; i <= band; i++) {
      const dist = Math.hypot(i, j);
      if (Math.round(dist) === band && dist <= maxRadius && !areaState.has(`${i},${j}`)) batch.push([i, j]);
    }
    if (!batch.length) continue;
    batch.sort((p, q) => p[0] ** 2 + p[1] ** 2 - (q[0] ** 2 + q[1] ** 2));
    await ensureRects(batch.map((q) => withPadding(areaAround(centerOf(q), size))));
    let allEmpty = true;
    for (const q of batch) {                       // sorted by distance
      const rect = areaAround(centerOf(q), size);
      const work = planSize(planSolve(...rect));
      if (work > 0) return { center: centerOf(q), grid: q, work };
      if (!isUntouched(rect)) allEmpty = false;
      areaState.set(`${q[0]},${q[1]}`, countHidden(rect) === 0 ? 'solved' : 'stuck');
    }
    if (stopRequested) return null;
    emptyBands = allEmpty ? emptyBands + 1 : 0;
    if (emptyBands >= config.auto.giveUpAfterEmpty) return null;
  }
  return null;
}

// Solve an area completely, pick the next area, and repeat.
async function autoSolve(size = config.solver.areaSize, {
  delay, passWait, maxPasses,
  overlap = Math.round(size * config.auto.overlapRatio),
  mode = config.auto.mode,
  maxRings = config.auto.maxRings,
  maxRadius = config.auto.maxRadius,
  maxAreas = config.auto.maxAreas,
  center,
} = {}) {
  const start = startPoint(center);
  let here = start, grid = [0, 0];
  const step = Math.max(1, size - overlap);
  const areaState = new Map();                    // 'nearest' mode: "i,j" -> 'solved' | 'stuck'
  return exclusive(async () => {
    const total = { areas: 0, flags: 0, chords: 0, reveals: 0 };
    const started = Date.now();
    while (total.areas < maxAreas && !stopRequested) {
      const rect = areaAround(here, size);
      const r = await areaLoop(rect, { delay, passWait, maxPasses, quiet: true });
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
      const reach = size + 2 * (step + config.auto.keepMargin);
      const keep = new Set(chunksIn(...areaAround(next.center, reach)).map(([a, b]) => chunkKey(a, b)));
      for (const k of viewChunks()) keep.add(k);
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

// ===========================================================================
// 17. DIAGNOSTICS
// ===========================================================================

// Quick health check: if 'received' grows but 'snapshots'/'patches' stay 0, something is wrong
function boardStatus() {
  const loaded = [...chunks.values()];
  console.table({
    socket: gameSocket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][gameSocket.readyState] : 'not captured',
    ...stats,
    lastError: stats.lastError ? String(stats.lastError) : '',
    chunksLoaded: loaded.length,
    chunksWithRevealedCells: loaded.filter((c) => c.some((v) => v !== 0)).length,
    view: view ? `${whereAmI()} (chunk ${view.cx},${view.cy})` : 'unknown',
    clickMode: config.click.enabled
      ? (calib && boardEl ? 'on, calibrated' : 'on, click one cell manually to calibrate')
      : 'off',
    solving,
  });
}

// ===========================================================================
// 18. PUBLIC API
// Everything below is reachable as msbot.<name>, and the commonly used commands
// are also plain globals so you can type them straight into the console.
// ===========================================================================

const api = {
  // config
  config, DEFAULT_CONFIG, showConfig, setConfig, resetConfig, configDiff,
  // board
  loadAround, loadChunks, ensureLoaded, releaseChunks, pruneChunks, printArea, boardStatus,
  memoryStatus, cleanup,
  getCell, getCellLocal, whereAmI, describe, toLocal, toGlobal, chunksIn, chunks,
  // actions
  revealGlobal, flagGlobal, chordGlobal, revealLocal, flagLocal, chordLocal,
  sendAction, ACTION, resyncUI,
  // solver
  planSolve, solveRadius, solveArea, autoSolve, stopSolve, areaAround, countHidden,
  // logs / internals
  actionLog, showActionLog, stats, dispose,
  get view() { return view; },
  get socket() { return gameSocket; },
};

g.__msbot = api;
g.msbot = api;
for (const name of [
  'loadAround', 'loadChunks', 'printArea', 'boardStatus', 'memoryStatus', 'cleanup', 'getCell', 'whereAmI',
  'revealGlobal', 'flagGlobal', 'chordGlobal', 'revealLocal', 'flagLocal', 'chordLocal',
  'solveRadius', 'solveArea', 'autoSolve', 'stopSolve', 'resyncUI',
  'showActionLog', 'showConfig', 'setConfig', 'resetConfig', 'configDiff',
]) g[name] = api[name];
g.botConfig = config;          // live settings; msbot.config is the same object

console.log('[msbot] ready. Scroll or click once, then: await loadAround(); await autoSolve();\n' +
  '        showConfig() lists every setting, msbot lists every command.');

// Examples:
//   await loadAround(1);                    // snapshot the 3x3 chunks around you
//   whereAmI();                             // -> [x, y] global
//   printArea(...whereAmI(), 40, 20);       // draw part of the board in the console
//   getCell(5798, 1820);                    // -> { state: 'flag', color: 1, raw: 11 }
//   await revealGlobal(5798, 1821);
//   await solveRadius(30);                  // one safe solving pass over a 30x30 square
//   await solveRadius(30, { dryRun: true }); // just show what it would do
//   await solveArea(40);                    // repeat passes until the 40x40 area is done
//   await autoSolve(40);                    // solve area after area, moving to where work is
//   await autoSolve(40, { mode: 'nearest' });// always the closest unfinished area to the start
//   stopSolve();                            // stop any of these after the current action
//   await resyncUI();                       // refresh the game's score display after solving
//   boardStatus();                          // health check if the board looks wrong
//   showActionLog();                        // table of every action sent this session
//   setConfig({ solver: { actionDelay: 120, passWait: 500 } });   // gentler pacing
//   configDiff();                           // what differs from the shipped defaults
//   resetConfig();                          // back to the defaults in section 2
//   msbot.dispose();                        // unhook everything

})();
