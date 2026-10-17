# Plan: a day cursor with no fixed size limit

**Written:** 14 October 2026. Plan only, nothing built.
**Builds on:** D5 (the day cursor) and D6 (live acceptance) of `docs/plans/scale-and-profiles-initiative.md`, and `docs/plans/incremental-days.md`

The day cursor lets a pass that stopped part way through resume at the next day, and lets a later stage reuse a finished pass. Today it saves only states under 64 MB (`CURSOR_MAX_BYTES` in `src/scan/passes.js`). Mellow's state is over that, so on the sites where resume matters most the cursor has never saved.

The goal is a cursor whose size is limited by the machine, not by the format. Nothing in the codec or the stores below has a size limit. What limits a save is the heap that holds the state and the disk that receives it, and both are checked before each save. A configurable cap stays as a guard against runaway disk use, with a default of 16 GiB.

## Why the cap cannot just be raised

Four things in the current path break well before 16 GiB:

1. **String length.** `encodeSnapshot` builds the whole `nodes` array, then calls `JSON.stringify` once. `decodeSnapshot` calls `JSON.parse` once. V8 caps a string at about 512 MiB, so any state past that throws, whatever the cap says.
2. **Memory.** Encoding holds the live state, the `nodes` array (a second copy of the graph), and the text (a third copy). Decoding holds the text, the parsed tree, and the rebuilt state. The insert then escapes the text into a JSON row, which makes a fourth copy.
3. **Write volume.** `scanDays` saves after every day (`src/scan/day-scan.js`, line 83). Mellow's window is 75 days, so a 16 GiB state would write about 1.2 TiB per pass.
4. **Where it is stored.** The cursor text goes into `ae_analysis_checkpoint.notes`, and `loadCheckpoints` reads `notes` for every checkpoint of the site. Every checkpoint load would pull the whole cursor, even when the caller never resumes.

One more limit appears once the string limit is gone: a JavaScript `Map` holds at most 16,777,216 entries (checked on Node 25.6). The encoder's identity map has one entry per object, so a large state passes that.

So the fix has five parts: a streaming codec, an identity map without the `Map` limit, a chunked store of its own, a save cadence tied to cost, and heap and disk checks.

## C1. A streaming codec (`src/scan/snapshot.js`, format 3)

The model stays: Maps, Sets, arrays, and plain objects as nodes, with references by id, so shared identity survives (the trigger folder holds one session in several maps). What changes is the form on the wire.

**Encoding.** `encodeSnapshotStream(root, {maxBytes})` is an async generator that yields Buffer chunks of about 8 MiB. The text is newline-delimited JSON, one record per line:

- a header line: the format version, the top value, and the caller's key;
- node records in the order the walk reaches them;
- a footer line: node count, record count, byte count, and the SHA-256 of every byte before it.

A reference names its node's type as well as its id (`{"r":12,"t":"m"}`), so the decoder can create an empty shell when a reference arrives before its node. A large Map, Set, array, or object is split into continuation records of at most 1 MiB each, which all append to the same shell. A single string over 1 MiB is split the same way. No line is ever large, and no string near the V8 limit is built on either side.

The walk does not keep encoded nodes. It keeps the identity map and the current chunk. Chunks are cut only at line ends. Byte counts and ids are plain numbers, which stay exact far past any size here.

The encoder counts bytes as it goes. Once the count passes `maxBytes` it throws `CursorTooLarge`, and the caller drops the partial write.

**Identity map.** The map from object to id becomes a chain of `Map`s. A new one starts when the current one reaches 16,000,000 entries, and a lookup checks the newest first. The cost is one extra lookup per full map, which is small next to writing the text.

A part can also declare that it has no shared identity. Its objects are then written inline without ids and never enter the map. The page pass's `page-rows` (through `mapState`) is the first case. Only the parts that need identity, the trigger folder and the open-visit lanes, pay for the map.

**Decoding.** `decodeSnapshotStream(chunks)` reads Buffers and splits them on the newline byte. That is safe at any chunk boundary, since UTF-8 never uses 0x0A inside a multi-byte character and JSON escapes newlines in strings. Each line is parsed alone and filled into its shell. The id-to-shell table is an array of fixed-size blocks rather than one array, so it has no length limit either. The decoder checks the footer's counts and hash, and returns null on any mismatch, a missing footer, or a reference that was never filled. Peak memory is the rebuilt state, the id table, and one chunk.

**Mutation during an encode.** The encoder awaits each chunk's write, so the event loop runs between chunks. The scan awaits `cursor.save` before it folds the next day, and nothing else touches folder state, so the graph cannot change mid-encode. A test pins this invariant.

The sync `encodeSnapshot` and `decodeSnapshot` stay, as thin wrappers over the streams, for the tests and small states. Format 2 text is no longer read: `CURSOR_VERSION` goes to 3, and a format 2 cursor is ignored as a key mismatch, so the pass scans from the start.

## C2. A cursor store port, with `memory` and `local` adapters

