#!/usr/bin/env node
/* Load the bot in Node (with the two DOM stubs it needs) and check the parts that
 * don't require a real game: the config plumbing, cell decoding, coordinates, the
 * action encoder, and above all that the solver's deductions are sound.
 *
 *   node tools/test-solver.js
 *
 * The solver check generates random consistent minesweeper fields, hides a random
 * subset, and asserts that planSolve() never flags a safe cell, never reveals a
 * mine, and never chords a number that would open one.
 */
const fs = require('node:fs');
const path = require('node:path');

globalThis.window = globalThis;
globalThis.window.addEventListener = () => {};
globalThis.document = { elementFromPoint: () => null };

// The bot keeps whatever send() it finds as the "real" one, so give it a stub that
// lets a fake socket play server (see makeSocket below)
WebSocket.prototype.send = function (data) { this.onSend?.(data); };

const BOT = path.join(__dirname, '..', 'infiniteMinesweeperBot.js');
eval(fs.readFileSync(BOT, 'utf8'));          // eslint-disable-line no-eval -- it is a console script

const bot = globalThis.msbot;
const CHUNK = 64;

let fails = 0;
const ok = (name, cond) => { if (!cond) { fails++; console.log('FAIL', name); } else console.log('ok  ', name); };

// --- config plumbing --------------------------------------------------------
ok('defaults are frozen', Object.isFrozen(bot.DEFAULT_CONFIG.solver));
ok('config starts equal to the defaults', Object.keys(bot.configDiff()).length === 0);
bot.setConfig({ solver: { actionDelay: 123 }, click: { enabled: true } });
ok('setConfig merges without dropping siblings',
   bot.config.solver.actionDelay === 123 && bot.config.solver.passWait === bot.DEFAULT_CONFIG.solver.passWait);
ok('configDiff lists exactly what changed',
   Object.keys(bot.configDiff()).join() === 'solver.actionDelay,click.enabled');
bot.resetConfig();
ok('resetConfig restores every value',
   bot.config.solver.actionDelay === bot.DEFAULT_CONFIG.solver.actionDelay && bot.config.click.enabled === false
   && Object.keys(bot.configDiff()).length === 0);
ok('resetConfig keeps every section',
   Object.keys(bot.config).join() === Object.keys(bot.DEFAULT_CONFIG).join());

// --- cell bytes and coordinates --------------------------------------------
ok('byte 0 is hidden', bot.describe(0).state === 'hidden');
ok('byte 1 is a revealed mine', bot.describe(1).state === 'mine');
ok('byte 2 is the number 0', bot.describe(2).state === 'number' && bot.describe(2).number === 0);
ok('byte 9 is the number 7', bot.describe(9).number === 7);
ok('byte 11 is a colour-1 flag', bot.describe(11).state === 'flag' && bot.describe(11).color === 1);
ok('an unloaded cell is unknown', bot.describe(undefined).state === 'unknown');
ok('global -> local -> global roundtrips',
   String(bot.toGlobal(...bot.toLocal(5798, 1820))) === '5798,1820');
ok('negative coordinates land in negative chunks', String(bot.toLocal(-1, -1)) === '-1,-1,63,63');
ok('chunksIn covers a span across four chunks', bot.chunksIn(60, 60, 70, 70).length === 4);
ok('areaAround centres the square', String(bot.areaAround([100, 100], 40)) === '80,80,119,119');

// --- solver soundness on random boards -------------------------------------
function randomBoard(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const X0 = 10, Y0 = 10, N = 30;                 // well inside chunk (0,0)

  const mine = new Set();
  for (let y = Y0; y < Y0 + N; y++)
    for (let x = X0; x < X0 + N; x++) if (rnd() < 0.15) mine.add(`${x},${y}`);
  const isM = (x, y) => mine.has(`${x},${y}`);
  const count = (x, y) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isM(x + dx, y + dy)) n++;
    return n;
  };

  const grid = new Uint8Array(CHUNK * CHUNK);     // everything hidden by default
  for (let y = Y0 - 1; y < Y0 + N + 1; y++) for (let x = X0 - 1; x < X0 + N + 1; x++) {
    if (isM(x, y)) { if (rnd() < 0.4) grid[y * CHUNK + x] = 10 + 1; continue; }   // some mines flagged
    if (rnd() < 0.75) grid[y * CHUNK + x] = count(x, y) + 2;                      // most safe cells revealed
  }
  bot.chunks.clear();
  bot.chunks.set('0,0', grid);
  return { mine, isM, rect: [X0, Y0, X0 + N - 1, Y0 + N - 1] };
}

