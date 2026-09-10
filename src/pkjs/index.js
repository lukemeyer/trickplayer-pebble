// PebbleKit JS — phone side.
//
// Builds scenes from a real Plex BIF: ranged fetch -> JPEG decode -> median cut
// -> Floyd-Steinberg -> 4bpp pack, plus the subtitle cues for that window.
// Results are cached (cache.js) so each scene is fetched and decoded once ever,
// and prefetched ahead so a refill is usually a cache read.
//
// makeSyntheticScene() remains as the no-config fallback and is what proved the
// transport in isolation.
//
// Chunks are sent strictly one at a time: chunk N+1 goes out only from chunk N's
// success callback. That keeps arrival ordered (so the watch can reassemble with
// a running offset) and avoids overrunning the inbox.
//
// Deliberately ES5-flavoured: this runs in the phone's PebbleKit JS sandbox, not
// a modern browser. The emulator's pypkjs is V8-based and would accept far more,
// but the real Android/iOS runtimes are the target and are less forgiving.

// MUST match src/embeddedjs/config.js.
var FW = 160;
var FH = 90;
var PAL_STRIDE = (FW + 1) >> 1;      // 4bpp -> 2 px per byte
var PACKED_BYTES = PAL_STRIDE * FH;  // 7,200

// Payload bytes per message. The watch opens a 2048-byte inbox; leave room for
// the other tuples and dictionary overhead.
//
// Raised from 1024: every chunk costs the watch a Uint8Array wrapper and a Map
// in its SLOT heap, and slot exhaustion — not chunk — is what aborts it. 1600
// takes a 7,200 B scene from 8 messages to 5.
var CHUNK = 1600;

var sending = false;
var queue = [];
var lastServed = 0;   // highest scene index the watch has asked for

function log(s) { console.log("[pkjs] " + s); }

// ----------------------------------------------------------------- modules
//
// Note what is NOT required here any more: plex.js and timeline.js. This file
// no longer knows what Plex is or what a BIF looks like — it asks the source
// for frames and cues, and the source knows. Swapping in a second provider is
// a change to the `source` line below and nothing else.
var scenepolicy = require("./scenepolicy.js");
var plexsource = require("./plexsource.js");
var render = require("./render.js");

var SKIP_SILENT_CFG = true;

// Config page URL. Must be hosted over https for the Pebble app's webview.
var CONFIG_URL = "https://lukemeyer.github.io/trickplayer-pebble/config/";

// Saved settings win over the dev file: local-config.js only exists so the
// pipeline could be built and tested before the config page did.
var cfg = null;

// Settings saved by a build from before the Trickplayer vocabulary rename use
// the old key names. Accept them rather than silently ignoring a perfectly good
// stored config and dropping the user back to synthetic scenes.
//
// The localStorage KEY ("bif.settings") deliberately does not change: renaming
// it would orphan exactly the settings this is here to rescue.
function migrateCfg(c) {
	if (!c) return c;
	if (c.timelineRef === undefined && c.partId !== undefined) c.timelineRef = c.partId;
	if (c.subtitleRef === undefined && c.subKey !== undefined) c.subtitleRef = c.subKey;
	return c;
}

function loadCfg() {
	try {
		var raw = localStorage.getItem("bif.settings");
		if (raw) {
			var c = migrateCfg(JSON.parse(raw));
			if (c && c.server && c.token && c.timelineRef) {
				log("config: " + (c.title || "saved settings"));
				return c;
			}
		}
	} catch (e) { /* fall through */ }
	try {
		var dev = require("./local-config.js");
		log("config: local-config.js (dev)");
		return dev;
	} catch (e2) {
		log("no config; falling back to synthetic scenes");
		return null;
	}
}
cfg = loadCfg();
if (cfg && cfg.opts && typeof cfg.opts.skipSilent === "boolean") SKIP_SILENT_CFG = cfg.opts.skipSilent;

var subsLib = require("./subs.js");
var cache = require("./cache.js");

if (cfg) cache.setProfile(cfg.timelineRef, FW, FH, 4);

var index = null;      // parsed BIF index
var cues = null;       // parsed subtitle cues
var loading = false;