The cursor moves out of `ae_analysis_checkpoint` into a port of its own, `src/ports/cursor-store.js`. It follows the day store: adapters chosen by `ANALYSIS_CURSOR_STORE` and opened in `src/composition/engine.js` the way `openDayStore` is. This plan builds `memory` and `local`, and `local` is the default. A `clickhouse` adapter, for resuming on another machine, is designed below under "Deferred" and not built.

```js
/**
 * @typedef {{batchId: string, idsite: number, cursor: string}} CursorId  cursor: 'day-scan:site' | 'day-scan:page'
 * @typedef {{key: object, day: string, bytes: number, stored: number, parts: number, sha256: string}} CursorHead  stored: bytes on disk after compression
 * @typedef {object} CursorStore
 * @property {(id: CursorId) => Promise<CursorHead | null>} head  the last committed save, without its body
 * @property {(id: CursorId, head: CursorHead) => AsyncIterable<Buffer>} body  that save's chunks, in order
 * @property {(id: CursorId, key: object, day: string, chunks: AsyncIterable<Buffer>) => Promise<CursorHead>} write  commits only after every chunk is stored
 * @property {(id: CursorId) => Promise<void>} clear
 * @property {(id: CursorId) => Promise<number | null>} [freeBytes]  space left for a write, when the adapter can tell
 */
```

The head is read before the body. A key that does not match (another window, other pages, a new version) is rejected without reading gigabytes. A write commits only by writing the head after the body, so a torn write leaves the previous save in place.

**`memory`.** Arrays of Buffers in a Map. Used by tests and the acceptance harness.

**`local`.** Files under `ANALYSIS_CURSOR_STORE_DIR`, by default `~/.cache/analysis-engine/day-cursors/<batch>/<idsite>/<cursor>/`.

- A write streams the chunks through a compressor into a temporary file, then fsyncs it and renames it to the body file. It then writes `head.json` the same way. The previous body is removed after the rename.
- A read streams the file back through the decompressor. No whole-file buffer is ever built.
- The compressor is gzip at level 1. The default gzip level is several times slower, which at this size is minutes per save. The package allows Node 22.13; if the floor moves to 22.15, zstd (`zlib.createZstdCompress`) replaces gzip.
- `freeBytes` reads `fs.statfs` for the store's disk. During a write the old body and the new one both exist, so a save needs room for one more copy.
- `clear` removes the cursor's directory at once.
- **14-day expiry.** A cursor that is never cleared belongs to a run that stopped and did not come back. When the store opens, it removes every cursor directory whose `head.json` is more than 14 days old, along with any temporary file left by a write that died. `ANALYSIS_CURSOR_KEEP_DAYS` changes the 14.

This is the temp-and-rename pattern of `src/adapters/day-store/local.js`, except that the chunks stream.

**What changes in the handlers.** `cursorStore` in `src/site-analysis/handlers.js` stops writing `notes` and calls the port. `clearCursors` calls `clear`. For one release, it also writes `''` to the old `day-scan:site` and `day-scan:page` checkpoint rows, so no old cursor text lingers in `notes`. `loadCheckpoints` is unchanged, and no longer meets a cursor blob.

`dayCursor` in `src/scan/passes.js` takes the store and id instead of a `{load, save}` pair. Its load reads the head, checks the key, decodes the body, and checks lanes and parts as it does now. Its save streams `encodeSnapshotStream` into `write`.

## C3. Save cadence by cost

Saving after every day stays right for small states and is wrong for large ones. The new rule in `scanDays`:

- Always save after the last day, since a later stage reuses that state.
- Otherwise save after a day when the expected save time is at most a share (default 10%) of the fold time since the last save. The expected save time is the last save's duration, or zero before the first save.

A 5 MB state saves every day, as now. A state whose save takes five minutes saves after about 50 minutes of folding. The share is configurable (`ANALYSIS_CURSOR_SHARE`; 0 means only the last day).

Resume is still exact. A resume starts at the day after the last save and refolds the days since, which the day store serves without warehouse reads when it holds them.

## C4. The cap, the heap check, and the disk check

