// Scene ring buffer and the single advance() path.
//
// A "scene" is one frame bitmap plus every subtitle cue in its window. Because
// the scene interval (~10s of video) is coarser than the BIF's native 2s frame
// spacing, several cues normally share a frame — so most advances move the text
// only and cost no radio at all. Crossing into a new scene is the expensive
// step, and that is what the ring buffer hides.
//
// Frames arrive as 4-bit indices + a 16-entry palette (11,200 B for 200x112).
// They are expanded to ARGB2222 lazily, into ONE shared scratch buffer, because
// fillPattern is the only Poco path on Pebble that accepts colour.

import {
	FW, FH, FMT_ARGB2222, RING_SIZE, MIN_DWELL_MS, REFILL_AT_FREE,
	palStride, palBytes, STRIP_H, STRIP_COUNT,
} from "config";
import Bitmap from "commodetto/Bitmap";

const ring = [];          // metadata only: { idx, tsMs, cues[] }. Pixels are in packedBuf.
let cursorScene = 0;      // index into ring
let cursorCue = 0;        // index into ring[cursorScene].cues
let lastAdvance = 0;
let lastCueText = "";   // survives retirement so the band keeps its text
let frameValid = false; // false while packedBuf is being overwritten

// One strip buffer for the whole app. A full-frame ARGB2222 scratch is 22,400 B
// and was the largest allocation in the app; a 200x16 strip is 3,200 B. Both the
// buffer and its Bitmap are allocated once and overwritten in place, so drawing
// a frame allocates nothing.
//
// Safe to reuse between draws because Poco on Pebble renders immediately rather
// than building a display list: PocoBitmapPattern calls
// graphics_draw_bitmap_in_rect_processed() directly (commodettoPocoBlit-pebble.c).
const strip = new ArrayBuffer(FW * STRIP_H);
const stripU8 = new Uint8Array(strip);
const stripBitmap = new Bitmap(FW, STRIP_H, FMT_ARGB2222, strip, 0);

// THE scene buffer. Allocated once, reused forever.
//
// Previously each arriving scene allocated its own 7,200-byte array, so peak use
// depended on GC timing and on whether the outgoing scene had been collected
// yet. That is what made "memory full" intermittent rather than reproducible:
// the budget is tight enough that a transient second buffer sometimes fits and
// sometimes does not.
//
// Reassembling into a fixed buffer makes frame memory constant. It also pins
// RING_SIZE to 1 — there is exactly one buffer — which is what the memory budget
// allows anyway.
const packedBuf = new Uint8Array(palBytes(FW, FH));
const palBuf = new Uint8Array(16);

let onChange = () => {};
let onNeedScenes = () => {};

// Where to resume. Alloy gives the watch a real localStorage that survives
// reboots and app updates, so the position in the episode is not lost when the
// watchface restarts — which matters when a scene costs a fetch and a decode.
const POS_KEY = "bif.pos";
const PERSIST = true;
let resumeIdx = 0;

function loadPos() {
	if (!PERSIST) return;
	try {
		const raw = localStorage.getItem(POS_KEY);
		if (!raw) return;
		const p = JSON.parse(raw);
		if (typeof p.s === "number") resumeIdx = p.s;
	} catch (e) { /* first run, or storage unavailable */ }
}

// Record a resume point directly, for when there is no current scene to read.
function persistResume(sceneIdx) {
	if (!PERSIST) return;
	resumeIdx = sceneIdx;
	try {
		localStorage.setItem(POS_KEY, JSON.stringify({ s: sceneIdx, c: 0 }));
	} catch (e) { /* not worth failing a redraw over */ }
}

function savePos() {
	if (!PERSIST) return;
	const s = ring[cursorScene];
	if (!s) return;
	try {
		localStorage.setItem(POS_KEY, JSON.stringify({ s: s.idx, c: cursorCue }));
	} catch (e) { /* not worth failing a redraw over */ }
}

export function init(handlers) {
	onChange = handlers.onChange || onChange;
	onNeedScenes = handlers.onNeedScenes || onNeedScenes;
	loadPos();
}

export function resumeAt() { return resumeIdx; }

export function freeSlots() {
	return RING_SIZE - ring.length;
}

