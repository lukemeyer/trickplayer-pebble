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
	module.exports = { parse: parse, cuesInWindow: cuesInWindow, toMs: toMs };
}
