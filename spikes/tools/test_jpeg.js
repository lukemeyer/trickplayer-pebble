// Validate src/pkjs/jpeg.js against real BIF frames, using macOS `sips` as the
// reference decoder. Run with: node spikes/tools/test_jpeg.js <frame.jpg>...
//
// Checks dimensions, then mean and max absolute per-channel error against the
// reference. A correct baseline decoder should land within a couple of levels
// on average — chroma upsampling differs between implementations, so exact
// equality is not the bar.

const fs = require("fs");
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const { decode } = require("../../src/pkjs/jpeg.js");

function referenceRGB(jpg) {
	const tmp = path.join(os.tmpdir(), "ref-" + process.pid + ".bmp");
	execFileSync("sips", ["-s", "format", "bmp", jpg, "--out", tmp], { stdio: "ignore" });
	const d = fs.readFileSync(tmp);
	fs.unlinkSync(tmp);
	const off = d.readUInt32LE(10);
	const w = d.readInt32LE(18);
	let h = d.readInt32LE(22);
	const topdown = h < 0;
	h = Math.abs(h);
	const row = Math.ceil((w * 3) / 4) * 4;
	const px = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		const yy = topdown ? y : h - 1 - y;
		for (let x = 0; x < w; x++) {
			const s = off + yy * row + x * 3;
			const o = (y * w + x) * 3;
			px[o] = d[s + 2]; px[o + 1] = d[s + 1]; px[o + 2] = d[s];
		}
	}
	return { width: w, height: h, pixels: px };
}

let failures = 0;
for (const jpg of process.argv.slice(2)) {
	const bytes = new Uint8Array(fs.readFileSync(jpg));

	const t0 = Date.now();
	let got;
	try {
		got = decode(bytes);
	} catch (e) {
		console.log(`FAIL ${path.basename(jpg)}: ${e.message}`);
		failures++;
		continue;
	}
	const ms = Date.now() - t0;

	const ref = referenceRGB(jpg);
	if (got.width !== ref.width || got.height !== ref.height) {
		console.log(`FAIL ${path.basename(jpg)}: ${got.width}x${got.height} vs ref ${ref.width}x${ref.height}`);
		failures++;
		continue;
	}

	let sum = 0, max = 0;
	const n = ref.width * ref.height * 3;
	for (let i = 0; i < n; i++) {
		const d = Math.abs(got.pixels[i] - ref.pixels[i]);
		sum += d;
		if (d > max) max = d;
	}
	const mean = sum / n;
	const ok = mean < 4;
	if (!ok) failures++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${path.basename(jpg)}  ${got.width}x${got.height}  ` +
		`decode ${ms}ms  meanErr ${mean.toFixed(2)}  maxErr ${max}`);
}

process.exit(failures ? 1 : 0);
