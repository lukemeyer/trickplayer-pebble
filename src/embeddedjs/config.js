// Shared constants. Everything here is either a measured Phase 0 result or a
// deliberate tuning knob — see spikes/PHASE0-FINDINGS.md.

// ---------------------------------------------------------------- geometry
// 200x112 is the full panel width at 16:9, matching the 320x180 BIF thumbnails.
// 160x90, letterboxed 20px each side on the 200px panel.
//
// Was 200x112. Reduced because the XS heaps could not hold a 200x112 scene
// alongside a ~17.5 KB mod: chunk and slot each ran out in turn, and the machine
// total cannot grow without starving the C heap that app_message_open() needs.
//
// A scene drops 14,400 -> 9,760 bytes resident, and the wire cost 11,200 -> 7,200
// (36% less radio per frame), which is a real battery win rather than only a
// concession. Still 16:9.
export const FW = 160;
export const FH = 90;

// Frame is centred horizontally on the 200px panel.
export const FRAME_X = 20;

// Band layout for the 200x228 emery panel. Bottom edge lands at 224, leaving a
// 4px margin. Derived at runtime from unobstructed bounds where possible; these
// are the defaults.
export const LAYOUT = {
	frameY: 0,
	subY: 96,
	subH: 64,
	timeY: 168,
	timeH: 50,
	inset: 4,
};

// ------------------------------------------------------------------ pixels
// Poco on Pebble accepts ONLY these source formats; anything else trips
// PBL_ASSERT and hard-crashes the VM (not catchable from JS).
export const FMT_PEBBLE = 22;
export const FMT_MONO_ALIGNED = 21;   // stride ((w+31)>>5)*4
export const FMT_ARGB2222 = 23;       // stride w   — fillPattern ONLY
export const FMT_GRAY4 = 24;          // stride (w+3)>>2, fixed alpha palette

// Wire depths. v1 ships PAL16: 4-bit indices + a per-frame 16-entry palette,
// expanded on-watch into one reusable ARGB2222 scratch buffer.
export const DEPTH_PAL16 = 4;
export const DEPTH_FULL = 8;

export const palStride = w => (w + 1) >> 1;
export const palBytes = (w, h) => palStride(w) * h;

// ------------------------------------------------------------------- strips
// Frames are expanded 4bpp -> ARGB2222 a horizontal band at a time rather than
// whole. A full-frame scratch is 22,400 B and was the single biggest allocation
// in the app; one strip is 3,200 B, buying back ~19 KB of chunk for ring depth.
// 112 / 16 = 7 strips exactly.
export const STRIP_H = 5;           // 90 / 5 = 18 strips; buffer 160x5 = 800 B
export const STRIP_COUNT = FH / STRIP_H;

// ------------------------------------------------------------------- ring
// Budget is tighter than the raw chunk size suggests. Of 69,632 chunk, ~28 KB
// is baseline runtime overhead, leaving ~41 KB. A PAL16 scene is 11,200 B
// packed. With strip expansion the scratch is only 3,200 B, so the cost is
// 3,200 + RING_SIZE x 11,200 (packed is kept, since every full redraw re-expands
// rather than reading a cached full-frame buffer):
//
//   depth 1 -> 14,400     depth 2 -> 25,600     depth 3 -> 36,800
//
// Usable chunk is ~29,000 (57,344 minus ~28 KB baseline), so 2 fits and 3 does
// not. chunk cannot simply be raised: see mdbl.c — above ~57 KB the C heap runs
// out and app_message_open() hard-aborts the watchface.
//
// Strip expansion is still what makes depth 2 possible at all: a full-frame
// 22,400 B scratch plus one packed scene is 33,600, which does not fit.
export const RING_SIZE = 1;

// ---------------------------------------------------------------- behaviour
// Minimum gap between advances. Every trigger inherits it via scenes.advance(),
// so no source can bypass it.
//
// At 2s the face responds to deliberate tapping, which is what you want while
// testing. The cost is buffer churn: the ring holds 2 scenes at ~3 cues each, so
// about 6 quick taps drain it and force a refill. Raise it (30-60s) once the
// novelty wears off and battery matters more than responsiveness.
export const MIN_DWELL_MS = 2 * 1000;

// Ask for more scenes once free slots reach this.
export const REFILL_AT_FREE = 1;