// Fetch and parse the subtitle sidecar once. Small enough (~32 KB, ~476 cues,
// parses in about a millisecond) that it is worth having in full: it is what
// makes most advances text-only.
function loadSubs(cb) {
	if (cues || !source) { cb(null); return; }
	source.cues(function (err, parsed) {
		if (err) { log("subs failed: " + err.message); cues = []; cb(null); return; }
		cues = parsed;
		log("subtitles: " + cues.length + " cues");
		cb(null);
	});
}

// Fetch and parse the BIF index once. Frames are pulled individually after.
// Fetch the frame timeline once. Frames are pulled individually after.
//
// `index` now holds the seam's shape — { tsMs, sizeHint, locator } — not BIF
// entries. Nothing here reads a locator; only the provider does.
function loadIndex(cb) {
	if (index) { cb(null); return; }
	if (!source) { cb(new Error("no config")); return; }
	if (loading) { cb(new Error("busy")); return; }
	loading = true;

	source.timeline(function (err, frames, header) {
		loading = false;
		if (err) { cb(err); return; }
		index = frames;
		if (header) {
			log("BIF " + header.count + " frames, multiplier " + header.multiplier + "ms");
		}
		log("index ready: " + index.length + " frames");
		cb(null);
	});
}

// Skip scenes with no dialogue. 14 of 150 windows in the test episode are
// silent; landing on one shows an empty subtitle band for no reason.
var SKIP_SILENT = SKIP_SILENT_CFG;

// The frames actually worth showing, decided ONCE and then indexed.
//
// This used to be a read-time skip: fetch a frame, JPEG-decode it, count the
// palette, and if it came out near-blank fetch the next one instead. That cost
// a request AND a decode to discover a frame was black, and it was wrong as
// well as expensive — skipping forward does not pass over a frame, it steals a
// later scene's frame, so that scene then shows the same picture again. The
// patch for that was a stateful `resolvedPick` chain threaded through the
// cache, which only held as long as every cache hit remembered to feed it.
//
// scenepolicy.js decides the whole list up front from the parsed index and the
// cue list — no network, no decode — and scene -> frame becomes a list lookup
// that a cache hit cannot desynchronise. See trickplayer-knowledge F-007/F-008.
var scenes = null;

// The media source. Everything below asks IT for frames and cues rather than
// reaching for Plex directly, so a second provider is a swap here and nothing
// else. See trickplayer-knowledge/SEAM.md.
var source = cfg ? plexsource.create(cfg) : null;

function ensureScenes() {
	if (scenes) return scenes;
	var caps = source.capabilities();
	var built = scenepolicy.buildScenes(index, cues, {
		durationMs: index.length ? index[index.length - 1].tsMs : 0,
		skipSilent: SKIP_SILENT,
		// A source with no per-frame sizes gets neither blank filtering nor
		// duplicate detection — skipped, not faked (SEAM.md §4).
		hasFrameSizeHints: caps.hasFrameSizeHints
	});
	scenes = built.scenes;
	log("scenes: " + scenes.length + " of " + index.length + " frames (" +
		built.blanksSkipped + " near-blank, " + built.duplicatesSkipped +
		" duplicate, " + built.emptyScenesRemoved + " silent), median frame " +
		(built.medianLength | 0) + "B");
	return scenes;
}

