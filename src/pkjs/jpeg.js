// Baseline JPEG decoder for PebbleKit JS.
//
// PKJS has no canvas and no image decoding, so BIF frames have to be decoded in
// pure JS. Written for that sandbox rather than a browser: ES5 syntax, no typed
// arrays assumed beyond Uint8Array/Int32Array, no closures in hot loops.
//
// Scope is deliberately narrow — exactly what Plex BIF thumbnails are:
//   * baseline sequential DCT (SOF0) only, no progressive
//   * 8-bit samples, 1 or 3 components
//   * standard Huffman coding
// Anything else throws rather than silently producing garbage.
//
// decode(bytes) -> { width, height, pixels }  with pixels as RGB triplets.

var ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

function clamp8(v) {
	return v < 0 ? 0 : (v > 255 ? 255 : v);
}

// ------------------------------------------------------------------ huffman
// Flat lookup: maxcode/valptr per code length, the classic JPEG-spec decode.
function buildHuffman(bits, values) {
	var code = 0, k = 0, i, j;
	var mincode = new Int32Array(17);
	var maxcode = new Int32Array(18);
	var valptr = new Int32Array(17);

	for (i = 1; i <= 16; i++) {
		valptr[i] = k;
		mincode[i] = code;
		code += bits[i];
		maxcode[i] = code - 1;
		code <<= 1;
		k += bits[i];
	}
	maxcode[17] = 0x7fffffff;
	// A length with no codes must never match.
	for (i = 1; i <= 16; i++) {
		if (bits[i] === 0) maxcode[i] = -1;
	}
	return { mincode: mincode, maxcode: maxcode, valptr: valptr, values: values };
}

// ------------------------------------------------------------------- IDCT
// Separable float IDCT. Simple and accurate; the frames are small enough that
// an AAN integer version is not worth the extra code here.
var COS = new Float64Array(64);
(function () {
	for (var u = 0; u < 8; u++) {
		for (var x = 0; x < 8; x++) {
			COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
				(u === 0 ? Math.SQRT1_2 : 1);
		}
	}
})();

function idct8x8(block, out) {
	var tmp = new Float64Array(64);
	var x, y, u, v, s;

	// rows
	for (y = 0; y < 8; y++) {
		for (x = 0; x < 8; x++) {
			s = 0;
			for (u = 0; u < 8; u++) s += COS[u * 8 + x] * block[y * 8 + u];
			tmp[y * 8 + x] = s;
		}
	}
	// columns
	for (x = 0; x < 8; x++) {
		for (y = 0; y < 8; y++) {
			s = 0;
			for (v = 0; v < 8; v++) s += COS[v * 8 + y] * tmp[v * 8 + x];
			out[y * 8 + x] = clamp8(Math.round(s / 4) + 128);
		}
	}
}

