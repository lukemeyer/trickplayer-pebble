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

  skip("timeline", "byte-identical duplicate detection",
    "F-001 not implemented on Pebble — no duplicate skip exists yet");
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

// ------------------------------------------------------------------- scene

(function checkScene() {
  skip("scene", "selection policy",
    "Pebble resolves scenes inside src/pkjs/index.js against a live Plex " +
    "server and a cache — there is no pure function to point at the fixture. " +
    "Extracting one is PLAN.md Phase 2 items 13-14.");
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
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".expected.json"))
        .map((f) => f.replace(/\.expected\.json$/, ""))
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