// Build one real scene: range-fetch the JPEG, decode, palette, dither, pack.
function makeRealScene(sceneIdx, cb) {
	// A cached scene costs no network and no decode. This is what keeps the
	// watchface working away from the Plex server, which is most of the day.
	var hit = cache.get(sceneIdx);
	if (hit) {
		cb(null, {
			idx: sceneIdx, tsMs: hit.tsMs, cues: hit.cues,
			packed: hit.packed, pal: hit.pal
		});
		return;
	}

	loadIndex(function (err) {
		if (err) { cb(err); return; }
		loadSubs(function () {
		var list = ensureScenes();
		if (!list.length) { cb(new Error("no usable scenes")); return; }

		// Wrap at the end so a face left running loops rather than stalling.
		var sc = list[((sceneIdx % list.length) + list.length) % list.length];
		var fi = sc.frameIndex;
		var ent = index[fi];

		// The provider returns DECODED pixels, not image bytes: this platform
		// decodes in JavaScript regardless, and a tile-sheet source cannot hand
		// back a cropped JPEG at all because jpeg.js has no encoder. Where the
		// pixels came from — a ranged GET and a decode, or a crop of a sheet
		// already held — is the provider's business.
		source.framePixels(ent, function (e2, px) {
			if (e2) { cb(e2); return; }
			var t0 = Date.now();
			var enc;
			try {
				enc = render.encodeFrame(px.pixels, px.width, px.height, FW, FH);
			} catch (e3) { cb(e3); return; }

			// Cues belonging to this scene's window. A cue is owned by the scene
			// it STARTS in, so a line straddling the boundary is not shown twice.
			// The window runs to the NEXT kept frame, not a fixed interval —
			// so the time of every skipped duplicate folds into this scene and
			// its cues come with it (F-001).
			var lines = cues
				? subsLib.cuesInWindow(cues, sc.windowStartMs, sc.windowEndMs)
				: [];

			log("scene " + sceneIdx + " frame " + fi + " @" +
				((ent.tsMs / 1000) | 0) + "s: " + px.width + "x" + px.height +
				" -> " + enc.packed.length + "B, " + lines.length + " cues, " +
				(Date.now() - t0) + "ms");

			// Cue separator on the wire is "\n", so flatten newlines inside a
			// cue to spaces. The watch wraps text anyway.
			var flat = [];
			for (var li = 0; li < lines.length; li++) {
				flat.push(lines[li].replace(/\n/g, " "));
			}
			if (!flat.length) flat.push(fmtTime(ent.tsMs));

			var built = {
				idx: sceneIdx,
				tsMs: ent.tsMs,
				cues: flat,
				packed: Array.prototype.slice.call(enc.packed),
				pal: Array.prototype.slice.call(enc.palette)
			};
			cache.put(sceneIdx, built);
			cb(null, built);
		});
		});
	});
}

function fmtTime(ms) {
	var s = (ms / 1000) | 0;
	var m = (s / 60) | 0;
	var ss = s % 60;
	return m + ":" + (ss < 10 ? "0" : "") + ss;
}

// ---------------------------------------------------------------- synthetic
// Fallback when there is no local-config.js, and what Phase 2 used to prove the
// transport independently of Plex.
function makeSyntheticScene(idx) {
	var packed = new Array(PACKED_BYTES);
	var i;
	for (i = 0; i < PACKED_BYTES; i++) packed[i] = 0;

	for (var y = 0; y < FH; y++) {
		var row = y * PAL_STRIDE;
		for (var x = 0; x < FW; x++) {
			// diagonal bands that shift with idx, plus a horizon line
			var v = (((x + idx * 12) >> 3) + (y >> 3)) & 15;
			if (y === (FH >> 1)) v = 15;
			var o = row + (x >> 1);
			packed[o] |= (x & 1) ? v : (v << 4);
		}
	}

	// 16 entries spread across the 64-colour space. GColor8 = AARRGGBB,
	// alpha 3 = opaque.
	var pal = new Array(16);
	for (i = 0; i < 16; i++) {
		var r = i & 3, g = (i >> 2) & 3, b = 3 - (i & 3);
		pal[i] = 0xC0 | (r << 4) | (g << 2) | b;
	}

	return {
		idx: idx,
		tsMs: idx * 10000,
		cues: [
			"synthetic scene " + idx,
			"second cue, no new bitmap",
			"third cue, still no radio"
		],
		packed: packed,
		pal: pal
	};
}

// ------------------------------------------------------------------- send
function enqueueScene(scene) {
	var total = Math.ceil(scene.packed.length / CHUNK);
	for (var s = 0; s < total; s++) {
		queue.push({ scene: scene, seq: s, total: total });
	}
	pump();
}

// ---------------------------------------------------------------- prefetch
// Build scenes ahead into the cache while nothing is being sent. The point is
// that a later refill becomes a cache read — no fetch, no decode — so the
// expensive work happens while the user is not waiting on it.
//
// Deliberately conservative: one at a time, only when the send queue is empty,
// and it yields to any real request.
var PREFETCH_AHEAD = 8;
var prefetchNext = -1;
var prefetching = false;