let deductions = 0, contradictions = 0;
const problems = [];
for (let seed = 1; seed <= 300; seed++) {
  const { mine, isM, rect } = randomBoard(seed);
  const plan = bot.planSolve(...rect);
  deductions += plan.flags.length + plan.chords.length + plan.reveals.length;
  contradictions += plan.contradictions;
  for (const k of plan.flags) if (!mine.has(k)) problems.push(`seed ${seed}: flagged safe cell ${k}`);
  for (const k of plan.reveals) if (mine.has(k)) problems.push(`seed ${seed}: would reveal mine ${k}`);
  for (const k of plan.chords) {
    const [x, y] = k.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (bot.getCell(x + dx, y + dy).state === 'hidden' && isM(x + dx, y + dy))
        problems.push(`seed ${seed}: chord ${k} would open mine ${x + dx},${y + dy}`);
    }
  }
}
ok(`solver found ${deductions} deductions across 300 boards`, deductions > 5000);
ok('no deduction was unsafe', problems.length === 0);
ok('no contradictions on consistent boards', contradictions === 0);
if (problems.length) console.log(problems.slice(0, 5));

// --- action encoding through the socket hook -------------------------------
(async () => {
  // A tiny protobuf writer/reader, to play the server's side
  const zlib = require('node:zlib');
  const varint = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; o.push(b); } while (n); return o; };
  const vF = (f, v) => [...varint(f * 8), ...varint(v)];
  const bF = (f, b) => [...varint(f * 8 + 2), ...varint(b.length), ...b];
  const zz = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
  const tile = (cx, cy) => bF(1, [...vF(1, zz(cx)), ...vF(2, zz(cy))]);
  function* pbFields(b) {
    let i = 0;
    const read = () => { let r = 0, m = 1, x; do { x = b[i++]; r += (x & 127) * m; m *= 128; } while (x & 128); return r; };
    while (i < b.length) {
      const key = read(), wire = key & 7, num = Math.floor(key / 8);
      if (wire === 0) yield [num, read()];
      else { const len = read(); yield [num, b.subarray(i, i + len)]; i += len; }
    }
  }

  // Enough of a WebSocket for the bot: a real EventTarget (so frames can be delivered
  // as MessageEvents) wearing WebSocket's prototype. With `answer` set it replies like
  // the server: a revealAck for every action and a seedResponse for every seed request.
  const makeSocket = ({ answer = false } = {}) => {
    const ws = new EventTarget();
    Object.setPrototypeOf(ws, WebSocket.prototype);
    Object.defineProperties(ws, {
      url: { value: 'wss://infiniteminesweeper.com/ws' },
      readyState: { value: 1, writable: true },
      bufferedAmount: { value: 0, writable: true },
      answer: { value: answer, writable: true },
      closedWith: { value: null, writable: true },
      tiles: { value: null, writable: true },     // chunk key -> bytes to answer subscriptions with
      close: { value: (code = 1006, reason = '') => {
        if (ws.readyState === 3) return;
        ws.readyState = 3; ws.closedWith = code;
        ws.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: false }));
      } },
      receive: { value: (msg) => ws.dispatchEvent(new MessageEvent('message',
        { data: new Uint8Array(zlib.gzipSync(Buffer.from(msg))).buffer })) },
      onSend: { value: (data) => {
        if (!ws.answer || ws.readyState !== 1) return;
        for (const [type, body] of pbFields(zlib.gunzipSync(Buffer.from(data)))) {
          if (type === 4) {
            const id = [...pbFields(body)].find(([f]) => f === 1)?.[1];
            setTimeout(() => ws.receive(bF(8, [...vF(1, id), ...vF(2, 1)])), 5);
          }
          if (type === 21) setTimeout(() => ws.receive(bF(22, [])), 5);
          if (type === 12 && ws.tiles) {          // subscribe: send back the tiles it knows
            const back = [];
            for (const [f, t] of pbFields(body)) {
              if (f !== 1) continue;
              const xy = Object.fromEntries(pbFields(t)), un = (v = 0) => (v % 2 ? -(v + 1) / 2 : v / 2);
              const data = ws.tiles.get(`${un(xy[1])},${un(xy[2])}`);
              if (data) back.push(...bF(1, [...bF(1, t), ...bF(3, [...data])]));
            }
            if (back.length) setTimeout(() => ws.receive(bF(29, back)), 5);
          }
        }
      } },
    });
    ws.send(new Uint8Array(zlib.gzipSync(Buffer.alloc(0))));   // the game's first message: the hook captures it
    return ws;
  };
  const fake = makeSocket();
  ok('the hook captures the game socket', bot.socket === fake);

  bot.config.logging.actions = false;
  try { await bot.sendAction(bot.ACTION.FLAG, 3, -2, 5, 7); } catch { /* same */ }
  await new Promise((r) => setTimeout(r, 200));         // the frame queue is async
  const last = bot.actionLog.at(-1);
  ok('a flag survives encode -> gzip -> decode',
     !!last && last.action === 'FLAG' && last.cx === 3 && last.cy === -2 && last.col === 5
     && last.row === 7 && last.x === 3 * 64 + 5 && last.y === -2 * 64 + 7);
  ok('the log knows it came from the script', last?.source === 'script');

  // --- memory management ----------------------------------------------------
  const settle = () => new Promise((r) => setTimeout(r, 200));   // frames are processed asynchronously
  // The stub server never answers, so keep every wait short
  const fastConfig = () => bot.setConfig({ board: { loadWait: 0, loadQuiet: 0 }, solver: { confirmTimeout: 30 }, net: { autoRecover: false } });
  fastConfig();
  bot.chunks.clear();                                            // leftovers from the solver boards above
  await bot.loadChunks([[0, 0], [1, 0], [2, 0]], { quiet: true });
  await bot.cleanup({ keepView: false });
  await settle();
  ok('cleanup empties the bot\'s subscriptions and board data',
     bot.memoryStatus({ quiet: true }).subscribedByBot === 0 && bot.chunks.size === 0);

  bot.config.memory.maxScriptChunks = 5;
  await bot.loadChunks([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 0]), { quiet: true });
  await settle();
  ok('subscriptions are tracked', bot.memoryStatus({ quiet: true }).subscribedByBot === 8);
  await bot.ensureLoaded(0, 0, 10, 10);                          // touches chunk 0,0 and triggers a prune
  await settle();
  const kept = [...bot.chunks.keys()].sort().join(' ');
  ok('pruning trims to the cap', bot.memoryStatus({ quiet: true }).subscribedByBot === 5);
  ok('pruning drops the least recently used chunks and spares the one just used',
     kept === '0,0 4,0 5,0 6,0 7,0');
  ok('pruned chunk data is gone from memory', !bot.chunks.has('1,0') && bot.chunks.size === 5);

  bot.config.memory.maxScriptChunks = 0;                        // 0 = no cap
  await bot.loadChunks([[20, 0], [21, 0], [22, 0], [23, 0]], { quiet: true });
  await bot.ensureLoaded(20 * 64, 0, 20 * 64 + 5, 5);
  await settle();
  ok('a cap of 0 disables pruning', bot.memoryStatus({ quiet: true }).subscribedByBot === 9);

  bot.config.memory.releaseOnFinish = true;
  await bot.solveArea(4, { center: [5000, 5000] });             // loads its own chunks, finds nothing to do
  await settle();
  ok('finishing a solver command releases what it loaded',
     bot.memoryStatus({ quiet: true }).subscribedByBot === 0 && bot.chunks.size === 0);

  // --- autoSolve terminates with the default (Infinity) search limits ---------
  // Regression: maxRadius = Infinity used to build an infinite candidate list in
  // pickNearestToStart and crash the tab with out-of-memory after the first area.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
  bot.resetConfig();
  fastConfig();
  bot.config.logging.actions = false;
  ok('the defaults really use unbounded search limits',
     bot.config.auto.maxRadius === Infinity && bot.config.auto.maxRings === Infinity);
  for (const mode of ['nearest', 'mostWork']) {
    await settle();
    bot.chunks.clear();
    const r = await withTimeout(bot.autoSolve(20, { center: [0, 0], mode }), 20000);
    ok(`autoSolve (${mode}) gives up on an empty board instead of searching forever`,
       r !== 'TIMEOUT' && r?.areas === 1 && r.endReason === 'blankGap' && bot.lastRun.endReason === 'blankGap');
    bot.stopSolve();
  }

  // ...but still travels to real work: a finished 0 with eight hidden neighbours
  // at global (x, 10), with an untouched gap between it and the start
  async function farWork(x, mode, opts = { maxAreas: 2 }) {
    await settle();                                       // let the last run's unsubscribes finish first
    bot.chunks.clear();
    const chunk = new Uint8Array(CHUNK * CHUNK);
    chunk[10 * CHUNK + (x % CHUNK)] = 2;
    bot.chunks.set(`${Math.floor(x / CHUNK)},0`, chunk);
    return withTimeout(bot.autoSolve(20, { center: [0, 0], mode, ...opts }), 20000);
  }
  for (const mode of ['nearest', 'mostWork']) {
    const near = await farWork(30, mode);
    ok(`autoSolve (${mode}) finds work a couple of areas away with the defaults`,
       near !== 'TIMEOUT' && near.areas === 2 && near.chords + near.reveals >= 1);
    const gap = await farWork(100, mode);
    ok(`autoSolve (${mode}) gives up when the gap is wider than giveUpAfterEmpty`, gap !== 'TIMEOUT' && gap.areas === 1 && gap.endReason === 'blankGap');
    bot.setConfig({ auto: { giveUpAfterEmpty: 10 } });
    const wide = await farWork(100, mode);
    ok(`autoSolve (${mode}) crosses the same gap once giveUpAfterEmpty is raised`,
       wide !== 'TIMEOUT' && wide.areas === 2 && wide.chords + wide.reveals >= 1);
    bot.resetConfig();
    fastConfig();
    bot.config.logging.actions = false;
  }
  await bot.cleanup({ keepView: false });

  // --- waiting for chunk snapshots -------------------------------------------
  // "No data yet" is ambiguous (untouched chunks never get a snapshot, busy ones are slow).
  const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };
  bot.setConfig({ board: { loadWait: 0, loadQuiet: 600, loadMaxWait: 3000 } });
  bot.pendingSnapshots.add('90,90');
  setTimeout(() => bot.pendingSnapshots.delete('90,90'), 250);
  let [w, ms] = await timed(() => bot.waitForSnapshots(['90,90']));
  ok('a slow snapshot is waited for, not mistaken for an empty chunk',
     w.arrived === 1 && w.presumedEmpty === 0 && w.incomplete === 0 && ms < 550);

  bot.setConfig({ board: { loadQuiet: 100 } });
  bot.pendingSnapshots.add('91,91');
  [w, ms] = await timed(() => bot.waitForSnapshots(['91,91']));
  ok('a chunk that stays silent once the server goes quiet is presumed untouched',
     w.presumedEmpty === 1 && bot.presumedEmpty.has('91,91') && !bot.pendingSnapshots.has('91,91') && ms >= 90);

  bot.setConfig({ board: { loadQuiet: 10000, loadMaxWait: 150 } });
  bot.pendingSnapshots.add('92,92');
  [w, ms] = await timed(() => bot.waitForSnapshots(['92,92']));
  ok('a chunk still silent at loadMaxWait is marked unknown, not empty',
     w.incomplete === 1 && bot.incompleteChunks.has('92,92') && !bot.presumedEmpty.has('92,92'));
  bot.presumedEmpty.clear(); bot.incompleteChunks.clear();

  // The final re-check gives slow chunks another, longer chance before a run gives up
  bot.setConfig({ board: { loadWait: 0, loadQuiet: 5000, loadMaxWait: 3000 } });
  await settle();
  bot.presumedEmpty.add('0,0');
  const late = new Uint8Array(CHUNK * CHUNK);
  late[10 * CHUNK + 30] = 2;                                     // a finished 0 at (30, 10)
  setTimeout(() => { bot.chunks.set('0,0', late); bot.pendingSnapshots.delete('0,0'); }, 120);   // the snapshot finally lands
  const re = await bot.recheckSlowChunks([{ rect: [22, -10, 41, 9], result: (n) => ({ center: [32, 0], work: n }) }]);
  ok('the re-check finds work in a chunk that answered late', re.found?.work === 3 && re.rechecked === 1);
  bot.presumedEmpty.clear();

  // --- progress checks retry instead of aborting -----------------------------
  async function stallRun(confirmTimeout, confirmAfter) {
    await settle();
    fastConfig();
    bot.setConfig({ solver: { confirmTimeout } });
    bot.chunks.clear();
    const chunk = new Uint8Array(CHUNK * CHUNK);
    chunk[10 * CHUNK + 30] = 2;                                  // three safe reveals along y = 9
    bot.chunks.set('0,0', chunk);
    if (confirmAfter) setTimeout(() => { for (const x of [29, 30, 31]) chunk[9 * CHUNK + x] = 9; }, confirmAfter);   // revealed as 7s: no follow-up work
    return timed(() => bot.solveArea(20, { center: [32, 0] }));
  }
  let [sr, sms] = await stallRun(60, 0);
  ok('actions that never show up end the area as stalled, after several tries',
     sr.code === 'stalled' && sms >= 150 && bot.lastRun.endReason === 'stalled');
  [sr, sms] = await stallRun(1500, 200);
  ok('a slow confirmation is waited for: no stall, the area carries on', sr.code === 'stuck' && sms < 1400);

  // --- a run that cannot load anything says so instead of searching forever ---
  await settle();
  fastConfig();
  bot.setConfig({ board: { loadQuiet: 10000, loadMaxWait: 120 } });
  bot.chunks.clear();
  const nl = await withTimeout(bot.autoSolve(20, { center: [0, 0], mode: 'nearest' }), 60000);
  ok('when no chunk data arrives the run ends as chunksNotLoading',
     nl !== 'TIMEOUT' && nl.endReason === 'chunksNotLoading' && bot.lastRun.endReason === 'chunksNotLoading');
  bot.presumedEmpty.clear(); bot.incompleteChunks.clear();

  // --- every way a run can end is reported -------------------------------------
  await settle();
  fastConfig();
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); realLog(...a); };
  bot.chunks.clear();
  const ended = async (size, opts) => { await settle(); bot.chunks.clear(); return withTimeout(bot.autoSolve(size, opts), 20000); };
  const rMax = await farWork(30, 'nearest', { maxAreas: 1 });
  const rStall = await farWork(30, 'mostWork', {});
  const rRadius = await ended(20, { center: [0, 0], mode: 'nearest', maxRadius: 1 });
  const rRings = await ended(20, { center: [0, 0], mode: 'mostWork', maxRings: 1 });
  console.log = realLog;
  ok('maxAreas is reported', rMax.endReason === 'maxAreas');
  ok('a stalled run is reported', rStall.endReason === 'stalled');
  ok('maxRadius exhausted is reported', rRadius.endReason === 'radiusLimit');
  ok('maxRings exhausted is reported', rRings.endReason === 'ringLimit');
  ok('each run prints an [auto] ENDED line naming the reason and explaining it',
     ['maxAreas', 'stalled', 'radiusLimit', 'ringLimit'].every((r) =>
       lines.some((l) => l.startsWith(`[auto] ENDED (${r})`) && l.length > `[auto] ENDED (${r}) after 0 min: `.length + 10)));

  await settle();
  fastConfig();
  bot.setConfig({ solver: { confirmTimeout: 5000 } });
  setTimeout(() => bot.stopSolve(), 300);
  const [rStop, stopMs] = await timed(() => farWork(30, 'nearest', {}));
  ok('stopSolve() ends the run promptly and says it was stopped',
     rStop.endReason === 'stopped' && stopMs < 3000 && /stopSolve/.test(bot.lastRun.detail));

  await bot.cleanup({ keepView: false });

  // --- the connection dropping -------------------------------------------------
  await settle();
  fastConfig();
  bot.setConfig({ net: { resyncPoll: 20, resyncSettle: 50, reconnectTimeout: 1000 } });
  bot.chunks.set('0,0', new Uint8Array(CHUNK * CHUNK));
  bot.socket.close(1006);
  ok('a closed connection drops the board it was keeping', bot.chunks.size === 0 && bot.lastClose?.code === 1006);
  const sentBefore = bot.stats.sent;
  let err = null;
  try { await bot.sendAction(bot.ACTION.FLAG, 0, 0, 1, 1); } catch (e) { err = e; }
  ok('nothing is written to a closed socket', err?.name === 'Disconnected' && bot.stats.sent === sentBefore);
  makeSocket();

  // Drop the connection while a run waits for confirmation, then (maybe) reconnect
  async function dropRun(opts, reconnectAfter) {
    await settle();
    fastConfig();
    bot.setConfig({ solver: { confirmTimeout: 5000 }, net: { resyncPoll: 20, resyncSettle: 50, reconnectTimeout: 1000, autoRecover: true, ...opts } });
    setTimeout(() => bot.socket.close(1006), 300);
    if (reconnectAfter) setTimeout(() => makeSocket(), reconnectAfter);
    return timed(() => farWork(30, 'nearest', {}));
  }
  let [dr, dms] = await dropRun({ autoRecover: false }, 0);
  ok('without autoRecover a dropped connection ends the run promptly as disconnected',
     dr.endReason === 'disconnected' && dms < 2000 && /code 1006/.test(dr.endDetail));
  makeSocket();
  [dr, dms] = await dropRun({}, 0);
  ok('a game that never reconnects ends the run after net.reconnectTimeout',
     dr.endReason === 'disconnected' && dms >= 1200 && /reconnectTimeout/.test(dr.endDetail));
  makeSocket();
  [dr] = await dropRun({}, 600);
  ok('after the game reconnects the run carries on', dr.recoveries === 1 && dr.endReason !== 'disconnected');
  bot.resetConfig();
  fastConfig();

  // --- a new socket is followed the moment the game creates it -----------------
  bot.setConfig({ net: { socketUrlMatch: '127.0.0.1:9/ws' } });
  const created = new WebSocket('ws://127.0.0.1:9/ws');          // nothing listens there; it never opens
  ok('a socket is picked up when it is created, before it sends anything', bot.socket === created);
  created.addEventListener('error', () => {});
  bot.resetConfig();
  fastConfig();

  // --- tile versions and resolutions -------------------------------------------
  let ws = makeSocket();
  const cell = (x, y) => bot.getCell(x, y).state;
  const full = (ver, byte) => bF(15, [...tile(5, 5), ...vF(2, ver), ...bF(3, [...new Uint8Array(4096).fill(byte)]), ...vF(4, 64)]);
  const delta = (ver, byte, res = 64) => bF(16, [...tile(5, 5), ...vF(2, ver),
    ...bF(3, [...vF(1, 0), ...vF(2, 0), ...vF(3, 1), ...vF(4, 1), ...bF(5, [byte])]), ...vF(4, res)]);
  bot.chunks.set('5,5', new Uint8Array(4096));
  ws.receive(full(5, 0)); await settle();
  ok('a single full tile (message 15) is read', bot.stats.snapshots > 0 && cell(320, 320) === 'hidden');
  ws.receive(delta(3, 2)); await settle();
  ok('a delta older than the data already held is dropped', cell(320, 320) === 'hidden' && bot.stats.staleDeltas === 1);
  ws.receive(delta(7, 2, 16)); await settle();
  ok('a delta at another resolution (game zoomed out) is not written into the board',
     cell(320, 320) === 'hidden' && bot.stats.otherResolution === 1);
  ws.receive(delta(6, 2)); await settle();
  ok('a newer delta is applied', cell(320, 320) === 'number');

  // --- flow control on the server's answers --------------------------------------
  bot.setConfig({ net: { maxInFlight: 2, ackTimeout: 250 } });
  const lost0 = bot.stats.acksLost;
  [, ms] = await timed(async () => { for (let i = 0; i < 3; i++) await bot.sendAction(bot.ACTION.FLAG, 0, 0, i, 0); });
  ok('with maxInFlight actions unanswered, the next one waits (until they count as lost)',
     ms >= 200 && bot.stats.acksLost > lost0);
  ws.answer = true;
  const ok0 = bot.stats.acksOk;
  [, ms] = await timed(async () => { for (let i = 0; i < 6; i++) await bot.sendAction(bot.ACTION.FLAG, 0, 0, i, 1); });
  await settle();
  ok('answered actions are counted and do not hold sending up', bot.stats.acksOk - ok0 === 6 && ms < 1000);
  bot.resetConfig();
  fastConfig();

  let health = await bot.checkConnection({ quiet: true });
  ok('checkConnection() reports a server that answers as healthy', health.probeOk && health.healthy);
  ws.answer = false;
  bot.setConfig({ net: { probeTimeout: 100 } });
  health = await bot.checkConnection({ quiet: true });
  ok('checkConnection() spots an open socket whose server stopped answering',
     !health.probeOk && /reconnect\(\)/.test(health.verdict));
  bot.resetConfig();
  fastConfig();

  // --- stalls: a stale board versus a dead connection ----------------------------
  // The fake server answers every action, but the board never changes (its feed went stale)
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  const planted = new Uint8Array(CHUNK * CHUNK);
  planted[10 * CHUNK + 30] = 2;                                 // the same board stallRun and farWork set up
  ws.answer = true;
  ws.tiles = new Map([['0,0', planted]]);                       // ...and a reload brings back the same stale board
  [sr] = await stallRun(60, 0);
  console.warn = realWarn;
  ok('actions the server answered but the board never showed make the bot reload the board first',
     sr.code === 'stalled' && warns.some((l) => /reloading this area's chunks/.test(l)));

  async function stallAuto(net, onClose) {
    await settle();
    fastConfig();
    bot.setConfig({ solver: { confirmTimeout: 60 }, net: { autoRecover: true, stallCooldown: 50, probeTimeout: 100,
      resyncPoll: 20, resyncSettle: 50, reconnectTimeout: 1500, ...net } });
    const before = bot.socket;
    if (onClose) {
      const poll = setInterval(() => { if (before.readyState === 3) { clearInterval(poll); onClose(); } }, 20);
    }
    const r = await withTimeout(farWork(30, 'nearest', {}), 20000);
    return { r, before };
  }
  let { r: sa } = await stallAuto({ maxRecoveries: 1 });
  ok('autoSolve recovers from a stall while the server still answers, and says why it finally gave up',
     sa !== 'TIMEOUT' && sa.recoveries === 1 && sa.endReason === 'stalled' && /maxRecoveries/.test(sa.endDetail));
  ws.answer = false;
  let before;
  ({ r: sa, before } = await stallAuto({ maxRecoveries: 1 }, () => { ws = makeSocket({ answer: true }); }));
  ok('a stall with a silent server makes the game open a new connection, and the run carries on there',
     sa !== 'TIMEOUT' && before.closedWith === 4000 && sa.recoveries === 1 && bot.socket === ws);
  bot.resetConfig();
  fastConfig();

  await bot.cleanup({ keepView: false });

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