// scene is metadata only: { idx, tsMs, cues }. Pixels are already in packedBuf.
export function push(scene) {
	if (ring.length >= RING_SIZE) return false;
	ring.push(scene);
	if (ring.length === 1) { cursorScene = 0; cursorCue = 0; savePos(); }
	return true;
}

export function lastCue() { return lastCueText; }

export function current() {
	const s = ring[cursorScene];
	if (!s) return null;
	lastCueText = s.cues.length ? s.cues[Math.min(cursorCue, s.cues.length - 1)] : lastCueText;
	return {
		idx: s.idx,
		tsMs: s.tsMs,
		cue: s.cues.length ? s.cues[Math.min(cursorCue, s.cues.length - 1)] : "",
		cueNum: cursorCue + 1,
		cueCount: s.cues.length,
	};
}

export function hasFrame() {
	return !!ring[cursorScene] && frameValid;
}

// Hand the shared buffers to the transport to fill in place.
export function receiveBuffers() {
	return { packed: packedBuf, pal: palBuf };
}

// Called before the first chunk: the buffer is about to be overwritten, so what
// is in it no longer matches the scene on screen. The panel keeps showing the
// old pixels (face.js does not repaint the band), which is exactly what we want
// while the replacement streams in.
export function beginReceive() {
	frameValid = false;
}

export function commitReceive() {
	frameValid = true;
}

export { STRIP_H, STRIP_COUNT };

// Expand strip `k` of the current scene into the shared buffer and hand back the
// Bitmap over it. The caller draws it before asking for the next strip — the
// buffer is reused, so the previous strip's pixels are gone once this returns.
export function stripAt(k) {
	if (!ring[cursorScene] || !frameValid) return null;

	const stride = palStride(FW);
	const packed = packedBuf, pal = palBuf;
	const y0 = k * STRIP_H;

	for (let row = 0; row < STRIP_H; row++) {
		const src = (y0 + row) * stride;
		const dst = row * FW;
		for (let x = 0; x < FW; x++) {
			const b = packed[src + (x >> 1)];
			stripU8[dst + x] = pal[(x & 1) ? (b & 15) : (b >> 4)];
		}
	}
	return stripBitmap;
}

// The single entry point every trigger funnels through.
//
// Returns "cue"   — moved within the current scene: text only, frame unchanged
//         "scene" — retired a scene: the picture changes
//         false   — refused (rate limited, or nothing buffered)
//
// `force` skips the dwell check. Only the play burst uses it: the burst is
// already bounded in length and was itself started by a rate-limited tap, so
// applying the dwell again would just stall it.
export function advance(reason, force) {
	const t = Date.now();
	if (!force && t - lastAdvance < MIN_DWELL_MS) return false;

	const s = ring[cursorScene];
	if (!s) {
		// Nothing buffered yet — still worth asking for scenes.
		maybeRefill();
		return false;
	}

	lastAdvance = t;

	let kind = "scene";
	if (cursorCue + 1 < s.cues.length) {
		cursorCue++;                       // text-only: no new bitmap, no radio
		kind = "cue";
	} else {
		// Cues exhausted — retire the scene whatever the ring depth.
		//
		// This used to require ring.length > 1, which meant a 1-deep ring could
		// never move past its last cue: every tap was refused and the face
		// looked dead. The same trap applied at any depth once the buffer ran
		// dry. Retiring into an empty ring is fine — the face shows "waiting for
		// phone" for a moment while the refill lands, which is honest.
		const retired = s.idx;
		ring.shift();
		cursorScene = 0;
		cursorCue = 0;
		// savePos() reads the CURRENT scene, so with an empty ring it would save
		// nothing. Record where to resume explicitly.
		persistResume(retired + 1);
	}

	savePos();
	onChange(reason, kind);
	maybeRefill();
	return kind;
}

// True while the current scene still has unshown cues — i.e. a play burst has
// somewhere left to go without crossing a scene boundary.
export function hasMoreCues() {
	const s = ring[cursorScene];
	return !!s && cursorCue + 1 < s.cues.length;
}

export function maybeRefill() {
	if (freeSlots() >= REFILL_AT_FREE) {
		// With an empty ring, pick up where the last run left off rather than
		// restarting the episode.
		const nextIdx = ring.length ? ring[ring.length - 1].idx + 1 : resumeIdx;
		onNeedScenes(nextIdx, freeSlots());
	}
}