function schedulePrefetch(fromIdx) {
	if (!cfg) return;
	prefetchNext = fromIdx;
	if (!prefetching) setTimeout(runPrefetch, 1500);
}

function runPrefetch() {
	// Never compete with an actual send; try again once the queue drains.
	if (sending || queue.length) { setTimeout(runPrefetch, 1500); return; }
	if (prefetchNext < 0 || !index) { prefetching = false; return; }
	if (prefetchNext >= lastServed + PREFETCH_AHEAD) { prefetching = false; return; }

	var idx = prefetchNext++;
	if (cache.get(idx)) { setTimeout(runPrefetch, 50); return; }   // already warm

	prefetching = true;
	makeRealScene(idx, function (err) {
		if (err) { log("prefetch " + idx + " failed: " + err.message); prefetching = false; return; }
		log("prefetched " + idx + " (cache " + cache.count() + ")");
		setTimeout(runPrefetch, 500);
	});
}

// How hard to try a chunk that fails to land.
//
// Ported from the G2 build's BLE work — the first finding to travel that way
// rather than G2 -> Pebble -> Wear OS. See trickplayer-knowledge F-027.
//
// This transport had NO retry at all: a single failed chunk discarded the rest
// of the scene. That is expensive twice over. The scene cost a ranged fetch, a
// JPEG decode, a median cut and a dither to build, and — because metadata
// rides the LAST chunk — losing any chunk also loses the cues, which are the
// cheap and genuinely valuable half. A transient BLE hiccup should not cost
// all of that.
//
// The BUDGET matters more than the attempt count. Each failure still costs its
// own timeout, and everything behind this scene in the queue waits: retrying
// an unlucky chunk indefinitely would stall delivery rather than protect it.
// Past the budget, dropping the scene is still the right answer.
var CHUNK_MAX_ATTEMPTS = 3;
var CHUNK_RETRY_DELAY_MS = 250;
var SCENE_RETRY_BUDGET_MS = 4000;

function dropScene(scene, why) {
	log("dropping scene " + scene.idx + ": " + why);
	queue = queue.filter(function (j) { return j.scene !== scene; });
}

function pump() {
	if (sending || queue.length === 0) return;
	sending = true;

	var job = queue.shift();
	var scene = job.scene;
	var start = job.seq * CHUNK;
	var end = Math.min(start + CHUNK, scene.packed.length);

	var msg = {
		SceneIdx: scene.idx,
		SceneSeq: job.seq,
		SceneTotal: job.total,
		SceneData: scene.packed.slice(start, end)
	};

	// Metadata rides the final chunk, so the watch only commits a scene once
	// the pixels are all in.
	if (job.seq === job.total - 1) {
		msg.ScenePal = scene.pal;
		msg.SceneCues = scene.cues.join("\n");
		msg.SceneTsMs = scene.tsMs;
	}

	Pebble.sendAppMessage(msg, function () {
		sending = false;
		pump();                       // next chunk only after this one lands
	}, function (e) {
		sending = false;
		var why = (e && e.error && e.error.message) ? e.error.message : "?";

		job.attempts = (job.attempts || 0) + 1;
		if (scene.retryStartMs === undefined) scene.retryStartMs = Date.now();
		var spent = Date.now() - scene.retryStartMs;

		if (job.attempts < CHUNK_MAX_ATTEMPTS && spent < SCENE_RETRY_BUDGET_MS) {
			log("send failed scene " + scene.idx + " seq " + job.seq + ": " + why +
				" (attempt " + job.attempts + ", " + spent + "ms spent) — retrying");
			queue.unshift(job);       // same chunk, front of the queue
			setTimeout(pump, CHUNK_RETRY_DELAY_MS);
			return;
		}

		// Out of attempts or out of budget. A half-delivered frame is useless,
		// so the rest of this scene goes; the queue moves on rather than
		// stalling behind an unlucky chunk.
		dropScene(scene, "seq " + job.seq + " failed " + job.attempts +
			"x in " + spent + "ms (" + why + ")");
		pump();
	});
}

