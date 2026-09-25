#!/usr/bin/env node
/* Verify that the DEFAULT_CONFIG block in infiniteMinesweeperBot.js (section 2)
 * still matches the copy in config.defaults.js.
 *
 *   node tools/check-defaults.js        report differences
 *   node tools/check-defaults.js --fix  copy the bot's block into config.defaults.js
 *
 * The bot's block is the source of truth: it is what resetConfig() uses when the
 * file is pasted on its own. No dependencies; run it after changing a default.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const BOT = path.join(root, 'infiniteMinesweeperBot.js');
const DEFAULTS = path.join(root, 'config.defaults.js');
const START = '/* DEFAULTS:START */';
const END = '/* DEFAULTS:END */';

function region(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const from = text.indexOf(START), to = text.indexOf(END);
  if (from === -1 || to === -1) {
    console.error(`${path.basename(file)}: missing ${from === -1 ? START : END} marker`);
    process.exit(2);
  }
  return { text, block: text.slice(from, to + END.length) };
}

const bot = region(BOT);
const defaults = region(DEFAULTS);

if (bot.block === defaults.block) {
  console.log('config.defaults.js matches the bot\'s DEFAULT_CONFIG block.');
  process.exit(0);
}

if (process.argv.includes('--fix')) {
  fs.writeFileSync(DEFAULTS, defaults.text.replace(defaults.block, bot.block));
  console.log('config.defaults.js updated from infiniteMinesweeperBot.js.');
  process.exit(0);
}

const a = bot.block.split('\n'), b = defaults.block.split('\n');
console.error('config.defaults.js is out of date. Differing lines (bot | config.defaults.js):\n');
for (let i = 0; i < Math.max(a.length, b.length); i++)
  if (a[i] !== b[i]) console.error(`  ${String(i + 1).padStart(3)}  ${a[i] ?? '(missing)'}   |   ${b[i] ?? '(missing)'}`);
console.error('\nRun `node tools/check-defaults.js --fix` to copy the bot\'s block over.');
process.exit(1);
