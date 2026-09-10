// Plex as a media source. See trickplayer-knowledge/SEAM.md.
//
// The same contract Wear OS's PlexSource implements, with one shape difference
// that is the platform's and not the seam's: **PKJS has no promises worth
// using and no async/await**, so every call that touches the network takes a
// callback. The seam specifies what a provider must answer, not how it hands
// the answer back.
//
// Constructed per configuration rather than per route: Pebble has no route
// racing yet (F-016 is applied to the config page, not the runtime), so the
// server is whatever the config says.

var timeline = require("./timeline.js");
var subsLib = require("./subs.js");
var plex = require("./plex.js");

function create(cfg) {

	function capabilities() {
		return {
			// plex.tv authenticates first and discovers servers after.
			needsAddressFirst: false,
			hasServerDiscovery: true,
			hasPlaylists: true,
			hasContinueWatching: true,
			// A BIF index states every frame's byte length, which is what makes
			// F-007 blank filtering and F-036 duplicate detection possible.
			hasFrameSizeHints: true,
			// One frame is one ranged GET, ~13 KB.
			fetchGranularity: "frame"
		};
	}

	// cb(err, frames) where a frame is { tsMs, sizeHint, locator }.
	//
	// Header first to learn how long the index is, then the index itself. The
	// frames are NOT read: a 24-minute episode's track is 9.5 MB and is fetched
	// one frame at a time (F-005).
	function timelineFrames(cb) {
		var url = plex.timelineUrl(cfg);
		plex.getRange(url, 0, 63, cfg.token, function (err, head) {
			if (err) { cb(err); return; }
			var header;
			try { header = timeline.parseHeader(head); }
			catch (e) { cb(e); return; }

			plex.getRange(url, 0, header.indexBytes - 1, cfg.token, function (err2, idxBytes) {
				if (err2) { cb(err2); return; }
				try {
					cb(null, timeline.toFrameRefs(timeline.parseIndex(idxBytes, header)), header);
				} catch (e2) { cb(e2); }
			});
		});
	}

	// cb(err, Uint8Array). Unwrapping the locator is THIS provider's business:
	// on Plex it is a byte range; a tile-sheet source finds a sheet index and a
	// grid cell here and fetches something else entirely (SEAM.md §5).
	function frameBytes(frame, cb) {
		var loc = frame.locator;
		plex.getRange(
			plex.timelineUrl(cfg),
			loc.offset,
			loc.offset + loc.length - 1,
			cfg.token,
			cb
		);
	}

	// cb(err, cues). Bytes then a BOM sniff — never Content-Type. A real Plex
	// server serves UTF-16 sidecars labelled text/html (F-035).
	function cues(cb) {
		if (!cfg.subtitleRef) { cb(null, []); return; }
		plex.getRange(cfg.server + cfg.subtitleRef, null, null, cfg.token,
			function (err, bytes) {
				if (err) { cb(err); return; }
				try { cb(null, subsLib.parse(subsLib.decodeBytes(bytes))); }
				catch (e) { cb(e); }
			});
	}

	// One fetch per frame here, so preview cost really is proportional —
	// unlike a batch source, where three scenes and a hundred cost the same.
	function previewCostBytes(frames, sceneCount) {
		if (!frames || !frames.length) return null;
		var sizes = [];
		for (var i = 0; i < frames.length; i++) {
			if (typeof frames[i].sizeHint === "number") sizes.push(frames[i].sizeHint);
		}
		if (!sizes.length) return null;
		sizes.sort(function (a, b) { return a - b; });
		return sizes[sizes.length >> 1] * sceneCount;
	}

	return {
		capabilities: capabilities,
		timeline: timelineFrames,
		frameBytes: frameBytes,
		cues: cues,
		previewCostBytes: previewCostBytes
	};
}

if (typeof module !== "undefined") {
	module.exports = { create: create };
}