// ------------------------------------------------------------------ decode
function decode(data) {
	var qt = [];            // quantization tables
	var huffDC = [], huffAC = [];
	var frame = null;
	var resetInterval = 0;
	var pos = 2;            // skip SOI

	if (data[0] !== 0xFF || data[1] !== 0xD8) throw new Error("not a JPEG");

	function u16(p) { return (data[p] << 8) | data[p + 1]; }

	while (pos < data.length) {
		if (data[pos] !== 0xFF) { pos++; continue; }
		var marker = data[pos + 1];
		pos += 2;
		if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
		if (marker === 0xD9) break;

		var len = u16(pos);
		var seg = pos + 2;
		var segEnd = pos + len;

		if (marker === 0xDB) {                     // DQT
			while (seg < segEnd) {
				var pq = data[seg] >> 4, tq = data[seg] & 15;
				seg++;
				var tbl = new Int32Array(64);
				for (var i = 0; i < 64; i++) {
					if (pq) { tbl[ZIGZAG[i]] = u16(seg); seg += 2; }
					else { tbl[ZIGZAG[i]] = data[seg]; seg++; }
				}
				qt[tq] = tbl;
			}
		} else if (marker === 0xC0 || marker === 0xC1) {   // SOF0/SOF1 baseline
			var h = u16(seg + 1), w = u16(seg + 3);
			var n = data[seg + 5];
			var comps = [];
			var p = seg + 6;
			var maxH = 1, maxV = 1;
			for (var c = 0; c < n; c++) {
				var cid = data[p], hv = data[p + 1];
				var ch = hv >> 4, cv = hv & 15;
				if (ch > maxH) maxH = ch;
				if (cv > maxV) maxV = cv;
				comps.push({ id: cid, h: ch, v: cv, tq: data[p + 2] });
				p += 3;
			}
			frame = { width: w, height: h, comps: comps, maxH: maxH, maxV: maxV };
		} else if (marker === 0xC2) {
			throw new Error("progressive JPEG not supported");
		} else if (marker === 0xC4) {              // DHT
			while (seg < segEnd) {
				var tc = data[seg] >> 4, th = data[seg] & 15;
				seg++;
				var bits = new Int32Array(17);
				var total = 0;
				for (var b = 1; b <= 16; b++) { bits[b] = data[seg + b - 1]; total += bits[b]; }
				seg += 16;
				var vals = new Uint8Array(total);
				for (var vi = 0; vi < total; vi++) vals[vi] = data[seg + vi];
				seg += total;
				if (tc === 0) huffDC[th] = buildHuffman(bits, vals);
				else huffAC[th] = buildHuffman(bits, vals);
			}
		} else if (marker === 0xDD) {              // DRI
			resetInterval = u16(seg);
		} else if (marker === 0xDA) {              // SOS — scan follows
			if (!frame) throw new Error("SOS before SOF");
			var ns = data[seg];
			var scan = [];
			var sp = seg + 1;
			for (var si = 0; si < ns; si++) {
				var scid = data[sp], tt = data[sp + 1];
				for (var fi = 0; fi < frame.comps.length; fi++) {
					if (frame.comps[fi].id === scid) {
						frame.comps[fi].dcTbl = tt >> 4;
						frame.comps[fi].acTbl = tt & 15;
						scan.push(frame.comps[fi]);
					}
				}
				sp += 2;
			}
			pos = decodeScan(data, sp + 3, frame, scan, qt, huffDC, huffAC, resetInterval);
			continue;
		}
		pos = segEnd;
	}

	if (!frame) throw new Error("no frame");
	return toRGB(frame);
}

