// Plex HTTP access from PebbleKit JS.
//
// PKJS gives us XMLHttpRequest and nothing else — no fetch, no streams. Ranged
// GETs are essential rather than an optimisation: a 24.5 min episode's BIF is
// 9.5 MB, so it can neither be held in memory nor cached in localStorage. The
// index (~6 KB) is fetched once; frames are pulled individually by byte range.
//
// Plex serves Accept-Ranges: bytes and answers 206 correctly (verified against a
// real server), but a proxy or an older build might not, so range support is
// probed once and recorded.
//
// Binary reads: responseType "arraybuffer" is the fast path. Where it is
// unavailable — a real risk on the phone runtimes, less so in the emulator's
// V8-based pypkjs — fall back to overrideMimeType with a Latin-1 charset, which
// makes responseText a byte-per-char string.

var rangeSupported = null;      // null = unknown, true/false once probed
var binaryMode = null;         // "arraybuffer" or "latin1-text", logged once (R2)

function log(s) { console.log("[plex] " + s); }

// The token travels as a header, never as a query parameter. URLs are logged
// — by proxies, by servers, by anything that records a request line — and a
// credential in one ends up in cache keys, in Referer, and in any log excerpt
// pasted into a findings doc. Headers usually are not logged.
// See trickplayer-knowledge findings/F-021.
//
// Verified against a real Plex server: it answers the CORS preflight with
// `access-control-allow-headers: x-plex-token,range`. PKJS is not subject to
// CORS at all, so this is unconditionally safe here.
//
// cb(err, Uint8Array)
function getRange(url, from, to, token, cb) {
	var xhr = new XMLHttpRequest();
	xhr.open("GET", url, true);
	if (token) xhr.setRequestHeader("X-Plex-Token", token);

	// Ask for both. A runtime can ACCEPT responseType = "arraybuffer" — the
	// assignment sticks and reads back correctly — and still leave `response`
	// empty at onload, which is what pypkjs does. Setting the Latin-1 override
	// as well costs nothing (real browsers ignore it once responseType is set)
	// and means responseText is still byte-accurate when we have to fall back.
	// Without it, responseText is UTF-8 decoded and the bytes are corrupted.
	try { xhr.responseType = "arraybuffer"; } catch (e) { /* older runtime */ }
	try {
		if (xhr.overrideMimeType) xhr.overrideMimeType("text/plain; charset=x-user-defined");
	} catch (e2) { /* ignore */ }

	if (from !== null) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

	xhr.onload = function () {
		if (xhr.status !== 200 && xhr.status !== 206) {
			cb(new Error("HTTP " + xhr.status));
			return;
		}
		if (rangeSupported === null && from !== null) {
			rangeSupported = xhr.status === 206;
			log("range supported: " + rangeSupported);
		}

		var bytes = null;
		var resp = null;
		try { resp = xhr.response; } catch (e3) { resp = null; }

		if (resp && typeof resp.byteLength === "number" && resp.byteLength > 0) {
			bytes = new Uint8Array(resp);
		} else {
			var t = "";
			try { t = xhr.responseText || ""; } catch (e4) { t = ""; }
			bytes = new Uint8Array(t.length);
			for (var i = 0; i < t.length; i++) bytes[i] = t.charCodeAt(i) & 0xff;
		}

		if (binaryMode === null) {
			binaryMode = (resp && resp.byteLength) ? "arraybuffer" : "latin1-text";
			log("binary read mode: " + binaryMode);
		}

		// If the server ignored Range and sent the whole file, slice locally so
		// callers still get what they asked for.
		if (from !== null && xhr.status === 200 && bytes.length > (to - from + 1)) {
			bytes = bytes.subarray(from, to + 1);
		}
		cb(null, bytes);
	};
	xhr.onerror = function () { cb(new Error("network error")); };
	xhr.ontimeout = function () { cb(new Error("timeout")); };

	try { xhr.send(); } catch (e2) { cb(e2); }
}

// No token here — pass cfg.token to getRange instead (F-021).
function timelineUrl(cfg) {
	return cfg.server + "/library/parts/" + cfg.timelineRef + "/indexes/sd";
}

if (typeof module !== "undefined") {
	module.exports = {
		getRange: getRange,
		timelineUrl: timelineUrl,
		isRangeSupported: function () { return rangeSupported; }
	};
}
