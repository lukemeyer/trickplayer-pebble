#!/usr/bin/env node
"use strict";

// Conformance runner — Pebble.
//
// Runs the SHIPPING PKJS modules (src/pkjs/*.js, the same files the watch's
// phone side loads) against the vendored corpus/. That is only possible
// because timeline.js and subs.js are written to run under both PKJS and
// Node, which was a Phase 0 decision on this project and is now load-bearing
// for a second reason.
//
// corpus/ is vendored from trickplayer-knowledge; never edit it here. Run
// that repo's tools/corpus/sync-corpus.sh to refresh it.
//
//   node spikes/tools/conformance.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CORPUS = path.join(ROOT, "corpus");

const timeline = require(path.join(ROOT, "src/pkjs/timeline.js"));
const subs = require(path.join(ROOT, "src/pkjs/subs.js"));
const scenepolicy = require(path.join(ROOT, "src/pkjs/scenepolicy.js"));

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(CORPUS, rel), "utf8"));

let pass = 0;
const failures = [];
const skipped = [];

function check(group, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push({ group, name, expected: e, actual: a });
}
function skip(group, name, why) { skipped.push({ group, name, why }); }

// ---------------------------------------------------------------- timeline

(function checkTimeline() {
  const buf = fs.readFileSync(path.join(CORPUS, "timeline/synthetic.bif"));
  const bytes = new Uint8Array(buf);
  const exp = readJson("timeline/synthetic.expected.json");

  const header = timeline.parseHeader(bytes);
  check("timeline", "multiplier (file stores 0 => 1000)", header.multiplier, exp.multiplierMs);
  check("timeline", "frameCount", header.count, exp.frameCount);
  check("timeline", "indexBytes", header.indexBytes, 64 + exp.indexByteLength);

  const index = timeline.parseIndex(bytes, header);
  check("timeline", "frames", index.map((f, i) => ({
    index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
  })), exp.frames);

  const sum = index.reduce((n, f) => n + f.length, 0);
  check("timeline", "invariant sum(lengths)+header+index == file size",
    sum + exp.invariant.headerPlusIndex, exp.fileByteLength);

  let threw = false;
  try {
    const notBif = new Uint8Array(bytes); notBif[1] = 0;
    timeline.parseHeader(notBif);
  } catch (e) { threw = true; }
  check("timeline", "rejects non-BIF magic", threw, true);

  // The two fixtures synthetic.bif cannot catch: a real multiplier, and a
  // file longer than the sentinel's EOF. Both are shapes real Plex output
  // does not produce, which is exactly why a buggy parser survives on it.
  for (const name of ["multiplier", "trailing"]) {
    const b = new Uint8Array(fs.readFileSync(path.join(CORPUS, `timeline/${name}.bif`)));
    const e = readJson(`timeline/${name}.expected.json`);
    const h = timeline.parseHeader(b);
    check("timeline", `${name}: multiplier`, h.multiplier, e.multiplierMs);
    check("timeline", `${name}: frames`, timeline.parseIndex(b, h).map((f, i) => ({
      index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
    })), e.frames);
  }

  // pickFrames is still the fixed-interval policy this build ships.
  const picked = timeline.pickFrames(index, 4000);
  check("timeline", "pickFrames(4000ms) over 2s spacing", picked, [0, 2, 4, 6, 8, 10]);

})();

// -------------------------------------------------------------------- subs

(function checkSubs() {
  const text = fs.readFileSync(path.join(CORPUS, "subs/torture.srt"), "utf8");
  const exp = readJson("subs/torture.expected.json");
  const got = subs.parse(text);

  check("subs", "cueCount", got.length, exp.cueCount);
  check("subs", "cues", got.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), exp.cues);

  for (const w of exp.cuesInWindow) {
    // Pebble's cuesInWindow returns TEXT, not cue objects, so compare by
    // resolving expected start times to their text.
    const wantText = w.expectStartMs.map(
      (ms) => exp.cues.find((c) => c.startMs === ms).text
    );
    check("subs", `cuesInWindow [${w.fromMs},${w.toMs})`,
      subs.cuesInWindow(got, w.fromMs, w.toMs), wantText);
  }
})();

