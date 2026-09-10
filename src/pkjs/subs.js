// SRT parsing.
//
// Ported from trickplayer-g2/src/subtitles.ts. Differences:
//   * emits "\n" rather than "<br>" — the watch draws plain text
//   * strips HTML tags, which real Plex sidecars are full of (<i>…</i>)
//   * no yielding: the original chunked with setTimeout to keep a browser UI
//     responsive, but here a 476-cue file parses in a few ms and PKJS has no
//     UI to block. Yielding would only add callback complexity.
//
// The time regex tolerates a missing hours field and both , and . as the
// millisecond separator, which the original handled and real files need.

// Decode subtitle bytes, sniffing the byte-order mark.
//
// A real Plex server serves UTF-16 sidecars, labelled text/html with no
// charset. Decoding blindly as UTF-8 gives a string full of NULs, out of which
// parse() extracts ZERO cues — silently, because an empty cue list is not an
// error. The face then shows frames with no dialogue for the whole episode,
// and SKIP_SILENT judges every window silent on top of that.
// See trickplayer-knowledge findings/F-035.
//
// PKJS has no TextDecoder, so UTF-16 is assembled by hand. Characters are
// built in chunks: String.fromCharCode.apply with a very large argument list
// can blow the stack, and a sidecar is tens of thousands of characters.
var CHUNK = 4096;

function fromCharCodes(codes) {
	var out = "";
	for (var i = 0; i < codes.length; i += CHUNK) {
		out += String.fromCharCode.apply(null, codes.slice(i, i + CHUNK));
	}
	return out;
}

// bytes: Uint8Array (or array-like of byte values). Returns a JS string.
function decodeBytes(bytes) {
	var n = bytes.length, i;

	// UTF-16LE
	if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		var le = [];
		for (i = 2; i + 1 < n; i += 2) le.push(bytes[i] | (bytes[i + 1] << 8));
		return fromCharCodes(le);
	}
	// UTF-16BE
	if (n >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		var be = [];
		for (i = 2; i + 1 < n; i += 2) be.push((bytes[i] << 8) | bytes[i + 1]);
		return fromCharCodes(be);
	}

	// UTF-8, with or without a BOM. Widen the byte string the classic way —
	// PKJS has no TextDecoder — and fall back to the raw bytes if it is not
	// valid UTF-8 after all.
	var start = (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ? 3 : 0;
	var raw = "";
	for (i = start; i < n; i++) raw += String.fromCharCode(bytes[i] & 0xff);
	try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; }
}

var TIME_RE = /(\d{1,2})?:?(\d{2}):(\d{2})[,.](\d{3})/;

function toMs(s) {
	if (!s) return 0;
	var m = s.replace(/^\s+|\s+$/g, "").match(TIME_RE);
	if (!m) return 0;
	var h = m[1] ? parseInt(m[1], 10) : 0;
	return ((h * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10)) * 1000 +
		parseInt(m[4], 10);
}

function clean(s) {
	return s
		.replace(/<[^>]*>/g, "")            // <i>, <b>, <font …>
		.replace(/\{[^}]*\}/g, "")          // {\an8} style ASS overrides
		.replace(/^\s+|\s+$/g, "");
}

// text: the whole SRT. Returns [{ startMs, endMs, text }] in file order.
function parse(text) {
	var out = [];
	var norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	var blocks = norm.split("\n\n");

	for (var i = 0; i < blocks.length; i++) {
		var lines = blocks[i].replace(/^\s+|\s+$/g, "").split("\n");
		var ti = -1;
		for (var j = 0; j < lines.length; j++) {
			if (lines[j].indexOf("-->") !== -1) { ti = j; break; }
		}
		if (ti === -1) continue;

		var parts = lines[ti].split("-->");
		var startMs = toMs(parts[0]);
		var endMs = toMs(parts[1]);

		var body = [];
		for (var k = ti + 1; k < lines.length; k++) {
			var c = clean(lines[k]);
			if (c) body.push(c);
		}
		if (!body.length) continue;

		out.push({ startMs: startMs, endMs: endMs, text: body.join("\n") });
	}
	return out;
}

// Every cue overlapping [fromMs, toMs). A scene owns a window of video, so a cue
// that straddles the boundary belongs to the scene it starts in — otherwise a
// line would appear twice as you advance.
function cuesInWindow(cues, fromMs, toMs) {
	var out = [];
	for (var i = 0; i < cues.length; i++) {
		if (cues[i].startMs >= fromMs && cues[i].startMs < toMs) out.push(cues[i].text);
	}
	return out;
}

if (typeof module !== "undefined") {
	module.exports = {
		parse: parse,
		cuesInWindow: cuesInWindow,
		toMs: toMs,
		decodeBytes: decodeBytes
	};
}
