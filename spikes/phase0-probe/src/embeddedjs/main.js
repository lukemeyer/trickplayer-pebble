// Phase 0 probe — side-by-side: same real BIF frame, 64-colour vs 16-colour
// palette, both rendered on the actual panel at the same size.
//
// 120x68 rather than the shipping 200x112 because embedded string data competes
// with the XS heap: 200x112 "full" (30k b64 chars) faults the mod at load.
// The quality question is scale-independent, and the byte figures below are
// scaled to what a real 200x112 frame would cost.

import Poco from "commodetto/Poco";
import Bitmap from "commodetto/Bitmap";
import FULL, { FW, FH } from "frameFull";
import PACKED, { PAL } from "framePal";

const render = new Poco(screen);
const L = s => console.log("[PROBE] " + s);
const ARGB2222 = 23;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REV = new Uint8Array(128);
for (let i = 0; i < 64; i++) REV[B64.charCodeAt(i)] = i;

function decodeInto(chunks, dest) {
	let o = 0;
	for (let ci = 0; ci < chunks.length; ci++) {
		const s = chunks[ci];
		let len = s.length;
		while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
		let acc = 0, bits = 0;
		for (let i = 0; i < len; i++) {
			acc = (acc << 6) | REV[s.charCodeAt(i)];
			bits += 6;
			if (bits >= 8) { bits -= 8; dest[o++] = (acc >> bits) & 0xff; }
		}
	}
	return o;
}

// scale a cost at 120x68 up to the shipping 200x112
const scale = b => Math.round(b * (200 * 112) / (FW * FH));

let fullBmp = null, palBmp = null;
try {
	const fb = new ArrayBuffer(FW * FH);
	decodeInto(FULL, new Uint8Array(fb));
	fullBmp = new Bitmap(FW, FH, ARGB2222, fb, 0);
	L(`full ${FW}x${FH} = ${FW * FH}B  (${scale(FW * FH)}B at 200x112)`);

	const stride = (FW + 1) >> 1;
	const packed = new Uint8Array(stride * FH);
	decodeInto(PACKED, packed);
	const sb = new ArrayBuffer(FW * FH);
	const outp = new Uint8Array(sb);
	for (let y = 0; y < FH; y++) {
		const s = y * stride, d = y * FW;
		for (let x = 0; x < FW; x++) {
			const b = packed[s + (x >> 1)];
			outp[d + x] = PAL[(x & 1) ? (b & 15) : (b >> 4)];
		}
	}
	palBmp = new Bitmap(FW, FH, ARGB2222, sb, 0);
	L(`pal  ${FW}x${FH} = ${stride * FH}B  (${scale(stride * FH)}B at 200x112)`);
} catch (e) {
	L("FAIL " + e);
}

const font = new render.Font("Gothic-Regular", 14);
const white = render.makeColor(255, 255, 255);
const black = render.makeColor(0, 0, 0);

function draw() {
	render.begin();
	render.fillRectangle(black, 0, 0, render.width, render.height);
	const x = (render.width - FW) >> 1;

	if (fullBmp) render.fillPattern(fullBmp, x, 4, FW, FH);
	render.drawText(`64 COLOUR  ${scale(FW * FH)}B`, font, white, x, FH + 6);

	if (palBmp) render.fillPattern(palBmp, x, FH + 24, FW, FH);
	render.drawText(`16 PALETTE  ${scale(((FW + 1) >> 1) * FH)}B`, font, white, x, 2 * FH + 26);

	render.end();
}

draw();
L("draw OK");
let n = 0;
setInterval(() => { if (++n <= 8) L("alive " + n); }, 8000);
watch.addEventListener("minutechange", draw);