// -------------------------------------------------------------- encodings

(function checkSubEncodings() {
  const exp = readJson("subs/torture.expected.json");
  const enc = readJson("subs/encodings.expected.json");
  for (const v of enc.variants) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(CORPUS, v.file)));
    const cues = subs.parse(subs.decodeBytes(bytes));
    check("encoding", `${v.file} cueCount`, cues.length, exp.cueCount);
    check("encoding", `${v.file} cues`,
      cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), exp.cues);
  }
  const plain = new Uint8Array(fs.readFileSync(path.join(CORPUS, "subs/torture.srt")));
  check("encoding", "no BOM still decodes as UTF-8",
    subs.parse(subs.decodeBytes(plain)).length, exp.cueCount);
})();

// ------------------------------------------------------------------- scene

(function checkScene() {
  // Blank filtering and the usable floor, independent of binning policy.
  const exp = readJson("scene/filter.cases.json");
  for (const c of exp.cases) {
    // Callers hand the policy the SEAM's frame shape now: the byte length
    // becomes a size hint, and the BIF entry becomes an opaque locator.
    const index = c.lengths.map((len, i) => ({
      tsMs: i * 2000, sizeHint: len, locator: { offset: 0, length: len },
    }));
    const picked = index.map((_, i) => i);
    const r = scenepolicy.filterBlank(index, picked, c.blankThresholdPct);
    check("scene", `${c.name}: medianLength`, r.medianLength, c.expectMedianLength);
    check("scene", `${c.name}: usable`, r.usable, c.expectUsableIndices);
  }

  // The floor: dropping duplicates must not gut a static episode. Every frame
  // here shares a length, so length-run dedup would leave almost nothing.
  const flat = Array.from({ length: 12 }, (_, i) => ({
    tsMs: i * 2000, sizeHint: 10, locator: { offset: i * 10, length: 10 },
  }));
  flat[0].sizeHint = 100000; // one large frame drags the median up
  const floored = scenepolicy.buildScenes(flat, null, {
    durationMs: 24000, skipSilent: false, minUsable: 8,
  });
  check("scene", "floor: keeps everything rather than degrading to nothing",
    floored.scenes.length, flat.length);

  // The adopted policy: native frame timings, length-run duplicate skipping,
  // empty-scene removal (F-001 + F-036).
  const fx = readJson("scene/episode.frames.json");
  const cx = readJson("scene/episode.cues.json");
  const want = readJson("scene/episode.expected.json").cases.adopted.expect;
  const seamFrames = fx.frames.map((f) => ({
    tsMs: f.tsMs, sizeHint: f.length, locator: { offset: f.offset, length: f.length },
  }));
  const built = scenepolicy.buildScenes(seamFrames, cx.cues, {
    durationMs: fx.durationMs, blankPct: 15, skipSilent: true, minUsable: 8,
    hasFrameSizeHints: true,
  });
  check("scene", "adopted: sceneCount", built.scenes.length, want.sceneCount);

  const seen = new Set();
  let bytes = 0, cueTotal = 0;
  for (const sc of built.scenes) {
    const f = fx.frames[sc.frameIndex];
    if (!seen.has(f.offset)) { seen.add(f.offset); bytes += f.length; }
    cueTotal += cx.cues.filter(
      (c) => c.startMs >= sc.windowStartMs && c.startMs < sc.windowEndMs).length;
  }
  check("scene", "adopted: sceneBytes", bytes, want.sceneBytes);
  check("scene", "adopted: uniqueFramesShipped", seen.size, want.uniqueFramesShipped);
  check("scene", "adopted: avgCuesPerScene",
    +(cueTotal / built.scenes.length).toFixed(4), want.avgCuesPerScene);

  // Duplicate detection is from declared length alone — no bytes fetched.
  const dup = scenepolicy.lengthRunDuplicates(seamFrames);
  const truth = fx.frames.map((f) => f.duplicateOfIndex !== null);
  let fp = 0, missed = 0;
  dup.forEach((d, i) => { if (d && !truth[i]) fp++; if (!d && truth[i]) missed++; });
  check("scene", "length-run dedup: no false positives on the fixture", fp, 0);
  check("scene", "length-run dedup: none missed on the fixture", missed, 0);

  // A source with no per-frame sizes: both filters SKIPPED, not faked
  // (SEAM.md §4). Before the seam refactor this build could not express it.
  const noSize = fx.frames.map((f) => ({ tsMs: f.tsMs, sizeHint: null, locator: {} }));
  const wantNo = readJson("scene/episode.expected.json").cases["no-size-hints"].expect;
  const degraded = scenepolicy.buildScenes(noSize, cx.cues, {
    durationMs: fx.durationMs, skipSilent: true, minUsable: 8,
    hasFrameSizeHints: false,
  });
  check("scene", "no size hints: sceneCount", degraded.scenes.length, wantNo.sceneCount);
  check("scene", "no size hints: nothing judged blank", degraded.blanksSkipped, 0);
  check("scene", "no size hints: nothing judged duplicate", degraded.duplicatesSkipped, 0);
  check("scene", "no size hints: differs from the filtered run",
    degraded.scenes.length > built.scenes.length, true);
})();

