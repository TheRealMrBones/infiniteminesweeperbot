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

// The bot keeps whatever send() it finds as the "real" one, so give it a harmless stub
WebSocket.prototype.send = function () {};

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
  const fake = Object.create(WebSocket.prototype);      // enough for the hook to latch onto
  Object.defineProperty(fake, 'url', { value: 'wss://infiniteminesweeper.com/ws' });
  try { fake.send(new Uint8Array([1])); } catch { /* the real send rejects our stub; the hook already ran */ }
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
  const fastConfig = () => bot.setConfig({ board: { loadWait: 0, loadQuiet: 0 }, solver: { confirmTimeout: 30 } });
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

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
