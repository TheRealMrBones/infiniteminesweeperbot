# infiniteminesweeperbot

A single-file console bot for [infiniteminesweeper.com](https://infiniteminesweeper.com). It hooks
the game's WebSocket, keeps its own live copy of the board, and plays only moves that are
**provably safe** — it never guesses.

There is nothing to install and nothing to build: paste
[`infiniteMinesweeperBot.js`](infiniteMinesweeperBot.js) into the browser console and call its
commands.

> The site is multiplayer, so automated play affects other people's boards. Keep
> `solver.actionDelay` reasonable, and check the site's rules before running it for long stretches.

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Memory](#memory)
- [The solver](#the-solver)
- [Click mode](#click-mode)
- [Protocol notes](#protocol-notes)
- [Troubleshooting](#troubleshooting)
- [Repo layout](#repo-layout)
- [Developing](#developing)
- [Limitations](#limitations)

## Quick start

1. Open <https://infiniteminesweeper.com> and open the DevTools console (F12).
2. Paste the entire contents of `infiniteMinesweeperBot.js` and press Enter. (The first time, Chrome
   asks you to type `allow pasting` into the console.)
3. **Scroll or click once in the game.** The bot can only grab the WebSocket when the game sends
   something, so it stays invisible until you interact once.
4. Fetch the board around you and start solving:

```js
await loadAround();     // snapshot the 3x3 chunks around your view
printArea(...whereAmI(), 40, 20);   // have a look
await autoSolve();      // solve area after area until there is nothing safe left
stopSolve();            // stop after the current action
await resyncUI();       // make the game's own score display catch up
```

Every command is also available on the `msbot` object (`msbot.autoSolve()`), which is handy for
discovering what exists — expand it in the console. Re-pasting the file is safe: the new copy
unhooks the old one first.

## Commands

### Board

| Command | What it does |
| --- | --- |
| `await loadAround(radius = 1, cx, cy)` | Fetch fresh snapshots of the chunks around your view (radius in chunks). |
| `await loadChunks([[cx, cy], ...])` | Fetch specific chunks. |
| `whereAmI()` | `[x, y]` global cell coordinates of your view, from the game's own position messages. |
| `getCell(x, y)` | `{ state, number?, color?, raw }` — `state` is `hidden`, `number`, `flag`, `mine` or `unknown` (not loaded). |
| `printArea(x, y, w, h)` | ASCII dump: `#` hidden, `.` empty, `1`-`8` numbers, `F` flag, `*` mine, `?` not loaded. |
| `boardStatus()` | Health table: socket state, frame counters, chunks loaded, click-mode calibration. |
| `memoryStatus()` | What the bot is holding: chunks in memory, subscriptions (bot vs. game), log sizes, JS heap in Chrome. |
| `await cleanup()` | Release every chunk the bot loaded (except around your view) and empty the action log. `{ keepView: false }` releases those too. |

### Actions

| Command | What it does |
| --- | --- |
| `await revealGlobal(x, y)` | Reveal one cell. |
| `await flagGlobal(x, y)` | Flag one cell. |
| `await chordGlobal(x, y)` | Chord a finished number (opens all its hidden neighbours at once). |
| `await revealLocal(cx, cy, col, row)` | Same three, addressed by chunk + cell instead of global coordinates. |
| `await resyncUI()` | Drop the socket so the game reconnects and refreshes its score display. No page reload. |
| `showActionLog()` | Table of every action sent this session, yours and the bot's. |

### Solver

| Command | What it does |
| --- | --- |
| `await solveRadius(size, opts)` | **One** pass over a `size` x `size` square centred on you. |
| `await solveRadius(size, { dryRun: true })` | Print what a pass would do and return the plan; sends nothing. |
| `await solveArea(size, opts)` | Repeat passes over one area until it is solved or stuck. |
| `await autoSolve(size, opts)` | Solve an area, move to the next area with work, repeat. The main entry point. |
| `stopSolve()` | Stop the running solver after the action in flight. |

Options (each defaults to the matching setting in the config): `delay`, `passWait` and
`center: [x, y]` everywhere; `maxPasses` on `solveArea` and `autoSolve`; `dryRun` on `solveRadius`;
`mode`, `overlap`, `maxRings`, `maxRadius` and `maxAreas` on `autoSolve`.

```js
await solveArea(40, { center: [5800, 1820] });        // a specific spot, not where you are
await autoSolve(40, { mode: 'mostWork', maxAreas: 10 });
await autoSolve(60, { delay: 120, passWait: 500 });   // bigger areas, gentler pacing
```

`solveArea` returns `{ status, passes, flags, chords, reveals, hiddenLeft }`; `status` is `solved`,
`stuck (needs a guess)`, `stopped`, `hit a mine (stopped to be safe)`, `no progress (actions not
taking effect)` or `max passes reached`.

### Config

| Command | What it does |
| --- | --- |
| `showConfig()` | Table of every setting with its current and default value. |
| `setConfig({ solver: { actionDelay: 120 } })` | Change settings live (nested merge — untouched keys stay). |
| `configDiff()` | Only what differs from the shipped defaults. |
| `resetConfig()` | Put everything back to the shipped defaults. |
| `botConfig` / `msbot.config` | The live settings object; `botConfig.click.enabled = true` works too. |
| `msbot.dispose()` | Unhook the WebSocket, the `MessageEvent` getter and all listeners. |

## Configuration

Settings live in **section 1** at the top of `infiniteMinesweeperBot.js`. Edit them there before
pasting, or change them live with `setConfig()`.

Defaults are kept in two places so a mangled config is never a problem:

- **Section 2 of the bot** (`DEFAULT_CONFIG`, frozen). This is what `resetConfig()` uses, so reset
  works even when the single file is all you pasted. Missing keys in section 1 fall back to it, and
  a misspelled key is reported in the console instead of silently doing nothing.
- **[`config.defaults.js`](config.defaults.js)** — the same block as a standalone file. Copy it over
  the `CONFIG` block to reset the file itself, or paste it into the console after the bot to apply
  the defaults at runtime.

`node tools/check-defaults.js` verifies the two copies still agree (`--fix` copies the bot's block
into `config.defaults.js`). Run it whenever you change a default.

### Every setting

**`solver`** — the safe-move engine

| Setting | Default | Meaning |
| --- | --- | --- |
| `passSize` | `20` | Default square size for `solveRadius()`. |
| `areaSize` | `100` | Default square size for `solveArea()` and `autoSolve()`. |
| `actionDelay` | `10` | ms between two actions. Lower is faster and noisier for other players. |
| `passWait` | `20` | ms cap on waiting for the server to confirm a pass. It moves on as soon as every action is confirmed, so this only matters when something is dropped. |
| `maxPasses` | `1000` | Give up on one area after this many passes. |

**`auto`** — how `autoSolve()` travels

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `'nearest'` | `'nearest'`: always the closest unfinished area to where `autoSolve` started. `'mostWork'`: jump to the neighbouring area with the most safe moves. |
| `overlapRatio` | `0.2` | Neighbouring areas overlap by `round(size * ratio)` cells, so deductions that need cells from both still happen. |
| `maxRings` | `Infinity` | `mostWork`: how many rings of candidate areas to search outward before giving up. `Infinity` is safe: `giveUpAfterEmpty` ends the search. |
| `maxRadius` | `Infinity` | `nearest`: how many areas out from the start to consider. `Infinity` is safe: `giveUpAfterEmpty` ends the search. |
| `giveUpAfterEmpty` | `3` | Stop searching after this many rings (`mostWork`) or bands (`nearest`) of areas in a row with nothing revealed in them. This is what ends the search when `maxRings` / `maxRadius` are `Infinity`. One step is `areaSize` minus the overlap, so at size 40 the default tolerates a blank gap of roughly 100 cells; raise it to cross wider gaps. |
| `maxAreas` | `Infinity` | Stop after this many areas. |
| `keepMargin` | `4` | Extra chunks kept subscribed around the next area when releasing the rest. |

**`board`** — chunk loading

| Setting | Default | Meaning |
| --- | --- | --- |
| `loadRadius` | `1` | Default radius for `loadAround()`; `1` is the 3x3 block of chunks. |
| `loadWait` | `500` | ms to wait for snapshots after subscribing. Raise it on a slow connection if chunks stay `?`. |
| `solverPadding` | `2` | Cells of context loaded around a solved rectangle, so numbers just outside it still constrain cells inside. |

**`memory`** — see [Memory](#memory)

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxScriptChunks` | `300` | Cap on chunks the bot itself keeps subscribed. Beyond it, the least recently used are released. `0` disables the cap. |
| `releaseOnFinish` | `true` | When `solveRadius` / `solveArea` / `autoSolve` ends, release every chunk it loaded except the 3x3 around your view. |

**`click`** — [click mode](#click-mode)

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Act by simulating real mouse clicks instead of sending messages. |
| `responseWait` | `1500` | ms to wait for the game to react to a simulated click. |
| `guardAfterClick` | `300` | ms to keep dropping duplicate actions after a click. |
| `guardAfterTimeout` | `2000` | ms to block late actions after a click timed out. |
| `maxTimeouts` | `3` | Turn click mode off after this many timeouts in a row. |
| `maxSamples` | `50` | Remembered screen-point-to-cell samples. |
| `fitSamples` | `15` | Most recent samples used to fit the cell grid. |
| `minSpread` | `4` | Minimum sample spread before a fitted cell size is trusted over the prior. |
| `edgeMargin` | `0.3` | Keep clicks this fraction of a cell away from the board edge. |
| `dragThreshold` | `4` | px of pointer movement counted as dragging the view (invalidates calibration). |
| `matchBefore` / `matchAfter` | `50` / `1500` | ms window in which an action is attributed to your `pointerdown`. |

**`logging`**, **`display`**, **`net`**

| Setting | Default | Meaning |
| --- | --- | --- |
| `logging.actions` | `false` | Print every action as it is sent. |
| `logging.maxEntries` | `5000` | `actionLog` ring-buffer size. |
| `display.areaWidth` / `areaHeight` | `30` / `20` | Default size for `printArea()`. |
| `net.socketUrlMatch` | `'infiniteminesweeper.com/ws'` | Substring that identifies the game socket. |
| `net.resyncTimeout` | `10000` | ms to wait for the game to reconnect in `resyncUI()`. |
| `net.resyncPoll` | `200` | ms between reconnect checks. |
| `net.resyncSettle` | `1500` | ms to let the game resubscribe after reconnecting. |

## How it works

**Socket hook.** `WebSocket.prototype.send` is wrapped to spot the game's connection and to see
every outgoing message. Incoming frames are trickier: the game hands each buffer off (detaching it)
as soon as it reads it, often before a `message` listener of ours would run. So instead of relying on
listener order, the bot overrides the `MessageEvent.prototype.data` getter and copies the frame the
first time anyone reads it. Frames are then decompressed and decoded in a promise chain, strictly in
order.

Both originals are stashed on `globalThis` on first paste, so re-pasting re-wraps from the pristine
functions instead of stacking hooks, and `msbot.dispose()` (called automatically by the next paste)
puts everything back.

**Board model.** The world is split into 64x64-cell chunks. `chunks` maps `"cx,cy"` to a
`Uint8Array(4096)` of raw cell bytes, filled from full snapshots (message 29) and kept current by
rectangle patches (message 16). Because the bot reads the same stream the game does, it sees other
players' moves as they happen.

**Chunk lifecycle.** The server only sends a snapshot when you *newly* subscribe, so `loadChunks()`
does what the game does when scrolling: unsubscribe, then subscribe again. Chunks the bot
subscribed to are tracked separately from the game's own subscriptions (and stamped for LRU), and
are released when no longer needed — never one the game is displaying. See [Memory](#memory).

**Acting.** Every action goes through `act()`, which either simulates a click (click mode) or sends
an action message directly. Frames the bot builds are tagged in a `WeakSet` so the log can tell
your clicks from the bot's actions.

**Score display.** The game's own score counter doesn't notice automated actions, but the server
sends your totals on every connect — `resyncUI()` exploits that by dropping the socket and letting
the game reconnect. Points are also tracked in `msbot.stats.score` from the server's action results.

## Memory

Every chunk the bot subscribes to costs something in three places: the bot's own copy (4 KB), the
server pushing every patch for it, and the game itself, which receives those same frames and does
its own work with them. Over a long run that adds up, so the bot only keeps what it is using:

- **LRU cap.** Each time the solver asks for an area, the chunks it needs are marked as used. If the
  bot then holds more than `memory.maxScriptChunks`, it unsubscribes the least recently used ones,
  never the ones just requested and never ones the game itself subscribed to. This is what bounds a
  long `nearest`-mode scan, which can otherwise load a ring of chunks per candidate area.
- **Release between areas.** `autoSolve` also drops everything except the next area and your own
  view each time it moves on.
- **Release on finish.** When a solver command ends (or is stopped), the chunks it loaded go too,
  except around your view. The catch: cells outside your view read as `?` afterwards until you
  `loadAround()` again. Set `memory.releaseOnFinish: false` if you'd rather keep them.
- **Bounded logs.** `actionLog` keeps the last `logging.maxEntries` actions, and click samples are
  capped by `click.maxSamples`.

Unsubscribing is what frees the data: it stops the server sending the chunk and makes the bot drop
its copy. `memoryStatus()` shows the current numbers, and `await cleanup()` does a manual sweep.

If the tab still slows down after hours, check `memoryStatus()` first. If `subscribedByBot` and
`chunksInMemory` are small, the growth is elsewhere: the DevTools console keeps every message it
prints (`console.clear()` helps, and `logging.actions: false` is the default for that reason), and the
game may keep chunk data it received while the bot had them subscribed. `await resyncUI()`
reconnects the socket and makes the game rebuild its state, which is the closest thing to a reset
short of reloading the page.

## The solver

`planSolve(x0, y0, x1, y1)` is a pure function of the current board copy: it returns
`{ flags, chords, reveals, unknownCells, contradictions }` and touches nothing. It builds one
constraint per revealed number (its hidden neighbours, and how many mines are still missing) using
numbers up to one cell *outside* the rectangle, then applies three rules:

1. A number whose mines are all accounted for — its remaining hidden neighbours are safe.
2. A number with exactly as many hidden neighbours as missing mines — all of them are mines.
3. **Subset rule**: if constraint A's hidden cells are a subset of B's, the cells only B has hold
   exactly `B.missing - A.missing` mines. Zero means all safe; all of them means all mines.

Flags and revealed mines both count as known mines. A constraint with an `unknown` (unloaded)
neighbour is dropped rather than guessed at. Safe reveals are grouped into **chords** where one
click opens two or more hidden neighbours of a finished number, which is fewer messages for the same
work.

Safety rails, in order:

- Nothing but certainties. There is no guessing heuristic anywhere; when deductions run out, the
  area is reported `stuck (needs a guess)`.
- A cell deduced both safe and mined counts as a contradiction and is skipped — the board copy is
  shared with other players and can be mid-update.
- Every move is re-checked against the board immediately before it is sent, because another player
  may have got there first.
- After each pass the results are read back from the board. Confirmed flags and reveals are
  reported; a revealed mine stops the loop (and should never happen).
- `autoSolve` also stops when a pass sends actions but nothing changes on the board, which is what a
  rate limit or a lost socket looks like.

The deduction rules are checked against randomly generated consistent boards by
`node tools/test-solver.js` — currently ~46,000 deductions over 300 boards with no unsafe move.

### autoSolve modes

`nearest` (default) always returns to the closest unfinished area to where `autoSolve` started, which
keeps the cleared region compact around one point. Solved areas are remembered and never revisited;
stuck ones are reconsidered once work happens next to them. Candidates are examined one distance band
at a time, so an unbounded `maxRadius` costs nothing until the search actually reaches that far.

`mostWork` hops to whichever neighbouring area has the most safe moves waiting, searching rings of
candidate areas outward. It follows the frontier and covers ground fast.

## Click mode

Off by default. Instead of sending action messages, the bot dispatches a full pointer/mouse event
sequence on the board element so the game runs its own click handling (animations, sounds, and
hopefully the score). It exists because automated messages leave the game's UI out of sync — it
didn't fix the score display, so it is off, but the machinery is intact.

It calibrates itself from **your** real clicks: each click gives a screen-point-to-cell sample, and
a least-squares fit over recent samples yields the cell size and grid origin. Dragging, scrolling and
resizing bump an epoch counter that invalidates stale samples; between fits, the game's own position
messages are used to shift the origin.

The interesting part is the guard. Around a simulated click, the game's outgoing messages are held
instead of sent, and the action the game produces is compared with the intended cell. If it
disagrees, the message is rewritten to the intended cell, keeping the game's request id, so a
misclick can never act on the wrong cell. Actions nobody asked for are dropped. If the game stops
responding to simulated clicks, the bot falls back to direct messages.

Turn it on with `setConfig({ click: { enabled: true } })`, then click one cell manually to
calibrate; `boardStatus()` shows whether calibration succeeded.

## Protocol notes

Everything is gzipped protobuf over a WebSocket at `infiniteminesweeper.com/ws`. The bot hand-rolls
just the varint/length-delimited bits it needs, so there is no dependency and no `.proto` file.
Field names below are the bot's own; they were derived by watching traffic.

Incoming (top-level field number = message type):

| Field | Meaning |
| --- | --- |
| 19 | Your profile on connect; field 5 is the score. |
| 8 | Result of one of your actions; field 6 holds `{ 1: score, 2: points for this action }`. |
| 29 | Full chunk snapshots: repeated field 1, each `{ 1: chunk coords, 3: 4096 cell bytes }`. |
| 16 | Live patches: field 1 is the chunk, each field 3 is `{ 1: x, 2: y, 3: w, 4: h, 5: bytes }`. |

Outgoing:

| Field | Meaning |
| --- | --- |
| 4 | Action: `{ 1: client timestamp (used as the request id), 2: chunk, 3: row * 64 + col, 4: 1 = flag, 5: 1 = chord }`. Reveal is neither flag nor chord. |
| 12 | Subscribe to chunks (field 1 repeated, field 2 = 64). |
| 13 | Unsubscribe from chunks. |
| 5 | The game reporting your view: `{ 1: chunk, 2: cell index, 3: width, 4: height }` in cells. |

Other details:

- **Cell byte**: `0` hidden, `1` revealed mine, `2`-`9` a number `0`-`7`, `10+` a flag whose colour
  is `value - 10` (one per player).
- **Coordinates**: chunk coordinates are zigzag-encoded signed varints (`0, -1, 1, -2, 2` →
  `0, 1, 2, 3, 4`); cells inside a chunk are `row * 64 + col`. Global cell coordinates are
  `chunk * 64 + offset` and can be negative — the world is infinite in all directions.
- **Compression**: every frame in both directions is gzipped, via `CompressionStream` /
  `DecompressionStream`.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Nothing happens, `boardStatus()` says `socket: not captured` | Scroll or click once in the game; the hook needs one outgoing message. |
| `Position unknown` | The game hasn't reported a view yet. Scroll a little, or pass `{ center: [x, y] }`. |
| Cells print as `?` | Those chunks aren't loaded: `await loadAround(2)`, or raise `board.loadWait` on a slow link. |
| `received` climbs but `snapshots` and `patches` stay `0` | The protocol changed, or the frames aren't being decoded. Check `stats.lastError`. |
| `detached` is climbing | Frames arrived already emptied and the board may be missing updates. Reload and re-paste. |
| `autoSolve` stops with "no area with a safe move found within range" | Nothing solvable within `maxRadius` / `maxRings`, or a blank gap wider than `auto.giveUpAfterEmpty` steps separates you from more work. Raise `giveUpAfterEmpty`, or move closer and pass `{ center: [x, y] }`. |
| Solver reports `no progress (actions not taking effect)` | Likely rate-limited or the socket dropped. Slow down (`solver.actionDelay`) and check `boardStatus()`. |
| Tab gets slow over a long run | `memoryStatus()`; lower `memory.maxScriptChunks`, run `await cleanup()`, `console.clear()`, or `await resyncUI()`. See [Memory](#memory). |
| Cells read `?` after a solver finished | `releaseOnFinish` freed them. `await loadAround()` again, or turn the setting off. |
| Score in the page doesn't move | Expected for direct messages; run `await resyncUI()`. `msbot.stats.score` has the real value. |
| `stuck (needs a guess)` | Working as intended: no certain move is left. Reveal a cell yourself and carry on. |
| `SyntaxError: Identifier ... has already been declared` | An older, pre-`msbot` version of the file is loaded. Reload the page, then paste the current file. |

## Repo layout

```
infiniteMinesweeperBot.js   the bot: paste this into the console (sections 1-18, see its header)
config.defaults.js          pristine copy of the default settings
tools/check-defaults.js     verifies the two copies of the defaults agree (--fix to sync)
tools/test-solver.js        loads the bot in Node and checks the solver, config and encoder
README.md                   this file
LICENSE                     MIT
```

The bot file is organised in numbered sections, listed in the header comment: config and its
plumbing first, then the socket hook, protobuf, message handlers, board reads, chunk loading, the
action log, click mode, actions, the solver, diagnostics, and the public API last.

## Developing

**Adding a setting.** Add it to `CONFIG` (section 1) *and* to `DEFAULT_CONFIG` (section 2) with the
same value, read it as `config.<section>.<name>` at the point of use (not captured into a local at
load time, so live changes take effect), then run `node tools/check-defaults.js --fix` and document
it in the table above. Unknown keys in section 1 are reported on paste, which usually catches a typo
straight away.

**Adding a message type.** Log the raw fields of an unhandled type in `handleIncoming` /
`handleOutgoing`, watch it in the console while playing manually, then decode it with `toObj()` /
`fields()`. Keep handlers synchronous — they run inside the ordered frame queue.

**Testing without a browser.** `node tools/test-solver.js` does exactly this: it loads the bot with
two stubs and checks the config plumbing, cell decoding, coordinates, the action encoder and — the
part that matters — that the solver's deductions are sound on hundreds of random boards. Run it after
touching `planSolve` or the protobuf helpers.

The file is an IIFE that only needs `window.addEventListener`,
`document.elementFromPoint`, `WebSocket`, `MessageEvent`, `Blob` and the compression streams, all of
which exist in Node 22. Stub the two DOM bits, `eval` the file, and the whole API is on
`globalThis.msbot`:

```js
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { elementFromPoint: () => null };
eval(require('node:fs').readFileSync('infiniteMinesweeperBot.js', 'utf8'));

msbot.chunks.set('0,0', myUint8Array);       // hand-built board
msbot.planSolve(10, 10, 39, 39);             // pure, no socket needed
```

That is how the deduction rules are checked: generate a random consistent field, reveal a random
subset, hand it to `planSolve`, and assert that no flag lands on a safe cell, no reveal lands on a
mine, and no chord would open one. Add cases to `tools/test-solver.js` when you add a rule.

**Style.** Plain ES2022, no dependencies, no build step. It has to stay a single file that survives
a copy-paste into a console, so keep it free of imports, `export`s and top-level `await`. Prefer
adding to the numbered sections over creating new ones, and keep the comments explaining *why* the
odd bits (the `MessageEvent` getter, the unsubscribe/subscribe dance, the click guard) exist.

## Limitations

- **No guessing.** When certainties run out the bot stops. Probability-based play would need a
  frontier enumerator, which doesn't exist here.
- **No global mine count**, so the classic endgame counting rule doesn't apply — an infinite board
  has no total to subtract from.
- The subset rule is the strongest deduction implemented; constraint-set enumeration would find more
  (at a cost) and is the obvious next step.
- The game's UI stays out of sync with automated actions apart from `resyncUI()`.
- Field numbers were reverse-engineered by observation and can break whenever the site updates.
  `boardStatus()` is the first place to look when that happens.

## License

MIT — see [LICENSE](LICENSE).
