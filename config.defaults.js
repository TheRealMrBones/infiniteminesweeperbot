/* ===========================================================================
 * Shipped defaults for infiniteMinesweeperBot.js
 * ===========================================================================
 *
 * This is the pristine copy of the CONFIG block at the top of the bot, kept
 * separately so a mangled config is always one copy-paste away from working.
 *
 *   Reset at runtime .... resetConfig()  (the bot carries its own copy of this)
 *   Reset the file ...... copy the object below over the CONFIG block in
 *                        infiniteMinesweeperBot.js, section 1
 *   Reset in a console .. paste this file after the bot; it calls setConfig()
 *                        for you and leaves the values in MSBOT_DEFAULTS
 *
 * The object below is byte-for-byte the DEFAULT_CONFIG block in section 2 of
 * infiniteMinesweeperBot.js. `node tools/check-defaults.js` verifies that.
 * Every setting is documented in README.md and commented in the bot itself.
 * ======================================================================== */

(() => {

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
  },
};
/* DEFAULTS:END */

globalThis.MSBOT_DEFAULTS = DEFAULT_CONFIG;
if (globalThis.msbot) {
  globalThis.msbot.setConfig(DEFAULT_CONFIG);
  console.log('[config] defaults from config.defaults.js applied');
} else {
  console.log('[config] bot not loaded yet; defaults kept in MSBOT_DEFAULTS');
}

})();