// -------------------------------------------------------------------- cues

(function checkCues() {
  skip("cues", "wrap / paginate",
    "F-002 not implemented on Pebble — the face wraps text itself in " +
    "src/embeddedjs/face.js with no pagination.");
})();

// -------------------------------------------------------------------- real

// Real captured fixtures contain actual frame bytes from licence-free
// content. corpus/real/ may be empty — it is a slot, and this must degrade
// cleanly rather than fail.
(function checkReal() {
  const dir = path.join(CORPUS, "real");
  // Plex captures only: a Jellyfin fixture is tile sheets with no .bif, and
  // this build has no Jellyfin provider to check it with yet.
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".expected.json"))
        .map((f) => f.replace(/\.expected\.json$/, ""))
        .filter((n) => (readJson(`real/${n}.expected.json`).source || {}).provider !== "jellyfin")
    : [];
  if (names.length === 0) {
    skip("real", "captured fixture", "corpus/real/ is empty — see its README");
    return;
  }
  for (const name of names) {
    const b = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.bif`)));
    const e = readJson(`real/${name}.expected.json`);
    const h = timeline.parseHeader(b);
    check("real", `${name}: multiplier`, h.multiplier, e.multiplierMs);
    check("real", `${name}: frames`, timeline.parseIndex(b, h).map((f, i) => ({
      index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
    })), e.frames);

    // The zero-I/O length heuristic against HASHED ground truth from a real
    // encoder (F-036). This is the assertion the whole finding rests on, and
    // a synthetic fixture cannot make it honestly.
    if (e.duplicateOf) {
      const truth = e.duplicateOf.map((d) => d !== null);
      const heur = scenepolicy.lengthRunDuplicates(e.frames);
      let fp = 0;
      heur.forEach((d, i) => { if (d && !truth[i]) fp++; });
      check("real", `${name}: length heuristic flags no distinct frame`, fp, 0);
    }
  }
})();

// -------------------------------------------------------------------- main

console.log("\ncorpus conformance — trickplayer-pebble (src/pkjs)\n");
for (const s of skipped) console.log(`  SKIP  [${s.group}] ${s.name}\n          ${s.why}`);
if (skipped.length) console.log("");

if (failures.length === 0) {
  console.log(`  ${pass} checks agree, ${skipped.length} not applicable yet\n`);
  process.exit(0);
}
console.log(`  ${pass} agree, ${failures.length} DISAGREE, ${skipped.length} skipped\n`);
for (const f of failures) {
  console.log(`  [${f.group}] ${f.name}`);
  console.log(`      expected: ${f.expected.slice(0, 300)}`);
  console.log(`      actual:   ${f.actual.slice(0, 300)}\n`);
}
process.exit(1);
