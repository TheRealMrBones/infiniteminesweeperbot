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
    passWait: 20,             // ms to wait for the server to confirm a pass's actions before planning the next pass
    confirmTimeout: 3000,     // ms to keep waiting for ANY confirmation before counting a pass as stalled
    maxStalledPasses: 3,      // end the area after this many stalled passes in a row
    maxPasses: 1000,         // give up on an area after this many passes
  },
  auto: {
    mode: 'nearest',         // 'mostWork' = richest nearby area, 'nearest' = closest to the start
    overlapRatio: 0.2,       // neighbouring areas overlap by round(size * this)
    maxRings: Infinity,      // 'mostWork': how many rings of areas to search outward
    maxRadius: Infinity,     // 'nearest': how many areas out from the start to consider
    giveUpAfterEmpty: 3,      // stop looking after this many rings/bands of areas with nothing revealed in them (bounds an Infinity radius)
    maxUnloadedAreas: 3,      // end the run after this many areas in a row whose chunks never loaded
    maxAreas: Infinity,      // stop after this many areas
    keepMargin: 4,           // extra chunks kept loaded around the next area
  },
  board: {
    loadRadius: 1,           // default radius (in chunks) for loadAround()
    loadWait: 500,            // minimum ms to wait after subscribing before deciding the chunks that sent nothing are untouched
    loadQuiet: 300,           // ...and how long (ms) the server must stay silent before deciding that
    loadMaxWait: 5000,        // give up on a load after this long; chunks still missing are treated as unknown, not empty
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
    maxBufferedBytes: 65536, // pause sending while this many bytes still wait in the browser's send buffer
    maxInFlight: 50,         // at most this many actions waiting for the server's answer; sending pauses beyond it (0 = no limit)
    ackTimeout: 5000,        // ms after which an unanswered action is counted as lost
    probeTimeout: 3000,      // ms to wait for the server to answer a connection probe
    autoRecover: true,       // autoSolve(): recover from a dropped or stalled connection instead of ending the run
    stallCooldown: 5000,     // ms to pause before retrying when the server answers but the board stopped updating
    reconnectTimeout: 60000, // ms to wait for the game to reconnect before ending the run
    maxRecoveries: 10,       // end the run after this many recoveries without finishing an area in between
    reconnectSlowdown: 1.5,  // after each recovery, multiply the action delay by this...
    maxActionDelay: 100,     // ...but never raise it above this (ms)
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
    confirmTimeout: 3000,
    maxStalledPasses: 3,
    maxPasses: 1000,
  },
  auto: {
    mode: 'nearest',
    overlapRatio: 0.2,
    maxRings: Infinity,
    maxRadius: Infinity,
    giveUpAfterEmpty: 3,
    maxUnloadedAreas: 3,
    maxAreas: Infinity,
    keepMargin: 4,
  },
  board: {
    loadRadius: 1,
    loadWait: 500,
    loadQuiet: 300,
    loadMaxWait: 5000,
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
    maxBufferedBytes: 65536,
    maxInFlight: 50,
    ackTimeout: 5000,
    probeTimeout: 3000,
    autoRecover: true,
    stallCooldown: 5000,
    reconnectTimeout: 60000,
    maxRecoveries: 10,
    reconnectSlowdown: 1.5,
    maxActionDelay: 100,
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
const pendingSnapshots = new Set(); // chunks asked for whose snapshot hasn't arrived yet
const presumedEmpty = new Set();    // chunks that sent no snapshot before the server went quiet (assumed untouched)
const incompleteChunks = new Set(); // chunks still silent after board.loadMaxWait: unknown, NOT empty
let lastSnapshotAt = 0;             // when the last chunk snapshot arrived
const chunkVersion = new Map();     // chunk key -> version of the tile data last applied (older deltas are dropped)
let stopWhy = '';                   // why the current solver run was asked to stop
let lastRun = null;                 // summary of the last solver run and why it ended
const scriptSent = new WeakSet();   // outgoing frames this script created
const seenEvents = new WeakSet();   // MessageEvents already copied

let gameSocket = null;
let connId = 0;                     // bumped whenever the game connection is lost or replaced
let lastClose = null;               // { code, reason, clean, at } of the last connection that closed
let lastFrameAt = 0;                // when anything last arrived from the server
const inFlight = new Map();         // requestId -> time sent, for the bot's actions the server hasn't answered yet
let lastRequestId = 0;
let probe = null;                   // { resolve } while probeConnection() waits for the server's answer
let view = null;                   // last position the game reported (chunk + cell)
let queue = Promise.resolve();      // frames are processed strictly in order
let holdChain = Promise.resolve(), holdBusy = 0;    // held outgoing messages (click mode)
let pendingClick = null, guardUntil = 0, epoch = 0; // click-mode state
let disposed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Counters for boardStatus(): shows whether frames are actually being processed
const stats = {
  sent: 0, received: 0, snapshots: 0, patches: 0, patchesForUnloadedChunks: 0,
  detached: 0, errors: 0, lastError: null, score: null, lastPoints: null, disconnects: 0, reconnects: 0,
  acksOk: 0, acksRejected: 0, acksLost: 0, staleDeltas: 0, otherResolution: 0,
  chunksPresumedEmpty: 0, chunksIncomplete: 0, clicksExact: 0, clicksCorrected: 0, clickTimeouts: 0, clickFallbacks: 0, gameActionsBlocked: 0,
};

// Keep the pristine browser functions across re-pastes so hooks never stack
const g = globalThis;
g.__msbotOriginals ??= {
  send: WebSocket.prototype.send,
  messageData: Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get,
};
g.__msbotOriginals.WebSocket ??= g.WebSocket;    // (pastes of older versions didn't keep this one)
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
  stopWhy = `the bot was unhooked (${reason})`;
  WebSocket.prototype.send = ORIGINAL.send;
  g.WebSocket = ORIGINAL.WebSocket;
  Object.defineProperty(MessageEvent.prototype, 'data',
    { configurable: true, enumerable: true, get: ORIGINAL.messageData });
  listeners.abort();
  console.log(`[msbot] ${reason}`);
}