function decodeScan(data, start, frame, scan, qt, huffDC, huffAC, resetInterval) {
	var p = start;
	var bitBuf = 0, bitCnt = 0, eof = false;

	function nextBit() {
		if (bitCnt === 0) {
			if (p >= data.length) { eof = true; return 0; }
			var b = data[p++];
			if (b === 0xFF) {
				var b2 = data[p];
				if (b2 === 0x00) p++;                       // stuffed byte
				else if (b2 >= 0xD0 && b2 <= 0xD7) { /* RST handled by caller */ }
				else { eof = true; return 0; }
			}
			bitBuf = b;
			bitCnt = 8;
		}
		bitCnt--;
		return (bitBuf >> bitCnt) & 1;
	}

	function receive(n) {
		var v = 0;
		while (n-- > 0) v = (v << 1) | nextBit();
		return v;
	}

	// Sign-extend a JPEG variable-length integer.
	function extend(v, n) {
		return v < (1 << (n - 1)) ? v - (1 << n) + 1 : v;
	}

	function decodeHuff(tbl) {
		var code = nextBit(), l = 1;
		while (code > tbl.maxcode[l]) {
			code = (code << 1) | nextBit();
			l++;
			if (l > 16) return 0;
		}
		return tbl.values[tbl.valptr[l] + code - tbl.mincode[l]];
	}

	// Allocate per-component sample planes at their own subsampled resolution.
	var mcuW = frame.maxH * 8, mcuH = frame.maxV * 8;
	var mcusX = Math.ceil(frame.width / mcuW);
	var mcusY = Math.ceil(frame.height / mcuH);
	var ci, comp;
	for (ci = 0; ci < frame.comps.length; ci++) {
		comp = frame.comps[ci];
		comp.bw = mcusX * comp.h * 8;
		comp.bh = mcusY * comp.v * 8;
		comp.data = new Uint8Array(comp.bw * comp.bh);
		comp.pred = 0;
	}

	var block = new Int32Array(64);
	var out = new Uint8Array(64);
	var mcu = 0, total = mcusX * mcusY;

	while (mcu < total) {
		var stop = resetInterval ? Math.min(total, mcu + resetInterval) : total;

		for (; mcu < stop; mcu++) {
			var my = (mcu / mcusX) | 0, mx = mcu % mcusX;

			for (ci = 0; ci < scan.length; ci++) {
				comp = scan[ci];
				var q = qt[comp.tq];
				for (var by = 0; by < comp.v; by++) {
					for (var bx = 0; bx < comp.h; bx++) {
						// --- one 8x8 block
						for (var z = 0; z < 64; z++) block[z] = 0;

						var t = decodeHuff(huffDC[comp.dcTbl]);
						var diff = t === 0 ? 0 : extend(receive(t), t);
						comp.pred += diff;
						block[0] = comp.pred * q[0];

						var k = 1;
						while (k < 64) {
							var rs = decodeHuff(huffAC[comp.acTbl]);
							var s = rs & 15, r = rs >> 4;
							if (s === 0) {
								if (r === 15) { k += 16; continue; }
								break;                          // EOB
							}
							k += r;
							if (k > 63) break;
							var zz = ZIGZAG[k];
							block[zz] = extend(receive(s), s) * q[zz];
							k++;
						}

						idct8x8(block, out);

						var ox = (mx * comp.h + bx) * 8;
						var oy = (my * comp.v + by) * 8;
						for (var yy = 0; yy < 8; yy++) {
							var dst = (oy + yy) * comp.bw + ox;
							var src = yy * 8;
							for (var xx = 0; xx < 8; xx++) comp.data[dst + xx] = out[src + xx];
						}
					}
				}
			}
			if (eof) { mcu = total; break; }
		}

		// Restart marker: realign and reset DC predictors.
		if (resetInterval && mcu < total) {
			bitCnt = 0;
			while (p < data.length - 1) {
				if (data[p] === 0xFF && data[p + 1] >= 0xD0 && data[p + 1] <= 0xD7) { p += 2; break; }
				p++;
			}
			for (ci = 0; ci < frame.comps.length; ci++) frame.comps[ci].pred = 0;
		}
	}

	// Skip to the next marker for the caller.
	while (p < data.length - 1 && !(data[p] === 0xFF && data[p + 1] !== 0x00)) p++;
	return p;
}

function toRGB(frame) {
	var w = frame.width, h = frame.height;
	var out = new Uint8Array(w * h * 3);
	var comps = frame.comps;

	if (comps.length === 1) {
		var g = comps[0];
		for (var y = 0; y < h; y++) {
			for (var x = 0; x < w; x++) {
				var v = g.data[y * g.bw + x];
				var o = (y * w + x) * 3;
				out[o] = v; out[o + 1] = v; out[o + 2] = v;
			}
		}
		return { width: w, height: h, pixels: out };
	}

	var Y = comps[0], Cb = comps[1], Cr = comps[2];
	// Nearest-neighbour chroma upsampling: at these sizes, and with a 4-bit
	// palette downstream, bilinear would not survive the quantiser.
	var yhs = Y.h / frame.maxH, yvs = Y.v / frame.maxV;
	var bhs = Cb.h / frame.maxH, bvs = Cb.v / frame.maxV;
	var rhs = Cr.h / frame.maxH, rvs = Cr.v / frame.maxV;

	for (var yy2 = 0; yy2 < h; yy2++) {
		for (var xx2 = 0; xx2 < w; xx2++) {
			var yv = Y.data[((yy2 * yvs) | 0) * Y.bw + ((xx2 * yhs) | 0)];
			var cb = Cb.data[((yy2 * bvs) | 0) * Cb.bw + ((xx2 * bhs) | 0)] - 128;
			var cr = Cr.data[((yy2 * rvs) | 0) * Cr.bw + ((xx2 * rhs) | 0)] - 128;
			var o2 = (yy2 * w + xx2) * 3;
			out[o2] = clamp8((yv + 1.402 * cr) | 0);
			out[o2 + 1] = clamp8((yv - 0.344136 * cb - 0.714136 * cr) | 0);
			out[o2 + 2] = clamp8((yv + 1.772 * cb) | 0);
		}
	}
	return { width: w, height: h, pixels: out };
}

if (typeof module !== "undefined") module.exports = { decode: decode };
