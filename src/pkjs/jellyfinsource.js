// Jellyfin as a media source. See trickplayer-knowledge/SEAM.md.
//
// The tile-sheet counterpart of plexsource.js. Where Plex hands out a byte
// index and one frame is one ranged GET, Jellyfin hands out sheets:
//
//   * A thumbnail has NO byte length of its own, so sizeHint is null and blank
//     filtering (F-007) and duplicate detection (F-036) are unavailable here.
//     Skipped, not faked.
//   * The fetch atom is a sheet of up to 100 thumbnails — 865 KB and 3200x1320
//     on the measured capture — so one thumbnail costs a whole sheet and the
//     next 99 are free. This provider therefore owns a cache, which is what
//     fetchGranularity "batch" declares.
//   * Native spacing is 10 s rather than Plex's 2 s.
//
// MEMORY, which is the live risk on this platform (F-041). Decoding a sheet
// yields a 12.1 MB pixel buffer, and exactly ONE is held at a time: moving to
// another sheet drops the previous one. Measured under node the decode is
// 160 ms and cropping all 73 thumbnails another 360 ms, so amortised this is
// ~0.06 s per scene against Plex's ~0.08 s — cheaper, because one decode
// serves a whole sheet where Plex pays per frame forever.
//
// The 12.1 MB peak has NOT been verified on a real phone. PKJS on Android is
// more constrained than node, and that check is outstanding.

var subsLib = require("./subs.js");
var plex = require("./plex.js");   // getRange is a plain ranged/whole GET
var jpegLib = require("./jpeg.js");

// cfg: { server, token, itemId, mediaSourceId, width, trickplay, subtitleIndex }
// trickplay: { TileWidth, TileHeight, Width, Height, Interval, ThumbnailCount }
function create(cfg) {
	var tp = cfg.trickplay;
	var perSheet = tp.TileWidth * tp.TileHeight;

	// Exactly one decoded sheet, ever.
	var heldIndex = -1;
	var heldPixels = null;
	var heldW = 0, heldH = 0;

	function capabilities() {
		return {
			// No account service: the address IS the identity, so it has to be
			// known before anything can be authenticated.
			needsAddressFirst: true,
			hasServerDiscovery: false,
			hasPlaylists: true,
			hasContinueWatching: true,
			// A thumbnail is a crop, not a file. Nothing to judge size by.
			hasFrameSizeHints: false,
			fetchGranularity: "batch"
		};
	}

	// Where thumbnail i sits inside its sheet.
	//
	// The final sheet is normally PARTIAL — the measured capture has 73
	// thumbnails in a 100-cell grid — so a reader that assumes full sheets runs
	// off the end of the last image.
	function cropBox(i) {
		var cell = i % perSheet;
		return {
			sheet: Math.floor(i / perSheet),
			x: (cell % tp.TileWidth) * tp.Width,
			y: Math.floor(cell / tp.TileWidth) * tp.Height,
			w: tp.Width,
			h: tp.Height
		};
	}

	// Derived from geometry; no network at all. The manifest arrived with the
	// item metadata.
	function timeline(cb) {
		var frames = [];
		for (var i = 0; i < tp.ThumbnailCount; i++) {
			frames.push({
				tsMs: i * tp.Interval,
				// Not missing data: the honest answer for a source with none.
				sizeHint: null,
				locator: cropBox(i)
			});
		}
		cb(null, frames, null);
	}

	function sheetUrl(sheet) {
		return cfg.server.replace(/\/$/, "") +
			"/Videos/" + cfg.itemId + "/Trickplay/" + cfg.width + "/" + sheet + ".jpg";
	}

	// Ensure sheet `n` is the one decoded and held.
	function ensureSheet(n, cb) {
		if (heldIndex === n && heldPixels) { cb(null); return; }

		// Drop the previous sheet BEFORE decoding the next, so two 12 MB
		// buffers are never live at once.
		heldPixels = null;
		heldIndex = -1;

		plex.getRange(sheetUrl(n), null, null, cfg.token, function (err, bytes) {
			if (err) { cb(err); return; }
			var img;
			try { img = jpegLib.decode(bytes); }
			catch (e) { cb(e); return; }
			heldPixels = img.pixels;
			heldW = img.width;
			heldH = img.height;
			heldIndex = n;
			cb(null);
		});
	}

	// cb(err, { pixels, width, height }) — the crop, already decoded.
	//
	// The caller cannot tell this apart from the Plex provider's answer, which
	// is the point: it asks for a frame and gets pixels. Whether that cost a
	// request and a decode, or a crop of a sheet already held, is this file's
	// business (SEAM.md §5).
	function framePixels(frame, cb) {
		var box = frame.locator;
		ensureSheet(box.sheet, function (err) {
			if (err) { cb(err); return; }
			var w = box.w, h = box.h;
			var out = new Uint8Array(w * h * 3);
			for (var r = 0; r < h; r++) {
				var src = ((box.y + r) * heldW + box.x) * 3;
				var dst = r * w * 3;
				for (var c = 0; c < w * 3; c++) out[dst + c] = heldPixels[src + c];
			}
			cb(null, { pixels: out, width: w, height: h });
		});
	}

	function cues(cb) {
		if (cfg.subtitleIndex === null || cfg.subtitleIndex === undefined) {
			cb(null, []); return;
		}
		var url = cfg.server.replace(/\/$/, "") +
			"/Videos/" + cfg.itemId + "/" + cfg.mediaSourceId +
			"/Subtitles/" + cfg.subtitleIndex + "/Stream.srt";
		plex.getRange(url, null, null, cfg.token, function (err, bytes) {
			if (err) { cb(err); return; }
			// Bytes then a BOM sniff, never Content-Type — no reason to trust
			// this server more than the Plex one that called UTF-16 text/html
			// (F-035).
			try { cb(null, subsLib.parse(subsLib.decodeBytes(bytes))); }
			catch (e) { cb(e); }
		});
	}

	// How many SHEETS a preview touches, not how many frames: three scenes and
	// a hundred routinely cost the same here.
	function previewCostBytes(frames, sceneCount) {
		if (!frames || !frames.length) return null;
		var step = Math.max(1, Math.floor(frames.length / Math.max(sceneCount, 1)));
		var seen = {}, n = 0;
		for (var i = 0; i < frames.length; i += step) {
			var s = frames[i].locator.sheet;
			if (!seen[s]) { seen[s] = 1; n++; }
		}
		return n * APPROX_SHEET_BYTES;
	}

	function release() { heldPixels = null; heldIndex = -1; }

	return {
		capabilities: capabilities,
		cropBox: cropBox,
		timeline: timeline,
		framePixels: framePixels,
		cues: cues,
		previewCostBytes: previewCostBytes,
		release: release
	};
}

// Measured on a real 10x10 sheet of 320x132 thumbnails.
var APPROX_SHEET_BYTES = 865 * 1024;

if (typeof module !== "undefined") {
	module.exports = { create: create };
}
