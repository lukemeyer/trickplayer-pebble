// BIF (Roku/Plex trick-play index) parsing.
//
// Ported from trickplayer-g2/src/bif.ts, with two corrections found against a
// real Plex file (spikes/PHASE0-FINDINGS.md):
//
//   1. The timestamp multiplier at offset 16 is 0 in real Plex output, which per
//      the spec means "use the 1000 ms default". The original hardcoded *1000
//      and got the right answer by luck; reading the field literally yields
//      all-zero timestamps and a broken cue->frame mapping.
//   2. Only the index is parsed. The original built a Blob per frame, which is
//      hopeless here — a 24.5 min episode's BIF is 9.5 MB. Frames are fetched
//      individually by byte range.
//
// Layout: 64-byte header, then (count+1) 8-byte entries of
// [timestamp uint32 LE, offset uint32 LE]. The final entry is a sentinel whose
// timestamp is 0xFFFFFFFF and whose offset is EOF, which gives the last frame
// its length.

var MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(b, o) {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// bytes: at least the 64-byte header.
function parseHeader(bytes) {
	for (var i = 0; i < 8; i++) {
		if (bytes[i] !== MAGIC[i]) throw new Error("not a BIF file");
	}
	var count = u32(bytes, 12);
	var mult = u32(bytes, 16) || 1000;      // 0 means "default 1000 ms"
	return {
		version: u32(bytes, 8),
		count: count,
		multiplier: mult,
		indexBytes: 64 + 8 * (count + 1)
	};
}

// bytes: the whole index region (header + entries), i.e. header.indexBytes long.
// Returns [{ tsMs, offset, length }] with one entry per frame.
function parseIndex(bytes, header) {
	var out = [];
	var n = header.count;
	for (var i = 0; i < n; i++) {
		var o = 64 + 8 * i;
		var ts = u32(bytes, o);
		var off = u32(bytes, o + 4);
		var next = u32(bytes, 64 + 8 * (i + 1) + 4);
		out.push({ tsMs: ts * header.multiplier, offset: off, length: next - off });
	}
	return out;
}

// Pick one frame every intervalMs of video, rather than using the BIF's native
// spacing. Real Plex files are 2s apart, which is far finer than we want: a
// scene should span several subtitle cues so that most advances move text only
// and cost no radio at all.
function pickFrames(index, intervalMs) {
	var picked = [];
	var nextTs = 0;
	for (var i = 0; i < index.length; i++) {
		if (index[i].tsMs >= nextTs) {
			picked.push(i);
			nextTs = index[i].tsMs + intervalMs;
		}
	}
	return picked;
}

// Lift a parsed BIF index into the seam's source-neutral frame shape.
//
// The entry itself becomes the LOCATOR — it carries offset and length, which
// mean nothing outside a Plex provider — and the byte length becomes the size
// hint. Plex is a source that CAN answer "how big is this frame", which is why
// blank filtering and duplicate detection are available on it and not on a
// tile-sheet source. See trickplayer-knowledge/SEAM.md §2.
function toFrameRefs(index) {
	var out = [];
	for (var i = 0; i < index.length; i++) {
		out.push({
			tsMs: index[i].tsMs,
			sizeHint: index[i].length,
			locator: index[i]
		});
	}
	return out;
}

if (typeof module !== "undefined") {
	module.exports = {
		parseHeader: parseHeader,
		parseIndex: parseIndex,
		pickFrames: pickFrames,
		toFrameRefs: toFrameRefs
	};
}
