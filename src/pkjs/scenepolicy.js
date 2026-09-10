// Scene selection policy — which frames are worth showing, decided ONCE, with
// no network and no decode.
//
// Dual-runtime (PebbleKit JS and Node) like timeline.js and subs.js, so the
// conformance runner exercises the shipping code.
//
// The policy, per trickplayer-knowledge findings:
//
//   F-001  Bin by the SOURCE'S OWN frame timings, not a synthetic fixed
//          interval. Every usable frame is its own scene candidate, so scenes
//          follow the content's real cuts instead of a clock. A scene's window
//          runs to the NEXT kept frame, so time folded out by skipping is not
//          lost — the scene simply widens and keeps its cues.
//
//   F-036  Duplicate frames are detected from DECLARED LENGTH alone. Hashing
//          the bytes costs a full-track read (measured: 1815 of 1815 frames,
//          10.48 MB, 10.2 s) and buys almost nothing — the length heuristic
//          found 99.7% of duplicates across three real episodes with one false
//          positive in 6,149 frames. That is what makes F-001 affordable here
//          at all, and keeps this a pure function of the index.
//
//   F-007  Near-blank frames are judged by compressed byte length against this
//          episode's own median. Episodes open, close and fade through black.
//
//   F-008  Filter ONCE, up front. Skipping at read time steals a later scene's
//          frame and shows it twice.
//
//   F-009  Floor the filters: a repetitive face beats an empty one.
//
//   F-010  A cue belongs to the window it STARTS in.

function median(nums) {
	if (!nums.length) return 0;
	var sorted = nums.slice().sort(function (a, b) { return a - b; });
	var mid = sorted.length >> 1;
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

// Frames whose declared length is at least `pct`% of the episode's median.
// A frame exactly on the threshold is kept.
function filterBlank(index, picked, pct) {
	var med = median(index.map(function (e) { return e.length; }));
	var floor = (pct / 100) * med;
	var out = [];
	for (var i = 0; i < picked.length; i++) {
		if (index[picked[i]].length >= floor) out.push(picked[i]);
	}
	return { usable: out, medianLength: med };
}

// Byte-identical-to-an-earlier-frame, inferred from declared length (F-036).
// Compare against the current run's REPRESENTATIVE rather than the immediate
// neighbour, so a run survives a frame that merely happens to match the one
// before it.
function lengthRunDuplicates(index) {
	var dup = new Array(index.length);
	dup[0] = false;
	var rep = 0;
	for (var i = 1; i < index.length; i++) {
		if (index[i].length === index[rep].length) {
			dup[i] = true;
		} else {
			dup[i] = false;
			rep = i;
		}
	}
	return dup;
}

function cueCountIn(cues, fromMs, toMs) {
	if (!cues) return 0;
	var n = 0;
	for (var i = 0; i < cues.length; i++) {
		if (cues[i].startMs >= fromMs && cues[i].startMs < toMs) n++;
	}
	return n;
}

// Build the scene list.
//
// index    [{ tsMs, offset, length }]  the whole parsed trick-play index
// cues     [{ startMs, endMs, text }]  or null if none loaded
// opts     { durationMs, blankPct, skipSilent, minUsable }
//
// Returns { scenes: [{ frameIndex, windowStartMs, windowEndMs }], ... }
function buildScenes(index, cues, opts) {
	opts = opts || {};
	var blankPct = opts.blankPct === undefined ? 15 : opts.blankPct;
	var minUsable = opts.minUsable === undefined ? 8 : opts.minUsable;
	var all = [];
	var i;
	for (i = 0; i < index.length; i++) all.push(i);
	var target = Math.min(minUsable, all.length);

	var blank = filterBlank(index, all, blankPct);
	var dup = lengthRunDuplicates(index);

	var kept = [];
	for (i = 0; i < blank.usable.length; i++) {
		if (!dup[blank.usable[i]]) kept.push(blank.usable[i]);
	}
	// Dropping duplicates must not gut a static episode.
	if (kept.length < target) kept = blank.usable.slice();
	// Nor must blank filtering.
	if (kept.length < target) kept = all;

	var durationMs = opts.durationMs ||
		(index.length ? index[index.length - 1].tsMs : 0);

	// A scene runs from its frame to the next KEPT frame, so the time of every
	// skipped frame folds into the scene that replaces it and its cues survive.
	var scenes = [];
	for (i = 0; i < kept.length; i++) {
		scenes.push({
			frameIndex: kept[i],
			windowStartMs: index[kept[i]].tsMs,
			windowEndMs: i + 1 < kept.length ? index[kept[i + 1]].tsMs : durationMs
		});
	}

	var emptyRemoved = 0;
	if (opts.skipSilent && cues && cues.length) {
		var withCues = [];
		for (i = 0; i < scenes.length; i++) {
			if (cueCountIn(cues, scenes[i].windowStartMs, scenes[i].windowEndMs)) {
				withCues.push(scenes[i]);
			}
		}
		if (withCues.length >= target) {
			emptyRemoved = scenes.length - withCues.length;
			scenes = withCues;
		}
	}

	return {
		scenes: scenes,
		medianLength: blank.medianLength,
		blanksSkipped: all.length - blank.usable.length,
		duplicatesSkipped: dup.filter(function (d) { return d; }).length,
		emptyScenesRemoved: emptyRemoved
	};
}

if (typeof module !== "undefined") {
	module.exports = {
		median: median,
		filterBlank: filterBlank,
		lengthRunDuplicates: lengthRunDuplicates,
		buildScenes: buildScenes
	};
}
