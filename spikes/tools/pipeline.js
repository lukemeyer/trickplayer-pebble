// End-to-end pipeline harness: real Plex BIF -> watch-ready bytes.
//
// Runs the SAME modules PKJS will (src/pkjs/{bif,jpeg,render}.js), so what is
// verified here is what ships. Only the transport differs: node https instead of
// XMLHttpRequest.
//
// Usage:
//   PLEX_URL='https://…/library/parts/<id>/indexes/sd?X-Plex-Token=…' \
//     node spikes/tools/pipeline.js [frameIndex]
//
// The token is read from the environment on purpose — it is a credential and
// must not end up in the repo.

const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const bif = require("../../src/pkjs/bif.js");
const jpeg = require("../../src/pkjs/jpeg.js");
const render = require("../../src/pkjs/render.js");

const FW = 200, FH = 112;
const SCENE_INTERVAL_MS = 10000;

const url = process.env.PLEX_URL;
if (!url) {
	console.error("set PLEX_URL");
	process.exit(2);
}

function getRange(from, to) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = https.request({
			hostname: u.hostname,
			port: u.port,
			path: u.pathname + u.search,
			method: "GET",
			headers: { Range: `bytes=${from}-${to}` },
			rejectUnauthorized: false,     // plex.direct uses a per-server cert
		}, res => {
			const chunks = [];
			res.on("data", c => chunks.push(c));
			res.on("end", () => {
				if (res.statusCode !== 206 && res.statusCode !== 200) {
					return reject(new Error("HTTP " + res.statusCode));
				}
				resolve(new Uint8Array(Buffer.concat(chunks)));
			});
		});
		req.on("error", reject);
		req.end();
	});
}

(async () => {
	const t0 = Date.now();

	const head = await getRange(0, 63);
	const header = bif.parseHeader(head);
	console.log(`BIF v${header.version}  ${header.count} frames  ` +
		`multiplier ${header.multiplier}ms  index ${header.indexBytes}B`);

	const idxBytes = await getRange(0, header.indexBytes - 1);
	const index = bif.parseIndex(idxBytes, header);
	const picked = bif.pickFrames(index, SCENE_INTERVAL_MS);
	console.log(`duration ~${(index[index.length - 1].tsMs / 60000).toFixed(1)} min  ` +
		`native spacing ${index[1].tsMs - index[0].tsMs}ms  ` +
		`-> ${picked.length} scenes at ${SCENE_INTERVAL_MS}ms`);

	const which = parseInt(process.argv[2] || "30", 10);
	const fi = picked[Math.min(which, picked.length - 1)];
	const ent = index[fi];
	console.log(`\nframe ${fi} @ ${(ent.tsMs / 1000).toFixed(0)}s  ` +
		`${ent.length}B jpeg at offset ${ent.offset}`);

	const tFetch = Date.now();
	const jpgBytes = await getRange(ent.offset, ent.offset + ent.length - 1);
	const fetchMs = Date.now() - tFetch;

	const tDec = Date.now();
	const img = jpeg.decode(jpgBytes);
	const decMs = Date.now() - tDec;

	const tEnc = Date.now();
	const enc = render.encodeFrame(img.pixels, img.width, img.height, FW, FH);
	const encMs = Date.now() - tEnc;

	console.log(`fetch ${fetchMs}ms  decode ${decMs}ms (${img.width}x${img.height})  ` +
		`encode ${encMs}ms`);
	console.log(`packed ${enc.packed.length}B + ${enc.palette.length}B palette  ` +
		`= ${enc.packed.length + enc.palette.length}B on the wire  ` +
		`(raw jpeg would be ${jpgBytes.length}B)`);

	const uniq = new Set(Array.from(enc.palette));
	console.log(`palette: ${uniq.size} distinct of 16`);

	// Emit an embeddedjs module so the exact bytes can be rendered on the panel.
	const out = path.join(__dirname, "..", "..", "shots", `frame${fi}.js`);
	const b64 = Buffer.from(enc.packed).toString("base64");
	const CH = 1024;
	const parts = [];
	for (let i = 0; i < b64.length; i += CH) parts.push(b64.slice(i, i + CH));
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out,
		`// Real Plex frame ${fi} @ ${(ent.tsMs / 1000) | 0}s, ${FW}x${FH}, 4bpp+palette.\n` +
		`export const MODE = "pal";\nexport const FW = ${FW}, FH = ${FH};\n` +
		`export const PAL = [${Array.from(enc.palette).join(",")}];\n` +
		`export default [\n${parts.map(p => `"${p}",`).join("\n")}\n];\n`);
	console.log(`\nwrote ${out}`);
	console.log(`total ${Date.now() - t0}ms`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
