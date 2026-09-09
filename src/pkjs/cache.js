// Encoded-scene cache in PKJS localStorage.
//
// A scene costs ~13 KB to fetch and 8-17 ms to decode and quantise. Doing that
// once per scene EVER — rather than once per glance — is what lets the watchface
// keep working when the phone is away from the Plex server, which is most of the
// day for most people.
//
// What is cached is the *encoded* result (4-bit indices + palette), not the
// JPEG: it is roughly half the size and needs no work to replay.
//
// localStorage holds strings, so bytes are base64'd — 11,216 B becomes ~14,955
// chars. The real quota is unknown and varies by phone runtime (R4), so capacity
// is probed once and the cache evicts LRU on quota errors rather than assuming a
// number.

var LS = null;
try { LS = localStorage; } catch (e) { LS = null; }

var IDX_KEY = "bif.lru";        // JSON array of cache keys, most recent last
var CAP_KEY = "bif.cap";        // probed capacity in KB

var lru = null;
var profile = "";

function log(s) { console.log("[cache] " + s); }

function loadLru() {
	if (lru) return lru;
	lru = [];
	if (!LS) return lru;
	try {
		var raw = LS.getItem(IDX_KEY);
		if (raw) lru = JSON.parse(raw);
	} catch (e) { lru = []; }
	return lru;
}

function saveLru() {
	if (!LS) return;
	try { LS.setItem(IDX_KEY, JSON.stringify(lru)); } catch (e) { /* full */ }
}

// Identifies the encoding, so changing geometry or depth invalidates cleanly
// rather than serving bytes the watch can no longer draw.
//
// SCHEMA is part of the key so a change to the stored SHAPE invalidates too.
// Bumped to 2 when entries gained `f` (the resolved frame): v1 entries lack it,
// and replaying them would resurrect the duplicate-frame bug.
var SCHEMA = 2;

function setProfile(timelineRef, w, h, depth) {
	profile = SCHEMA + "." + timelineRef + "." + w + "x" + h + "." + depth;
}

function keyFor(sceneIdx) {
	return "f." + profile + "." + sceneIdx;
}

// base64 without atob/btoa, which PKJS does not reliably provide.
var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64R = null;

function toB64(arr) {
	var out = "", i, n = arr.length;
	for (i = 0; i + 2 < n; i += 3) {
		var v = (arr[i] << 16) | (arr[i + 1] << 8) | arr[i + 2];
		out += B64C[(v >> 18) & 63] + B64C[(v >> 12) & 63] + B64C[(v >> 6) & 63] + B64C[v & 63];
	}
	var rem = n - i;
	if (rem === 1) {
		var a = arr[i] << 16;
		out += B64C[(a >> 18) & 63] + B64C[(a >> 12) & 63] + "==";
	} else if (rem === 2) {
		var b = (arr[i] << 16) | (arr[i + 1] << 8);
		out += B64C[(b >> 18) & 63] + B64C[(b >> 12) & 63] + B64C[(b >> 6) & 63] + "=";
	}
	return out;
}

function fromB64(s) {
	if (!B64R) {
		B64R = {};
		for (var c = 0; c < 64; c++) B64R[B64C.charAt(c)] = c;
	}
	var len = s.length;
	while (len > 0 && s.charAt(len - 1) === "=") len--;
	var out = new Array((len * 3) >> 2);
	var o = 0, acc = 0, bits = 0;
	for (var i = 0; i < len; i++) {
		acc = (acc << 6) | B64R[s.charAt(i)];
		bits += 6;
		if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
	}
	out.length = o;
	return out;
}

// Returns { packed, pal, cues, tsMs } or null.
function get(sceneIdx) {
	if (!LS) return null;
	var k = keyFor(sceneIdx);
	var raw;
	try { raw = LS.getItem(k); } catch (e) { return null; }
	if (!raw) return null;

	var obj;
	try { obj = JSON.parse(raw); } catch (e2) {
		try { LS.removeItem(k); } catch (e3) { /* ignore */ }
		return null;
	}

	// Touch: move to the end of the LRU.
	loadLru();
	var at = lru.indexOf(k);
	if (at !== -1) lru.splice(at, 1);
	lru.push(k);
	saveLru();

	return {
		packed: fromB64(obj.p),
		pal: fromB64(obj.q),
		cues: obj.c || [],
		tsMs: obj.t || 0,
		f: obj.f
	};
}

function evictOldest() {
	loadLru();
	if (!lru.length) return false;
	var k = lru.shift();
	try { LS.removeItem(k); } catch (e) { /* ignore */ }
	saveLru();
	return true;
}

function put(sceneIdx, scene) {
	if (!LS) return false;
	var k = keyFor(sceneIdx);
	var payload = JSON.stringify({
		p: toB64(scene.packed),
		q: toB64(scene.pal),
		c: scene.cues,
		t: scene.tsMs,
		f: scene.pick        // which `picked` entry this resolved to
	});

	// Quota errors are the normal steady state once the cache fills, not an
	// exception: evict and retry rather than giving up on caching entirely.
	for (var tries = 0; tries < 40; tries++) {
		try {
			LS.setItem(k, payload);
			loadLru();
			var at = lru.indexOf(k);
			if (at !== -1) lru.splice(at, 1);
			lru.push(k);
			saveLru();
			return true;
		} catch (e) {
			if (!evictOldest()) {
				log("cannot store scene " + sceneIdx + ": " + (e.message || e));
				return false;
			}
		}
	}
	return false;
}

function count() { return loadLru().length; }

// Capacity probe — DIAGNOSTIC ONLY, do not call on startup.
//
// Writing and deleting thousands of 1 KB entries took 65 SECONDS in pypkjs,
// blocking the PKJS thread and delaying the watch handshake behind it. Knowing
// the quota buys nothing anyway: put() already evicts LRU on quota errors, so
// the cache finds its own ceiling. Measured once at >= 8 MB (>= 546 scenes),
// which is more than a whole episode.
function probeCapacity() {
	if (!LS) { log("no localStorage"); return 0; }
	try {
		var known = LS.getItem(CAP_KEY);
		if (known) { log("capacity ~" + known + " KB (cached probe)"); return parseInt(known, 10); }
	} catch (e) { return 0; }

	var chunk = "";
	for (var i = 0; i < 1024; i++) chunk += "x";     // 1 KB
	var LIMIT = 8192;                                // stop probing at 8 MB
	var kb = 0;
	var keys = [];
	var hitWall = false;
	try {
		for (var n = 0; n < LIMIT; n++) {
			var kk = "bif.probe." + n;
			LS.setItem(kk, chunk);
			keys.push(kk);
			kb++;
		}
	} catch (e2) { hitWall = true; }
	for (var j = 0; j < keys.length; j++) {
		try { LS.removeItem(keys[j]); } catch (e3) { /* ignore */ }
	}
	try { LS.setItem(CAP_KEY, String(kb)); } catch (e4) { /* ignore */ }
	// Say which limit was reached: without a quota error this is a floor, not a
	// measurement, and reporting it as the quota would be wrong.
	log("capacity " + (hitWall ? "~" : ">=") + kb + " KB " +
		(hitWall ? "(quota)" : "(probe ceiling, real quota may be higher)") +
		" = " + (hitWall ? "~" : ">=") + Math.floor(kb / 15) + " scenes");
	return kb;
}

if (typeof module !== "undefined") {
	module.exports = {
		setProfile: setProfile, get: get, put: put, count: count,
		probeCapacity: probeCapacity, toB64: toB64, fromB64: fromB64
	};
}
