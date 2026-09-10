// Scene selection policy — which frames are worth showing, decided ONCE.
//
// Written to run under both PebbleKit JS and Node, like timeline.js and
// subs.js, so the conformance runner can exercise the shipping code.
//
// Encodes three shared rules (trickplayer-knowledge/findings):
//
//   F-007  A near-blank frame is detectable from its COMPRESSED BYTE LENGTH,
//          before any network happens. Episodes open, close and fade through
//          black; those frames quantise to one colour and are dead air. The
//          threshold is relative to this episode's own median length, so it
//          travels to content encoded at different settings.
//
//   F-008  Filter ONCE, up front. The obvious alternative — step forward past
//          a bad frame when a scene asks for it — does not pass over a frame,
//          it STEALS a later scene's frame, and that scene then shows it
//          again. This build shipped that bug and patched it with a stateful
//          `resolvedPick` chain threaded through the cache; filtering up front
//          removes the whole class instead, and makes scene -> frame a plain
//          list lookup that a cache hit cannot desynchronise.
//
//   F-009  Floor the filter. An item with no dialogue, or one whose frames are
//          uniformly tiny, would otherwise be filtered down to nothing. A
//          repetitive face beats an empty one.
//
// The old path fetched AND JPEG-decoded a frame just to discover it was black,
// then fetched another. Judging by declared length costs no request and no
// decode — on the most constrained of the three platforms, that is the whole
// point.

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

// The frames actually worth showing. Scene N is scenes[N], and that is the
// whole mapping.
//
// index    [{ tsMs, offset, length }]  the parsed trick-play index
// picked   [frameIndex]                cadence already applied
// cues     [{ startMs, endMs, text }]  or null if none loaded
// opts     { intervalMs, blankPct, skipSilent, minUsable }
function buildScenes(index, picked, cues, opts) {
	var blankPct = opts.blankPct === undefined ? 15 : opts.blankPct;
	var minUsable = opts.minUsable === undefined ? 8 : opts.minUsable;
	var target = Math.min(minUsable, picked.length);

	var filtered = filterBlank(index, picked, blankPct);
	var usable = filtered.usable;

	// Silent windows go too, but only if that leaves enough behind.
	if (opts.skipSilent && cues && cues.length) {
		var withCues = [];
		for (var i = 0; i < usable.length; i++) {
			var ts = index[usable[i]].tsMs;
			var n = 0;
			for (var c = 0; c < cues.length; c++) {
				if (cues[c].startMs >= ts && cues[c].startMs < ts + opts.intervalMs) { n++; break; }
			}
			if (n) withCues.push(usable[i]);
		}
		if (withCues.length >= target) usable = withCues;
	}

	// Floor: if blank filtering alone already went too far, keep everything
	// rather than degrading to nothing.
	if (usable.length < target) usable = picked.slice();

	return {
		scenes: usable,
		medianLength: filtered.medianLength,
		blanksSkipped: picked.length - filtered.usable.length,
		silentSkipped: filtered.usable.length - usable.length
	};
}

if (typeof module !== "undefined") {
	module.exports = {
		median: median,
		filterBlank: filterBlank,
		buildScenes: buildScenes
	};
}
