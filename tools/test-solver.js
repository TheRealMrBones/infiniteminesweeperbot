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
  bot.config.board.loadWait = 0;
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
  bot.config.board.loadWait = 0;
  bot.config.logging.actions = false;
  ok('the defaults really use unbounded search limits',
     bot.config.auto.maxRadius === Infinity && bot.config.auto.maxRings === Infinity);
  for (const mode of ['nearest', 'mostWork']) {
    await settle();
    bot.chunks.clear();
    const r = await withTimeout(bot.autoSolve(20, { center: [0, 0], mode }), 20000);
    ok(`autoSolve (${mode}) gives up on an empty board instead of searching forever`,
       r !== 'TIMEOUT' && r?.areas === 1);
    bot.stopSolve();
  }

  // ...but still travels to real work: a finished 0 with eight hidden neighbours
  // at global (x, 10), with an untouched gap between it and the start
  async function farWork(x, mode) {
    await settle();                                       // let the last run's unsubscribes finish first
    bot.chunks.clear();
    const chunk = new Uint8Array(CHUNK * CHUNK);
    chunk[10 * CHUNK + (x % CHUNK)] = 2;
    bot.chunks.set(`${Math.floor(x / CHUNK)},0`, chunk);
    return withTimeout(bot.autoSolve(20, { center: [0, 0], mode, maxAreas: 2 }), 20000);
  }
  for (const mode of ['nearest', 'mostWork']) {
    const near = await farWork(30, mode);
    ok(`autoSolve (${mode}) finds work a couple of areas away with the defaults`,
       near !== 'TIMEOUT' && near.areas === 2 && near.chords + near.reveals >= 1);
    const gap = await farWork(100, mode);
    ok(`autoSolve (${mode}) gives up when the gap is wider than giveUpAfterEmpty`, gap !== 'TIMEOUT' && gap.areas === 1);
    bot.setConfig({ auto: { giveUpAfterEmpty: 10 } });
    const wide = await farWork(100, mode);
    ok(`autoSolve (${mode}) crosses the same gap once giveUpAfterEmpty is raised`,
       wide !== 'TIMEOUT' && wide.areas === 2 && wide.chords + wide.reveals >= 1);
    bot.resetConfig();
    bot.config.board.loadWait = 0;
    bot.config.logging.actions = false;
  }
  await bot.cleanup({ keepView: false });

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