- **The cap.** `CURSOR_MAX_BYTES` becomes 16 GiB by default, set by `ANALYSIS_CURSOR_MAX_BYTES`, where 0 means no cap. It counts the codec's text bytes, exactly, as they stream out. A state past it is dropped with its size so far in the warning.
- **The heap check.** Before a save, `dayCursor` checks `v8.getHeapStatistics()`. The save needs headroom for the identity map plus two chunks. After the first save the map's cost is known from that save's node count and heap growth. Before it, the check asks for headroom of a quarter of the heap in use. Without the headroom, the save is skipped with a warning (`day cursor not saved: heap headroom`) and the scan goes on. A full heap must never take down a scan that would otherwise finish.
- **The disk check.** When the store reports `freeBytes`, the save needs room for the last save's stored size plus a margin, or a quarter of the cap's compressed estimate before the first save. Without the room, it is skipped with a warning (`day cursor not saved: disk`). A write that still runs out of disk fails like any torn write: the previous save stays, and the temporary file is removed.
- **Restore needs the same heap.** A resume rebuilds the whole state in memory, as the scan held it before it stopped. A cursor saved by a 32 GB process cannot be restored by an 8 GB one. On a load that would not fit (the head's byte count against the heap limit), the pass scans from the start with a warning, rather than running out of heap part way through the decode.
- **Heap settings.** The 8 GB acceptance heap is too small for the largest states. Acceptance on Mellow uses the 32 GB setting from `skills/site-analysis/SKILL.md`, and the analysis stage already sizes its heap to the machine (`bin/analyze-site.mjs`).

## C5. Tests

Codec (`test/scan/snapshot.test.js`):

- round trips: Maps, Sets, nested objects, shared references, cycles, a reference that arrives before its node, and a node split into continuation records;
- chunk cuts at every byte offset of a small state, including inside multi-byte characters;
- a missing footer, a wrong hash, a dropped chunk, and a never-filled reference each decode to null;
- the cap stops at exactly `maxBytes`, and 0 means no cap;
- the identity map rolling to a new `Map`, with a test-sized limit, and a reference resolved across the roll;
- a part declared without shared identity, written inline;
- the existing trigger-folder identity tests, run through the stream;
- one test over the 512 MiB string limit (a synthetic state of about 700 MiB), and one over the `Map` limit (17 million objects). Both are gated behind an env flag, since they need a large heap and minutes.

Store contract (a single suite run against `memory` and `local`, so a later adapter can join it):

- a write followed by a read returns the same bytes;
- a write that throws part way reads as the previous save;
- two saves in a row read back as the second;
- clear, then read, returns null;
- a key mismatch is rejected from the head alone;
- for `local`, a write that fails for lack of disk leaves the previous save and no temporary file;
- for `local`, opening the store removes cursors older than the keep days and stray temporary files, and keeps newer ones (with a fake clock).

Scan:

- the cadence rule against a fake clock;
- the existing `clickhouse local` resume test, rerun with the `local` cursor store in a temporary directory and a 64 KiB chunk size, so a small state spans many chunks;
- the heap and disk skips, with injected readings, and a restore skipped for heap.

## C6. Docs, migration, and acceptance

- **Schema.** None. The cursor leaves `ae_analysis_checkpoint.notes` and no table is added.
- **Docs.** `docs/ARCHITECTURE.md` (the day-cursor line at 139 and principle 10 at 424) changes from "64 MB cap, reuses checkpoints" to the store, the cadence, and the checks. D5 in the initiative plan gets an "As changed" note pointing here.
- **Acceptance on Mellow.** `scan-acceptance.mjs` runs with the `local` cursor store, so it writes only files on this machine and no tables. It reports per save the text bytes, stored bytes, parts, node count, encode, write, read, and decode times, and peak heap. The run is killed after its second save. The rerun must resume from that day and produce the same hits and dataset row counts as an uninterrupted run, with the known `campaign-weekly` noise excepted.

## Order of work

1. C1, the codec and identity map, with their tests.
2. C2, the port, with `memory` and `local` and the contract suite. Then the handlers switch over.
3. C3 and C4, the cadence and the checks.
4. C6, acceptance on Mellow, then the docs.

## Decided

- **Store:** `local` only. It covers resume on the machine that saved, which is also the day store's default. (User, 14 October 2026.)
- **Expiry:** 14 days for a cursor that is never cleared. (User, 14 October 2026.)
- **Cap:** 16 GiB by default, configurable, 0 for none. No measuring pass before building. (User, 14 October 2026.)

## Deferred: a `clickhouse` adapter

Built only when a run needs to resume on another machine, and the schema needs a go-ahead then. It joins the same contract suite. The design, kept here so the port does not need to change:

- **Tables.** `ae_scan_cursor_part` (batch, idsite, cursor, slot, part, payload as `String CODEC(ZSTD(3))`, `generated_at`), ordered by `(batch_id, idsite, cursor, slot, part)`. `ae_scan_cursor_head` (batch, idsite, cursor, slot, parts, bytes, sha256, day, key, `generated_at`), ordered by `(batch_id, idsite, cursor)`. Both are `ReplacingMergeTree(generated_at)` with a 14-day TTL, following `ae_scan_day`'s part pattern, with no delete mutations.
- **Two slots.** A write goes to the slot the head does not point at, with one new `generated_at` on every 8 MiB part, inserted eight parts per request. The head row naming that slot is written last, so a torn write leaves the other slot whole.
- **Reads.** The head (`FINAL`, one row), then `WHERE slot = ? AND generated_at = ? ORDER BY part LIMIT 1 BY part` as a row stream, with the part count and hash checked.
- **Clear.** A head with `parts = 0`; body rows age out by TTL.
- **No `freeBytes`.** The engine does not query `system.*` tables, so the cap is the guard.
