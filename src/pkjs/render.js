// Frame rendering: RGB -> what the watch draws.
//
//   downscale (box filter)  ->  median-cut 16-colour palette  ->  Floyd-Steinberg
//   in palette space        ->  4-bit packed indices
//
// Output is 11,200 B for 200x112 plus a 16-byte palette, which the watch expands
// to ARGB2222 and draws with fillPattern. Validated on the panel against full
// 64-colour: visually indistinguishable at half the bytes.
//
// Palette entries are Pebble GColor8 bytes: AARRGGBB, 2 bits each, alpha 3.
//
// ES5 for the PKJS sandbox; also runs under Node for the offline harness.

// Nearest colour the 64-colour panel can actually show.
function snap64(v) {
	var l = Math.round((v * 3) / 255);
	if (l < 0) l = 0; else if (l > 3) l = 3;
	return l * 85;
}

function gcolor8(r, g, b) {
	return 0xC0 | ((r / 85) << 4) | ((g / 85) << 2) | (b / 85);
}

// Box-filter downscale. Averaging matters here: point sampling a 320x180 frame
// down to 200x112 aliases badly, and the dither downstream turns that into
// visible noise.
function downscale(src, sw, sh, dw, dh) {
	var out = new Uint8Array(dw * dh * 3);
	for (var y = 0; y < dh; y++) {
		var y0 = ((y * sh) / dh) | 0;
		var y1 = (((y + 1) * sh) / dh) | 0;
		if (y1 <= y0) y1 = y0 + 1;
		for (var x = 0; x < dw; x++) {
			var x0 = ((x * sw) / dw) | 0;
			var x1 = (((x + 1) * sw) / dw) | 0;
			if (x1 <= x0) x1 = x0 + 1;
			var r = 0, g = 0, b = 0, n = 0;
			for (var yy = y0; yy < y1; yy++) {
				var row = yy * sw * 3;
				for (var xx = x0; xx < x1; xx++) {
					var o = row + xx * 3;
					r += src[o]; g += src[o + 1]; b += src[o + 2];
					n++;
				}
			}
			var d = (y * dw + x) * 3;
			out[d] = (r / n) | 0;
			out[d + 1] = (g / n) | 0;
			out[d + 2] = (b / n) | 0;
		}
	}
	return out;
}

// Median cut, deliberately over-splitting.
//
// Snapping entries into the 64-colour space makes neighbouring boxes collapse
// onto the same colour, so cutting to exactly 16 leaves duplicates and wastes
// palette slots — a first attempt yielded only 9 distinct colours. Cut to 4x the
// target and keep the first 16 distinct entries, largest boxes first, so the
// colours covering the most pixels win.
function medianCut(rgb, count, n) {
	var idx = [];
	var i;
	// Subsample for speed: a palette does not need every pixel, and this runs on
	// a phone.
	var step = count > 8000 ? 3 : 1;
	for (i = 0; i < count; i += step) idx.push(i * 3);

	var boxes = [idx];
	var target = n * 4;

	while (boxes.length < target) {
		// widest box first
		var bi = -1, bw = -1;
		for (i = 0; i < boxes.length; i++) {
			var bx = boxes[i];
			if (bx.length < 2) continue;
			var lo = [255, 255, 255], hi = [0, 0, 0];
			for (var j = 0; j < bx.length; j++) {
				for (var c = 0; c < 3; c++) {
					var v = rgb[bx[j] + c];
					if (v < lo[c]) lo[c] = v;
					if (v > hi[c]) hi[c] = v;
				}
			}
			var wdt = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
			if (wdt > bw) { bw = wdt; bi = i; }
		}
		if (bi < 0) break;

		var box = boxes[bi];
		var l2 = [255, 255, 255], h2 = [0, 0, 0];
		for (i = 0; i < box.length; i++) {
			for (var c2 = 0; c2 < 3; c2++) {
				var v2 = rgb[box[i] + c2];
				if (v2 < l2[c2]) l2[c2] = v2;
				if (v2 > h2[c2]) h2[c2] = v2;
			}
		}
		var ch = 0, best = h2[0] - l2[0];
		if (h2[1] - l2[1] > best) { ch = 1; best = h2[1] - l2[1]; }
		if (h2[2] - l2[2] > best) { ch = 2; }

		box.sort(function (a, b) { return rgb[a + ch] - rgb[b + ch]; });
		var m = box.length >> 1;
		boxes.splice(bi, 1, box.slice(0, m), box.slice(m));
	}

	boxes.sort(function (a, b) { return b.length - a.length; });

	var pal = [];
	for (i = 0; i < boxes.length && pal.length < n; i++) {
		var bx2 = boxes[i];
		if (!bx2.length) continue;
		var sr = 0, sg = 0, sb = 0;
		for (var k = 0; k < bx2.length; k++) {
			sr += rgb[bx2[k]]; sg += rgb[bx2[k] + 1]; sb += rgb[bx2[k] + 2];
		}
		var e = [
			snap64((sr / bx2.length) | 0),
			snap64((sg / bx2.length) | 0),
			snap64((sb / bx2.length) | 0)
		];
		var dup = false;
		for (var d2 = 0; d2 < pal.length; d2++) {
			if (pal[d2][0] === e[0] && pal[d2][1] === e[1] && pal[d2][2] === e[2]) { dup = true; break; }
		}
		if (!dup) pal.push(e);
	}
	while (pal.length < n) pal.push(pal.length ? pal[pal.length - 1] : [0, 0, 0]);
	return pal;
}