// ------------------------------------------------------------------ events
//
// The watch cannot send until it has RECEIVED at least one message: Alloy's
// Message sets its internal pkjsReady flag in messageReceived(), and onWritable
// is gated on it. The watch's own handshake uses key 15025, which PKJS never
// surfaces (undeclared keys are dropped), so the phone must speak first or both
// sides wait forever.
//
// Retry a few times because the watch's app_message_open() happens in its
// Message constructor, which may not have run when "ready" fires here. Stop as
// soon as the watch says anything.
// The first attempt normally fails: PKJS "ready" can fire before the watch has
// run app_message_open() in its Message constructor. Retry by chaining
// setTimeout off the FAILURE callback rather than a setInterval — pypkjs was
// observed firing setInterval exactly once and then never again, which left the
// handshake stuck after a single failed send.
var helloTries = 0;
var helloDone = false;

function sayHello() {
	if (helloDone) return;
	if (helloTries++ > 12) {
		log("giving up on handshake after " + (helloTries - 1) + " tries");
		return;
	}
	Pebble.sendAppMessage({ Hello: helloTries }, function () {
		log("hello acked (" + helloTries + ")");
	}, function () {
		log("hello failed (" + helloTries + "), retrying");
		setTimeout(sayHello, 1500);
	});
}

function stopHello() { helloDone = true; }

Pebble.addEventListener("showConfiguration", function () {
	Pebble.openURL(CONFIG_URL);
});

Pebble.addEventListener("webviewclosed", function (e) {
	if (!e || !e.response) { log("config cancelled"); return; }
	var c;
	try { c = migrateCfg(JSON.parse(decodeURIComponent(e.response))); }
	catch (err) { log("config payload unreadable: " + err.message); return; }
	if (!c.server || !c.token || !c.timelineRef) { log("config payload incomplete"); return; }

	try { localStorage.setItem("bif.settings", JSON.stringify(c)); }
	catch (err2) { log("could not save settings: " + err2.message); }

	// New episode: everything derived from the old one is now wrong.
	cfg = c;
	index = null;
	scenes = null;
	cues = null;
	if (c.opts) {
		if (typeof c.opts.skipSilent === "boolean") SKIP_SILENT = c.opts.skipSilent;
	}
	// Re-key the cache so frames from the previous episode are never served.
	cache.setProfile(c.timelineRef, FW, FH, 4);
	lastServed = 0;
	prefetchNext = -1;
	log("configured: " + (c.title || c.timelineRef));
});

Pebble.addEventListener("ready", function () {
	log("ready");
	// NB: do NOT call cache.probeCapacity() here — it blocks PKJS for over a
	// minute and the handshake queues behind it. The LRU evicts on quota errors,
	// so the cache sizes itself.
	if (cfg) log("cache holds " + cache.count() + " scenes");
	sayHello();
});

Pebble.addEventListener("appmessage", function (e) {
	var p = e.payload || {};
	// NB: do NOT stop the handshake retries on just any appmessage. Alloy's
	// Message constructor sends an internal probe (key 15025) which surfaces
	// here as an event with an unnameable payload — treating that as "the watch
	// is talking" silences the retry loop before the watch is actually ready,
	// and both sides then wait forever.
	if (p.SceneReq === undefined) return;
	stopHello();

	var from = p.SceneReq;
	var count = p.SceneTotal || 1;
	log("SceneReq from " + from + " x" + count);

	if (!cfg) {
		for (var i = 0; i < count; i++) enqueueScene(makeSyntheticScene(from + i));
		return;
	}

	// Build scenes one at a time. Decoding is the expensive step and doing it
	// serially keeps the phone responsive; the watch is buffered anyway, so
	// there is nothing to gain from racing them.
	lastServed = from + count;
	var n = 0;
	(function next() {
		if (n >= count) { schedulePrefetch(lastServed); return; }
		var sceneIdx = from + n++;
		makeRealScene(sceneIdx, function (err, scene) {
			if (err) {
				log("scene " + sceneIdx + " failed: " + err.message);
				// Fall back so the face shows something rather than stalling.
				enqueueScene(makeSyntheticScene(sceneIdx));
			} else {
				enqueueScene(scene);
			}
			next();
		});
	})();
});