// ===========================================================================
// 5. SOCKET HOOK
// ===========================================================================

// Start following a game socket. New connections are picked up the moment the game
// creates them (constructor hook below); the socket that already existed when the
// file was pasted is picked up the first time the game sends on it.
function adoptSocket(ws, how) {
  if (ws === gameSocket) return;
  const replacing = !!gameSocket;
  if (replacing) resetConnection();          // a new connection: nothing from the old one carries over
  gameSocket = ws;
  // Registered before the game sets onmessage, so this reads (and copies) each frame first;
  // for a socket adopted late, touching ev.data triggers the capture hook below instead
  ws.addEventListener('message', (ev) => ev.data, listenerOpts);
  ws.addEventListener('close', (ev) => onSocketClosed(ws, ev), listenerOpts);
  console.log(replacing ? `[net] picked up the game's new connection (${how})`
                        : '[board] socket captured; run loadAround() to fetch your area');
}

// The game opens a fresh WebSocket whenever it reconnects. Waiting for it to send
// something first would miss the switch for a while (in a background tab its first
// message waits for an animation frame that never comes), so catch it at creation.
g.WebSocket = new Proxy(ORIGINAL.WebSocket, {
  construct(target, args, newTarget) {
    const ws = Reflect.construct(target, args, newTarget === g.WebSocket ? target : newTarget);
    try { if (!disposed && String(args[0]).includes(config.net.socketUrlMatch)) adoptSocket(ws, 'created'); }
    catch (e) { console.warn('[net] could not follow the new socket:', e); }
    return ws;
  },
});

WebSocket.prototype.send = function (data) {
  if (this.url.includes(config.net.socketUrlMatch) && gameSocket !== this) adoptSocket(this, 'first message');
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
      lastFrameAt = Date.now();
      enqueue(d, handleIncoming);
    }
    return d;
  },
});

// The server forgets every subscription when a connection ends, and patches sent
// while it was down are lost, so the board kept for it can't be trusted any more.
// Drop it all: the game resubscribes its view on the new connection and the solver
// reloads whatever it needs. Frames still queued from the old connection are skipped.
function resetConnection() {
  connId++;
  chunks.clear(); gameSubs.clear(); scriptChunks.clear(); chunkTouched.clear(); chunkVersion.clear();
  pendingSnapshots.clear(); presumedEmpty.clear(); incompleteChunks.clear(); inFlight.clear();
  probe = null;
}

function onSocketClosed(ws, ev) {
  if (ws !== gameSocket) return;
  stats.disconnects++;
  lastClose = { code: ev.code, reason: ev.reason || '', clean: ev.wasClean, at: new Date() };
  resetConnection();
  console.warn(`[net] game connection closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}); ` +
    'board data dropped until the game reconnects');
}

// 1 = OPEN. Only then can anything be sent.
const socketReady = () => !!gameSocket && gameSocket.readyState === 1;
// Only a socket that is closing or closed counts as disconnected (2 = CLOSING, 3 = CLOSED)
const socketOpen = () => !!gameSocket && gameSocket.readyState !== 2 && gameSocket.readyState !== 3;

// Thrown by anything that needs the connection once it has closed
class Disconnected extends Error {
  constructor() { super('the game connection is closed'); this.name = 'Disconnected'; }
}
const isDisconnect = (e) => e instanceof Disconnected;

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
  const conn = connId;
  queue = queue.then(async () => {
    if (conn !== connId) return;              // from a connection that has since closed
    const bytes = copy instanceof Blob ? new Uint8Array(await copy.arrayBuffer()) : copy;
    const raw = await gunzip(bytes);
    if (conn !== connId) return;
    for (const [type, body] of fields(raw)) handler(type, body, source);
  }).catch((e) => { stats.errors++; stats.lastError = e; console.warn('[board] frame skipped:', e); });
}