// Floyd-Steinberg against the palette. Error is diffused in RGB space and the
// nearest palette entry chosen per pixel — without this, 16 colours bands badly
// on any gradient.
function ditherToPalette(rgb, w, h, pal) {
	var stride = (w + 1) >> 1;
	var packed = new Uint8Array(stride * h);
	var cur = new Int16Array((w + 2) * 3);
	var nxt = new Int16Array((w + 2) * 3);
	var n = pal.length;

	for (var y = 0; y < h; y++) {
		for (var z = 0; z < nxt.length; z++) nxt[z] = 0;
		for (var x = 0; x < w; x++) {
			var o = (y * w + x) * 3;
			var ci = (x + 1) * 3;
			var wr = rgb[o] + cur[ci];
			var wg = rgb[o + 1] + cur[ci + 1];
			var wb = rgb[o + 2] + cur[ci + 2];
			if (wr < 0) wr = 0; else if (wr > 255) wr = 255;
			if (wg < 0) wg = 0; else if (wg > 255) wg = 255;
			if (wb < 0) wb = 0; else if (wb > 255) wb = 255;

			var bi = 0, bd = 1 << 30;
			for (var p = 0; p < n; p++) {
				var dr = wr - pal[p][0], dg = wg - pal[p][1], db = wb - pal[p][2];
				var dd = dr * dr + dg * dg + db * db;
				if (dd < bd) { bd = dd; bi = p; }
			}

			var er = wr - pal[bi][0], eg = wg - pal[bi][1], eb = wb - pal[bi][2];
			var r2 = (x + 2) * 3, n0 = x * 3, n1 = (x + 1) * 3, n2 = (x + 2) * 3;
			cur[r2] += (er * 7) >> 4; cur[r2 + 1] += (eg * 7) >> 4; cur[r2 + 2] += (eb * 7) >> 4;
			nxt[n0] += (er * 3) >> 4; nxt[n0 + 1] += (eg * 3) >> 4; nxt[n0 + 2] += (eb * 3) >> 4;
			nxt[n1] += (er * 5) >> 4; nxt[n1 + 1] += (eg * 5) >> 4; nxt[n1 + 2] += (eb * 5) >> 4;
			nxt[n2] += er >> 4; nxt[n2 + 1] += eg >> 4; nxt[n2 + 2] += eb >> 4;

			// high nibble holds the even-x pixel
			var po = y * stride + (x >> 1);
			packed[po] |= (x & 1) ? bi : (bi << 4);
		}
		var t = cur; cur = nxt; nxt = t;
	}
	return packed;
}

// rgb: source pixels at sw x sh. Returns { packed, palette } ready for the wire.
function encodeFrame(rgb, sw, sh, dw, dh) {
	var small = downscale(rgb, sw, sh, dw, dh);
	var pal = medianCut(small, dw * dh, 16);
	var packed = ditherToPalette(small, dw, dh, pal);
	var palBytes = new Uint8Array(16);
	for (var i = 0; i < 16; i++) palBytes[i] = gcolor8(pal[i][0], pal[i][1], pal[i][2]);
	return { packed: packed, palette: palBytes, rgbPalette: pal };
}

if (typeof module !== "undefined") {
	module.exports = {
		downscale: downscale,
		medianCut: medianCut,
		ditherToPalette: ditherToPalette,
		encodeFrame: encodeFrame,
		gcolor8: gcolor8
	};
}