// Send a frame this script built. It goes through the hook above, which logs it
// as a script action; scriptSent marks it so it is not mistaken for your click.
// Never writes to a closed socket (the browser only logs a warning and drops it,
// so the solver would carry on blind): it throws Disconnected instead. It also
// waits while the browser's send buffer is backed up, so a slow link can't make
// messages pile up faster than the server takes them.
async function sendScript(bytes) {
  if (!gameSocket) throw new Error(NO_SOCKET);
  if (!socketReady()) throw new Disconnected();
  const gz = await gzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  while (socketReady() && gameSocket.bufferedAmount > config.net.maxBufferedBytes) await sleep(20);
  if (!socketReady()) throw new Disconnected();
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
// The board comes from the game's tile feed (what it draws the board from):
// 12 subscribe / 13 unsubscribe, 15 one full tile, 29 a batch of full tiles,
// 16 a delta. Tiles are sent at the resolution asked for; only resolution 64
// (one byte per cell) is usable, and each tile carries a version so an older
// delta arriving after newer data can be recognised and dropped.
// ===========================================================================

// One full tile (a FullTile message): replaces the chunk
function applyFullTile(b) {
  const o = toObj(b);
  if (!(o[3] instanceof Uint8Array) || o[3].length !== CHUNK * CHUNK) { stats.otherResolution++; return; }
  const k = chunkKey(...readChunk(o[1]));
  chunks.set(k, Uint8Array.from(o[3]));
  chunkVersion.set(k, o[2] || 0);
  pendingSnapshots.delete(k); presumedEmpty.delete(k); incompleteChunks.delete(k);
  lastSnapshotAt = Date.now();
  stats.snapshots++;
}

function handleIncoming(type, body) {
  if (type === 19) {                         // your profile, sent on connect
    const o = toObj(body);
    if (typeof o[5] === 'number') stats.score = o[5];
  } else if (type === 8) {                    // the server's answer to an action: 1 requestId, 2 ok
    const o = toObj(body);
    if (o[6] instanceof Uint8Array) { const r = toObj(o[6]); stats.score = r[1]; stats.lastPoints = r[2]; }
    if (o[1] !== undefined && inFlight.delete(o[1])) {
      if (o[2] === 1) stats.acksOk++; else stats.acksRejected++;
    }
  } else if (type === 22) {                   // seeds, sent back for a seed request (used as a ping)
    probe?.resolve();
  } else if (type === 29) {                   // a batch of full tiles
    for (const [f, entry] of fields(body)) if (f === 1) applyFullTile(entry);
  } else if (type === 15) {                   // a single full tile
    applyFullTile(body);
  } else if (type === 16) {                   // a delta: 1 tile, 2 version, 3 rects, 4 resolution
    let k = null, version = 0, resolution = CHUNK;
    const rects = [];
    for (const [f, v] of fields(body)) {
      if (f === 1) k = chunkKey(...readChunk(v));
      else if (f === 2) version = v;
      else if (f === 3) rects.push(v);
      else if (f === 4) resolution = v || CHUNK;
    }
    if (resolution !== CHUNK) { stats.otherResolution++; return; }   // the game zoomed out: not cell data
    const grid = chunks.get(k);
    if (!grid) { stats.patchesForUnloadedChunks += rects.length; return; }
    if (version && version <= (chunkVersion.get(k) ?? 0)) { stats.staleDeltas++; return; }
    for (const v of rects) {
      stats.patches++;
      const r = toObj(v), x = r[1] || 0, y = r[2] || 0, w = r[3] || 0, h = r[4] || 0;
      const data = r[5] instanceof Uint8Array ? r[5] : new Uint8Array(0);
      for (let i = 0; i < data.length && i < w * h; i++)
        grid[(y + Math.floor(i / w)) * CHUNK + x + (i % w)] = data[i];
    }
    if (version) chunkVersion.set(k, version);
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
      if (source === 'manual') { gameSubs.delete(k); presumedEmpty.delete(k); incompleteChunks.delete(k); }
      chunks.delete(k); chunkVersion.delete(k);
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
// when scrolling: unsubscribe, then subscribe again. Then wait for the data (see
// waitForSnapshots). `patient` waits longer, for re-checks.
async function loadChunks(list, { quiet = false, patient = false } = {}) {
  if (!gameSocket) throw new Error(NO_SOCKET);
  if (!list.length) return { arrived: 0, presumedEmpty: 0, incomplete: 0 };
  const keys = list.map(([cx, cy]) => chunkKey(cx, cy));
  keys.forEach((k) => { pendingSnapshots.add(k); presumedEmpty.delete(k); });
  try {
    const msgList = chunkListMsg(list);
    await sendScript(bField(13, msgList));
    await sendScript(bField(12, [...msgList, ...vField(2, CHUNK)]));
  } catch (e) {
    keys.forEach((k) => pendingSnapshots.delete(k));
    throw e;
  }
  keys.forEach((k) => { scriptChunks.add(k); chunkTouched.set(k, ++touchTick); });
  const result = await waitForSnapshots(keys, { patient });
  if (result.incomplete)
    console.warn(`[board] ${result.incomplete} of ${list.length} chunks sent nothing within ${config.board.loadMaxWait} ms; ` +
      'treating them as unknown (not empty) until they load');
  if (!quiet) console.log(`[board] loaded ${list.length} chunks (${result.arrived} with data)`);
  return result;
}

// The server sends no snapshot for a chunk nobody has touched, and a chunk that
// has one may be slow, so "nothing yet" is ambiguous. The wait ends when:
//   - every chunk has its snapshot; or
//   - at least board.loadWait ms passed AND no snapshot arrived for board.loadQuiet ms:
//     the chunks still silent are presumed untouched (remembered in presumedEmpty so a
//     final re-check can double-check them); or
//   - board.loadMaxWait ms passed: the silent chunks are marked incomplete, which means
//     UNKNOWN. The solver never treats an incomplete chunk as empty or "stuck".
async function waitForSnapshots(keys, { patient = false } = {}) {
  const { loadWait, loadQuiet, loadMaxWait } = config.board;
  const minWait = patient ? loadWait * 2 : loadWait, quiet = patient ? loadQuiet * 3 : loadQuiet;
  const t0 = Date.now();
  const silent = () => keys.filter((k) => pendingSnapshots.has(k));
  for (;;) {
    await sleep(25);
    if (!socketOpen()) throw new Disconnected();          // nothing more will arrive
    await queue;                                          // process frames that already arrived
    const now = Date.now(), left = silent();
    let outcome = null;
    if (!left.length) outcome = 'all';
    else if (now - t0 >= loadMaxWait) outcome = 'incomplete';
    else if (now - t0 >= minWait && now - Math.max(lastSnapshotAt, t0) >= quiet) outcome = 'quiet';
    if (!outcome) continue;
    for (const k of left) {
      pendingSnapshots.delete(k);
      if (outcome === 'incomplete') { incompleteChunks.add(k); stats.chunksIncomplete++; }
      else { presumedEmpty.add(k); stats.chunksPresumedEmpty++; }
    }
    return { arrived: keys.length - left.length,
             presumedEmpty: outcome === 'quiet' ? left.length : 0,
             incomplete: outcome === 'incomplete' ? left.length : 0 };
  }
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
// With the connection closed there is nothing to tell the server (it already forgot
// every subscription), so only the local bookkeeping is cleared.
async function unsubscribeChunks(keys) {
  if (!keys.length || !gameSocket) return;
  if (socketReady()) {
    await sendScript(bField(13, chunkListMsg(keys.map((k) => k.split(',').map(Number)))))
      .catch((e) => { if (!isDisconnect(e)) throw e; });
  }
  for (const k of keys) {
    scriptChunks.delete(k); chunkTouched.delete(k);
    pendingSnapshots.delete(k); presumedEmpty.delete(k); incompleteChunks.delete(k);
  }
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

// A rectangle is "settled" when none of the chunks it needs is incomplete, i.e. what
// the board shows there can be trusted. Unsettled areas are never marked stuck/empty.
const isSettled = (rect) => !chunksIn(...withPadding(rect)).some(([cx, cy]) => incompleteChunks.has(chunkKey(cx, cy)));

// True when nothing in the rectangle has ever been revealed or flagged
const isUntouched = (rect) => countHidden(rect) === (rect[2] - rect[0] + 1) * (rect[3] - rect[1] + 1);

// Ask again, patiently, for the chunks a rectangle needs that never sent data
async function reloadUnsettled(rect) {
  const list = chunksIn(...withPadding(rect)).filter(([cx, cy]) => incompleteChunks.has(chunkKey(cx, cy)));
  if (list.length) await loadChunks(list, { quiet: true, patient: true });
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

// The server answers every action (message 8) quoting its request id, so the bot
// knows how many of its actions are still being worked on. Ids are made unique
// (two actions in the same millisecond would otherwise share one).
const nextRequestId = () => (lastRequestId = Math.max(Date.now(), lastRequestId + 1));

// Actions unanswered after net.ackTimeout are given up on (Map order = send order)
function expireAcks() {
  const cutoff = Date.now() - config.net.ackTimeout;
  for (const [id, at] of inFlight) {
    if (at >= cutoff) break;
    inFlight.delete(id);
    stats.acksLost++;
  }
}

// Flow control: when the server falls behind, wait for it instead of piling more
// actions onto its queue (that backlog is what makes a long run grind to a halt)
async function waitForAckRoom() {
  while (config.net.maxInFlight) {
    expireAcks();
    if (inFlight.size < config.net.maxInFlight || stopRequested) return;
    if (!socketReady()) throw new Disconnected();
    await sleep(10);
  }
}

async function sendAction(action, chunkX, chunkY, col, row) {
  await waitForAckRoom();
  const id = nextRequestId();
  inFlight.set(id, Date.now());
  try {
    await sendScript(buildAction(action, chunkX, chunkY, row * CHUNK + col, id));
  } catch (e) {
    inFlight.delete(id);
    throw e;
  }
  return id;
}

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

// Is the server still answering? Asks for one chunk's seed (the game does this all
// the time and the reply is harmless) and times the answer. Frames from other
// players keep arriving even when the server has stopped handling this
// connection's requests, so only a direct answer counts.
async function probeConnection(timeout = config.net.probeTimeout) {
  if (!socketReady()) return { ok: false, why: 'the socket is not open' };
  const [cx, cy] = view ? [view.cx, view.cy] : [0, 0];
  let resolve;
  const answered = new Promise((r) => (resolve = r));
  const mine = { resolve };
  probe = mine;
  const t0 = Date.now();
  try {
    await sendScript(bField(21, bField(1, chunkMsg(cx, cy))));
  } catch (e) {
    if (probe === mine) probe = null;
    if (isDisconnect(e)) return { ok: false, why: 'the socket closed' };
    throw e;
  }
  const got = await Promise.race([answered.then(() => true), sleep(timeout).then(() => false)]);
  if (probe === mine) probe = null;
  return got ? { ok: true, rtt: Date.now() - t0 } : { ok: false, why: `no answer within ${timeout} ms` };
}

// Health report: socket state, how far behind the server is on the bot's actions,
// and a live probe. Returned as well as printed.
async function checkConnection({ quiet = false } = {}) {
  expireAcks();
  const oldest = inFlight.size ? Date.now() - inFlight.values().next().value : 0;
  const p = await probeConnection();
  const verdict = !socketOpen() ? 'closed: wait for the game to reconnect, or run reconnect()'
    : !p.ok ? 'open but not answering: run reconnect() to start a new connection'
    : oldest > config.net.ackTimeout / 2 ? 'answering, but slow to process actions: raise solver.actionDelay'
    : 'healthy';
  const info = {
    socket: gameSocket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][gameSocket.readyState] : 'not captured',
    probe: p.ok ? `answered in ${p.rtt} ms` : `FAILED (${p.why})`,
    msSinceLastFrame: lastFrameAt ? Date.now() - lastFrameAt : null,
    sendBufferBytes: gameSocket?.bufferedAmount ?? 0,
    actionsAwaitingAnswer: inFlight.size,
    oldestAwaitingMs: oldest,
    acksOk: stats.acksOk, acksRejected: stats.acksRejected, acksLost: stats.acksLost,
    staleDeltasDropped: stats.staleDeltas, otherResolutionTiles: stats.otherResolution,
    disconnects: stats.disconnects, reconnects: stats.reconnects,
    verdict,
  };
  if (!quiet) console.table(info);
  return { ...info, probeOk: p.ok, rtt: p.rtt ?? null, healthy: verdict === 'healthy' };
}

// Start a new connection: close the game's socket; the game reconnects by itself
// (after about a second) and the constructor hook picks the new socket up.
async function reconnect({ timeout = config.net.reconnectTimeout, quiet = false } = {}) {
  if (!gameSocket) throw new Error(NO_SOCKET);
  if (socketOpen()) {
    if (!quiet) console.log('[net] closing the game connection so the game opens a new one');
    try { gameSocket.close(4000, 'msbot: reconnect'); } catch { gameSocket.close(); }
  }
  const ok = await waitForReconnect(timeout);
  if (!quiet) console.log(ok ? '[net] new connection is up' : `[net] the game did not reconnect within ${timeout / 1000} s; reload the page`);
  return ok;
}

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
const stopSolve = () => {
  if (!solving) { console.log('[solve] nothing is running'); return; }
  stopRequested = true;
  stopWhy = 'stopSolve() was called';
  console.log('[solve] stop requested; finishing the action in flight, then ending the run');
};

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
  const noCheck = { flagged: 0, revealed: 0, hitMine: [], notUpdated: [] };
  if (!quiet) console.log(`[solve] area ${rectText(rect)}: ${plan.flags.length} flags, ` +
    `${plan.chords.length} chords, ${plan.reveals.length} reveals` +
    (plan.contradictions ? `, ${plan.contradictions} contradictions skipped` : ''));
  if (!planSize(plan)) return { plan, done, check: noCheck, tally: () => noCheck };

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
  do { await sleep(50); await queue; } while (pendingCount() > 0 && Date.now() - waitStart < passWait && socketOpen());
  if (!socketOpen()) throw new Disconnected();

  // What the board shows of this pass's actions right now (can be called again later)
  const tally = () => {
    const c = { flagged: 0, revealed: 0, hitMine: [], notUpdated: [] };
    for (const k of done.flags) {
      const st = getCell(...parseKey(k)).state;
      if (st === 'flag') c.flagged++; else c.notUpdated.push(`flag ${k} -> ${st}`);
    }
    for (const k of openCells) {
      const st = getCell(...parseKey(k)).state;
      if (st === 'number') c.revealed++;
      else if (st === 'mine') c.hitMine.push(k);
      else c.notUpdated.push(`reveal ${k} -> ${st}`);
    }
    return c;
  };
  const check = tally();
  if (check.hitMine.length) console.warn('[solve] revealed a mine (should never happen):', check.hitMine);
  if (!quiet) {
    console.log(`[solve] sent ${done.flags.length} flags, ${done.chords.length} chords, ${done.reveals.length} reveals ` +
      `(${done.skipped} skipped); board confirms ${check.flagged} flags, ${check.revealed} revealed cells`);
    if (check.notUpdated.length)
      console.warn(`[solve] ${check.notUpdated.length} actions not reflected on the board yet, e.g.`, check.notUpdated.slice(0, 5));
  }
  return { plan, done, check, tally };
}

// Run fn with the "solving" lock held
async function exclusive(fn) {
  if (solving) { console.warn('[solve] already running (stopSolve() to cancel)'); return null; }
  solving = true; stopRequested = false; stopWhy = '';
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

// How an area (or a whole run) can end, in words. Every code is logged with its reason.
const STATUS = {
  solved: 'solved',
  stuck: 'stuck (needs a guess)',
  stopped: 'stopped',
  hitMine: 'hit a mine (stopped to be safe)',
  stalled: 'stalled (actions not taking effect)',
  maxPasses: 'max passes reached',
  unloaded: 'chunks did not load',
  disconnected: 'game connection closed',
};
const WHY = (code) => ({
  stopped: stopWhy || 'stopSolve() was called',
  hitMine: 'a reveal opened a mine, which a safe-move solver should never do, so it stopped. ' +
    'Look at the board around the last actions before running again',
  stalled: `actions were sent but the board never showed any of them taking effect (${config.solver.maxStalledPasses} passes ` +
    `in a row, each given ${config.solver.confirmTimeout} ms). Run checkConnection() to see whether the server still answers; ` +
    'reconnect() starts a new connection. If it keeps happening, try a larger solver.actionDelay',
  disconnected: `the game connection closed${lastClose ? ` (code ${lastClose.code}${lastClose.reason ? `: ${lastClose.reason}` : ''})` : ''}. ` +
    'Wait for the game to reconnect (or reload the page), then run it again',
  unloaded: `the server sent nothing for this area's chunks within board.loadMaxWait (${config.board.loadMaxWait} ms), even after retrying`,
  maxPasses: `solver.maxPasses (${config.solver.maxPasses}) passes were used on this area; it may still have safe moves`,
}[code]);

// Wait for the game to open a new connection (it reconnects by itself; the send hook
// captures the new socket), then give it time to resubscribe its view.
// True once a usable connection is back; false on timeout or stopSolve().
async function waitForReconnect(timeout = config.net.reconnectTimeout) {
  const deadline = Date.now() + timeout;
  while (!socketReady() && !(solving && stopRequested) && Date.now() < deadline) await sleep(config.net.resyncPoll);
  if (!socketReady()) return false;
  await sleep(config.net.resyncSettle);
  await queue;
  if (!socketReady()) return false;
  stats.reconnects++;
  return true;
}

// After a pass that confirmed nothing, keep looking for ANY sign of life for up to
// solver.confirmTimeout before calling it a stall (a lag spike is not a failure)
async function awaitConfirmation(pass) {
  const until = Date.now() + config.solver.confirmTimeout;
  let check = pass.tally();
  while (check.flagged + check.revealed === 0 && !check.hitMine.length && Date.now() < until && !stopRequested && socketOpen()) {
    await sleep(50);
    await queue;
    check = pass.tally();
  }
  return check;
}

// Repeat passes over the same area until it is solved or no safe move is left.
// Returns { code, status, passes, flags, chords, reveals, hiddenLeft }; `code` is a key of STATUS.
async function areaLoop(rect, { delay, passWait, maxPasses = config.solver.maxPasses, quiet = false } = {}) {
  const total = { passes: 0, flags: 0, chords: 0, reveals: 0 };
  let code = 'maxPasses', stalled = 0, reloads = 0, refreshes = 0;
  try {
    while (total.passes < maxPasses) {
      if (stopRequested) { code = 'stopped'; break; }
      if (!socketOpen()) { code = 'disconnected'; break; }
      const acks0 = { ok: stats.acksOk, rejected: stats.acksRejected };
      const pass = await runPass(rect, { delay, passWait, quiet: true });
      const { plan, done } = pass;
      let { check } = pass;
      if (!planSize(plan)) {
        if (!isSettled(rect)) {              // no moves, but only because some chunks never sent data
          if (reloads++ < 2) { await reloadUnsettled(rect); continue; }
          code = 'unloaded'; break;
        }
        code = countHidden(rect) === 0 ? 'solved' : 'stuck';
        break;
      }
      total.passes++;
      total.flags += done.flags.length; total.chords += done.chords.length; total.reveals += done.reveals.length;
      const sent = done.flags.length + done.chords.length + done.reveals.length;
      if (!quiet) console.log(`[area] pass ${total.passes}: ${done.flags.length} flags, ` +
        `${done.chords.length} chords, ${done.reveals.length} reveals`);
      if (sent > 0 && !check.hitMine.length && check.flagged + check.revealed === 0) {
        check = await awaitConfirmation(pass);
        if (!socketOpen()) { code = 'disconnected'; break; }   // not a stall: the connection went away
        if (check.flagged + check.revealed === 0 && !check.hitMine.length) {
          // The server answered these actions but the board never showed them: the
          // bot's copy of the board stopped updating, not the connection. Fetch it again.
          const ok = stats.acksOk - acks0.ok, rejected = stats.acksRejected - acks0.rejected;
          if (ok + rejected > 0 && refreshes < config.solver.maxStalledPasses) {
            refreshes++;
            console.warn(`[area] pass ${total.passes}: the server answered ${ok + rejected} of ${sent} actions ` +
              `(${rejected} rejected) but the board didn't change; reloading this area's chunks ` +
              `(${refreshes} of ${config.solver.maxStalledPasses})`);
            await loadChunks(chunksIn(...withPadding(rect)), { quiet: true });
            continue;
          }
          if (++stalled >= config.solver.maxStalledPasses) { code = 'stalled'; break; }
          console.warn(`[area] pass ${total.passes}: nothing confirmed after ${config.solver.confirmTimeout} ms ` +
            `(stalled pass ${stalled} of ${config.solver.maxStalledPasses}); planning again`);
          continue;
        }
      }
      stalled = 0; refreshes = 0;
      if (check.hitMine.length) { code = 'hitMine'; break; }
    }
  } catch (e) {
    if (!isDisconnect(e)) throw e;
    code = 'disconnected';                   // actions of the interrupted pass are not counted
  }
  const hiddenLeft = countHidden(rect);
  const status = STATUS[code];
  if (!quiet) {
    console.log(`[area] ${rectText(rect)} ${status}: ${total.passes} passes, ${total.flags} flags, ` +
      `${total.chords} chords, ${total.reveals} reveals, ${hiddenLeft} hidden cells left`);
    if (WHY(code)) console.warn(`[area] why: ${WHY(code)}`);
  }
  return { code, status, ...total, hiddenLeft };
}

async function solveArea(size = config.solver.areaSize,
                         { delay, passWait, maxPasses, center } = {}) {
  const rect = areaAround(startPoint(center), size);
  return exclusive(async () => {
    const r = await areaLoop(rect, { delay, passWait, maxPasses });
    lastRun = { command: 'solveArea', endReason: r.code, detail: WHY(r.code) ?? r.status, endedAt: new Date(), ...r };
    return r;
  });
}

// ===========================================================================
// 16. SOLVER: AUTOSOLVE (area after area)
// ===========================================================================

// The pickers return either an area to work on ({ center, work, ... }) or, when the
// search is over, { end: <reason code>, detail: <sentence> } so autoSolve can say why.

// Before giving up on a stretch of board that looks blank, ask again (patiently) for
// the chunks in it that were slow to answer: "no data yet" must not read as "empty".
async function recheckSlowChunks(cands) {
  const list = new Map();
  for (const c of cands) for (const [cx, cy] of chunksIn(...withPadding(c.rect))) {
    const k = chunkKey(cx, cy);
    if (presumedEmpty.has(k) || incompleteChunks.has(k)) list.set(k, [cx, cy]);
  }
  if (!list.size) return { found: null, rechecked: 0 };
  console.log(`[auto] about to give up; re-checking ${list.size} chunks that were slow to answer`);
  await loadChunks([...list.values()], { quiet: true, patient: true });
  for (const c of cands) {
    if (stopRequested) break;
    const work = planSize(planSolve(...c.rect));
    if (work > 0) return { found: c.result(work), rechecked: list.size };
  }
  return { found: null, rechecked: list.size };
}

// The search met `dead` blank (or unverifiable) rings/bands in a row
async function blankEnd(unit, dead, cells, recent) {
  const re = await recheckSlowChunks(recent);
  if (re.found) return re.found;
  const shaky = recent.some((c) => !isSettled(c.rect));
  const base = `${dead} ${unit}s of areas in a row (about ${cells} cells out) had `;
  if (shaky) return { end: 'chunksNotLoading', detail: base + 'no chunk data that could be trusted: the server ' +
    'sent nothing for some chunks even after re-checking. Check the connection and boardStatus()' };
  return { end: 'blankGap', detail: base + `nothing revealed in them, so the search stopped (auto.giveUpAfterEmpty = ` +
    `${config.auto.giveUpAfterEmpty}); raise it to search across wider gaps` +
    (re.rechecked ? ` [re-checked ${re.rechecked} slow chunks first]` : '') };
}

// 'mostWork': the nearby area with the most guaranteed moves. Candidate areas sit
// on a grid around the current one (step = size - overlap, so neighbours overlap a
// little), searched ring by ring outward.
async function pickNextArea(center, size, step, maxRings) {
  let deadRings = 0, recent = [];
  for (let ring = 1; ring <= maxRings; ring++) {
    const reach = ring * step + Math.ceil(size / 2) + config.board.solverPadding;
    await ensureLoaded(center[0] - reach, center[1] - reach, center[0] + reach, center[1] + reach);
    let best = null, live = false;
    const areas = [];
    for (let j = -ring; j <= ring; j++) for (let i = -ring; i <= ring; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const c = [center[0] + i * step, center[1] + j * step];
      const rect = areaAround(c, size);
      const work = planSize(planSolve(...rect));
      if (work > 0 && (!best || work > best.work)) best = { center: c, work };
      if (isSettled(rect) && !isUntouched(rect)) live = true;    // real, trustworthy board data
      areas.push({ rect, result: (w) => ({ center: c, work: w }) });
    }
    if (best) return best;
    if (stopRequested) return { end: 'stopped', detail: WHY('stopped') };
    if (live) { deadRings = 0; recent = []; } else { deadRings++; recent.push(...areas); }
    if (deadRings >= config.auto.giveUpAfterEmpty) return blankEnd('ring', deadRings, ring * step, recent);
  }
  return { end: 'ringLimit', detail: `searched ${maxRings} rings around the last area and none has a safe move (auto.maxRings)` };
}

// 'nearest': the closest area to the starting point (on a grid of areas anchored
// there) that still has a guaranteed move. Solved areas are skipped for good;
// stuck ones are skipped until the solver works next to them again. Only areas
// whose content was really seen are remembered: an all-hidden area, or one whose
// chunks never finished loading, could just be data that hasn't arrived.
// Candidates are examined one distance band at a time (areas whose distance from
// the start, in grid steps, rounds to the same number), never listed up front, so
// maxRadius = Infinity is fine.
async function pickNearestToStart(start, size, step, areaState, maxRadius) {
  const centerOf = ([i, j]) => [start[0] + i * step, start[1] + j * step];
  let deadBands = 0, recent = [];
  for (let band = 0; band <= maxRadius; band++) {
    // Offsets with round(distance) === band lie within +-band on both axes
    const batch = [];
    let known = 0;
    for (let j = -band; j <= band; j++) for (let i = -band; i <= band; i++) {
      const dist = Math.hypot(i, j);
      if (Math.round(dist) !== band || dist > maxRadius) continue;
      if (areaState.has(`${i},${j}`)) known++; else batch.push([i, j]);
    }
    if (!batch.length) { deadBands = 0; recent = []; continue; }     // a band of known areas is real board
    batch.sort((p, q) => p[0] ** 2 + p[1] ** 2 - (q[0] ** 2 + q[1] ** 2));
    await ensureRects(batch.map((q) => withPadding(areaAround(centerOf(q), size))));
    let live = known > 0;
    const areas = [];
    for (const q of batch) {                       // sorted by distance
      const rect = areaAround(centerOf(q), size);
      const work = planSize(planSolve(...rect));
      if (work > 0) return { center: centerOf(q), grid: q, work };
      if (isSettled(rect) && !isUntouched(rect)) {
        live = true;
        areaState.set(`${q[0]},${q[1]}`, countHidden(rect) === 0 ? 'solved' : 'stuck');
      }
      areas.push({ rect, result: (w) => ({ center: centerOf(q), grid: q, work: w }) });
    }
    if (stopRequested) return { end: 'stopped', detail: WHY('stopped') };
    if (live) { deadBands = 0; recent = []; } else { deadBands++; recent.push(...areas); }
    if (deadBands >= config.auto.giveUpAfterEmpty) return blankEnd('band', deadBands, Math.round(band * step), recent);
  }
  return { end: 'radiusLimit', detail: `every area within ${maxRadius} steps (about ${Math.round(maxRadius * step)} cells) ` +
    'of the start has been checked and none has a safe move (auto.maxRadius)' };
}

// Solve an area completely, pick the next area, and repeat. Whenever a run ends, the
// console says so on an "[auto] ENDED (<reason>)" line and msbot.lastRun keeps the summary:
//   stopped         stopSolve() was called (or the bot was unhooked)
//   maxAreas        the requested number of areas was done
//   hitMine         a reveal opened a mine (should never happen)
//   stalled         actions were sent but the board never reflected them
//   disconnected    the game WebSocket closed
//   chunksNotLoading  the server sent no data for chunks it should have
//   blankGap        the search met auto.giveUpAfterEmpty blank rings/bands in a row
//   radiusLimit / ringLimit   everything within auto.maxRadius / auto.maxRings was checked
//   error           an exception was thrown
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
    const total = { areas: 0, flags: 0, chords: 0, reveals: 0, recoveries: 0 };
    const started = Date.now();
    let end = { reason: 'error', detail: 'an exception was thrown (see the error above)' };
    let unloadedRow = 0;
    let pace = delay ?? config.solver.actionDelay;  // ms between actions; slowed down after each reconnect
    let recoveriesInRow = 0;                        // since the last area that finished normally

    // The connection dropped or stalled. Work out which, fix it, and carry on more gently:
    //   dropped                    -> wait for the game to reconnect
    //   stalled, server answers    -> the board feed went stale: reload it after a short cool-down
    //   stalled, server silent     -> the connection is dead in all but name: start a new one
    // Returns false (and sets `end`) when the run has to stop instead.
    const recover = async (kind) => {
      const { autoRecover, maxRecoveries, reconnectTimeout, reconnectSlowdown, maxActionDelay, stallCooldown } = config.net;
      end = { reason: kind, detail: WHY(kind) };
      if (!autoRecover) return false;
      if (recoveriesInRow >= maxRecoveries) {
        end.detail += ` [gave up after ${recoveriesInRow} recoveries in a row without finishing an area (net.maxRecoveries)]`;
        return false;
      }
      recoveriesInRow++;
      const attempt = `(attempt ${recoveriesInRow} of ${maxRecoveries})`;
      if (kind === 'stalled' && socketReady()) {
        const p = await probeConnection();
        if (p.ok) {
          console.warn(`[auto] stalled, but the server answers (${p.rtt} ms): reloading the board after ` +
            `${stallCooldown / 1000} s ${attempt}`);
          await releaseChunks(viewChunks());
          await sleep(stallCooldown);
        } else {
          console.warn(`[auto] stalled and the server did not answer a probe (${p.why}): starting a new connection ${attempt}`);
          try { gameSocket.close(4000, 'msbot: unresponsive'); } catch { gameSocket.close(); }
        }
      }
      if (!socketReady()) {
        if (kind === 'disconnected')
          console.warn(`[auto] connection lost; waiting up to ${reconnectTimeout / 1000} s for the game to reconnect ${attempt}`);
        if (!(await waitForReconnect())) {
          if (stopRequested) end = { reason: 'stopped', detail: WHY('stopped') };
          else end.detail += ` [the game did not reconnect within ${reconnectTimeout / 1000} s (net.reconnectTimeout)]`;
          return false;
        }
      }
      if (stopRequested) { end = { reason: 'stopped', detail: WHY('stopped') }; return false; }
      total.recoveries++;
      pace = Math.max(pace, Math.min(maxActionDelay, Math.max(pace + 5, Math.round(pace * reconnectSlowdown))));
      console.log(`[auto] recovered; resuming around ${here} with ${pace} ms between actions`);
      return true;
    };

    try {
      for (;;) {
        const rect = areaAround(here, size);
        const r = await areaLoop(rect, { delay: pace, passWait, maxPasses, quiet: true });
        total.flags += r.flags; total.chords += r.chords; total.reveals += r.reveals;
        if (r.code === 'disconnected' || r.code === 'stalled') {   // fix the connection, then redo this area
          console.log(`[auto] area ${total.areas + 1} ${rectText(rect)}: ${r.status}; ` +
            `${r.flags} flags, ${r.chords} chords, ${r.reveals} reveals so far`);
          if (await recover(r.code)) continue;
          total.areas++;                            // the run ends on it: it still counts as worked on
          break;
        }
        total.areas++;
        console.log(`[auto] area ${total.areas} ${rectText(rect)}: ${r.status}; ` +
          `${r.flags} flags, ${r.chords} chords, ${r.reveals} reveals (totals: ${total.flags} flags, ` +
          `${total.chords} chords, ${total.reveals} reveals)`);
        if (['hitMine', 'stopped'].includes(r.code)) { end = { reason: r.code, detail: WHY(r.code) }; break; }
        if (r.code === 'maxPasses') console.warn(`[auto] ${WHY('maxPasses')}`);
        unloadedRow = r.code === 'unloaded' ? unloadedRow + 1 : 0;
        if (unloadedRow >= config.auto.maxUnloadedAreas) {
          end = { reason: 'chunksNotLoading', detail: `${unloadedRow} areas in a row got no chunk data from the server: ${WHY('unloaded')}. ` +
            'Check the connection and boardStatus()' };
          break;
        }
        if (total.areas >= maxAreas) { end = { reason: 'maxAreas', detail: `reached the requested limit of ${maxAreas} areas` }; break; }

        if (mode === 'nearest') {
          if (r.code !== 'unloaded') areaState.set(`${grid[0]},${grid[1]}`, r.code === 'solved' ? 'solved' : 'stuck');
          // Work done here may unblock the overlapping neighbours: check them again
          if (r.flags + r.chords + r.reveals > 0)
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
              const k = `${grid[0] + di},${grid[1] + dj}`;
              if ((di || dj) && areaState.get(k) === 'stuck') areaState.delete(k);
            }
        }
        let next;
        try {
          next = mode === 'nearest'
            ? await pickNearestToStart(start, size, step, areaState, maxRadius)
            : await pickNextArea(here, size, step, maxRings);
          if (!next.end) {
            // Keep chunks around the next area and around your own view; drop the rest
            const reach = size + 2 * (step + config.auto.keepMargin);
            const keep = new Set(chunksIn(...areaAround(next.center, reach)).map(([a, b]) => chunkKey(a, b)));
            for (const k of viewChunks()) keep.add(k);
            await releaseChunks(keep);
          }
        } catch (e) {
          if (!isDisconnect(e)) throw e;
          // Lost while searching: once reconnected, the finished area is re-checked
          // (quickly, it has no work left) and the search runs again from there
          if (await recover('disconnected')) continue;
          break;
        }
        if (next.end) { end = { reason: next.end, detail: next.detail }; break; }
        recoveriesInRow = 0;                        // an area was finished and the next one found
        console.log(`[auto] moving to ${next.center} (${next.work} safe moves waiting)`);
        here = next.center;
        if (next.grid) grid = next.grid;
      }
    } finally {
      const minutes = +((Date.now() - started) / 60000).toFixed(1);
      console.log(`[auto] ENDED (${end.reason}) after ${minutes} min: ${end.detail}`);
      console.log(`[auto] totals: ${total.areas} areas, ${total.flags} flags, ${total.chords} chords, ${total.reveals} reveals`);
      lastRun = { command: 'autoSolve', endReason: end.reason, detail: end.detail, ...total,
                  lastCenter: here, minutes, endedAt: new Date() };
    }
    return { ...total, lastCenter: here, endReason: end.reason, endDetail: end.detail };
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
    sendBufferBytes: gameSocket ? gameSocket.bufferedAmount : 0,
    actionsAwaitingAnswer: inFlight.size,
    lastClose: lastClose ? `code ${lastClose.code}${lastClose.reason ? ` (${lastClose.reason})` : ''} at ${lastClose.at.toLocaleTimeString()}` : 'none',
    chunksLoaded: loaded.length,
    chunksSilentNow: `${presumedEmpty.size} presumed empty, ${incompleteChunks.size} unknown`,
    lastRun: lastRun ? `${lastRun.command}: ${lastRun.endReason} (${lastRun.detail})` : 'none yet',
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
  // network
  checkConnection, probeConnection, reconnect,
  // solver
  planSolve, solveRadius, solveArea, autoSolve, stopSolve, areaAround, countHidden,
  // logs / internals
  actionLog, showActionLog, stats, dispose,
  waitForSnapshots, recheckSlowChunks, pendingSnapshots, presumedEmpty, incompleteChunks,
  waitForReconnect,
  get lastRun() { return lastRun; },
  get lastClose() { return lastClose; },
  get view() { return view; },
  get socket() { return gameSocket; },
};

g.__msbot = api;
g.msbot = api;
for (const name of [
  'loadAround', 'loadChunks', 'printArea', 'boardStatus', 'memoryStatus', 'cleanup', 'getCell', 'whereAmI',
  'revealGlobal', 'flagGlobal', 'chordGlobal', 'revealLocal', 'flagLocal', 'chordLocal',
  'solveRadius', 'solveArea', 'autoSolve', 'stopSolve', 'resyncUI', 'checkConnection', 'reconnect',
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
//   await checkConnection();                // is the server still answering? how far behind is it?
//   await reconnect();                      // make the game open a fresh connection
//   boardStatus();                          // health check if the board looks wrong
//   showActionLog();                        // table of every action sent this session
//   setConfig({ solver: { actionDelay: 120, passWait: 500 } });   // gentler pacing
//   configDiff();                           // what differs from the shipped defaults
//   resetConfig();                          // back to the defaults in section 2
//   msbot.dispose();                        // unhook everything

})();
