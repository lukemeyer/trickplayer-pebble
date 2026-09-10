// Plex PIN sign-in.
//
// The flow: POST a PIN, show the user a short code, they authorise it at
// plex.tv on any device, we poll until a token comes back, then list their
// servers via /resources and pick a reachable connection.
//
// The awkward part is that this runs in the Pebble app's config *webview*.
// Authorising means going to plex.tv, which navigates away from us, and a
// backgrounded webview may stop timers — so polling alone is not reliable.
// Three defences:
//
//   1. The PIN is persisted, so if the webview is reloaded or restored we resume
//      polling the same PIN instead of stranding the user on a dead code.
//   2. There is an explicit "I've authorised it" button; the user is never
//      dependent on a timer having survived.
//   3. The code is short, so it can be redeemed on a completely different
//      device and this webview never has to move at all.
//
// PINs expire (plex.tv gives ~15 minutes), so an expired one is detected and
// replaced rather than polled forever.

(function (global) {
	"use strict";

	var PRODUCT = "BIF Watchface";
	var PIN_KEY = "bif.pin";
	var CID_KEY = "bif.clientId";

	// Plex ties the token to the client identifier, so it must be stable across
	// reloads — a fresh one each time would invalidate the PIN mid-flow.
	function clientId() {
		var id = null;
		try { id = localStorage.getItem(CID_KEY); } catch (e) { /* private mode */ }
		if (!id) {
			id = "bif-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
			try { localStorage.setItem(CID_KEY, id); } catch (e2) { /* ignore */ }
		}
		return id;
	}

	function headers() {
		return {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Plex-Product": PRODUCT,
			"X-Plex-Version": "1.0",
			"X-Plex-Client-Identifier": clientId(),
			"X-Plex-Device": "Pebble",
			"X-Plex-Platform": "Web"
		};
	}

	function savePin(p) {
		try { localStorage.setItem(PIN_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
	}
	function loadPin() {
		try { return JSON.parse(localStorage.getItem(PIN_KEY) || "null"); }
		catch (e) { return null; }
	}
	function clearPin() {
		try { localStorage.removeItem(PIN_KEY); } catch (e) { /* ignore */ }
	}

	// Resolve a PIN we already have, if it is still fresh. Saves the user
	// re-authorising when the webview reloads mid-flow.
	function resumablePin() {
		var p = loadPin();
		if (!p || !p.id || !p.code) return null;
		// plex.tv expires PINs at ~15 min; be conservative.
		if (Date.now() - (p.at || 0) > 13 * 60 * 1000) { clearPin(); return null; }
		return p;
	}

	function createPin() {
		// strong:false deliberately. A "strong" PIN returns a 25-character code
		// intended for the app.plex.tv/auth deep link; short codes are the ones
		// plex.tv/link accepts by typing.
		//
		// That matters more here than the extra entropy: a short code can be
		// entered on a DIFFERENT device — a laptop, the TV app — which sidesteps
		// the whole problem of navigating a config webview away to plex.tv and
		// hoping it comes back with its timers intact. See linkUrl(): the code
		// type and the redemption URL have to agree.
		return fetch("https://plex.tv/api/v2/pins", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ strong: false })
		}).then(function (r) {
			if (!r.ok) throw new Error("could not start sign-in (HTTP " + r.status + ")");
			return r.json();
		}).then(function (d) {
			var p = { id: d.id, code: d.code, at: Date.now() };
			savePin(p);
			return p;
		});
	}

	// A SHORT pin (strong:false) is redeemed at plex.tv/link by typing the code.
	//
	// It is NOT valid at app.plex.tv/auth#?code=... — that deep link expects a
	// STRONG pin's 25-character code, and handing it a short one makes Plex
	// answer "unable to authorize this request" after you sign in. One PIN
	// cannot serve both flows, so the link has to match the PIN type.
	//
	// ?pin= prefills the field; the code is displayed anyway so it can be typed
	// on any other device.
	function linkUrl(code) {
		return "https://plex.tv/link?pin=" + encodeURIComponent(code);
	}

	// Resolves to a token, or null if not authorised yet. Throws if the PIN is
	// gone — 404 means expired or consumed, and the caller should start over.
	function checkPin(id) {
		return fetch("https://plex.tv/api/v2/pins/" + id, { headers: headers() })
			.then(function (r) {
				if (r.status === 404) { clearPin(); throw new Error("expired"); }
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			})
			.then(function (d) {
				if (d.authToken) { clearPin(); return d.authToken; }
				return null;
			});
	}

	// List servers, newest-looking connection first.
	function resources(token) {
		return fetch("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", {
			headers: {
				Accept: "application/json",
				"X-Plex-Token": token,
				"X-Plex-Client-Identifier": clientId()
			}
		}).then(function (r) {
			if (!r.ok) throw new Error("could not list servers (HTTP " + r.status + ")");
			return r.json();
		}).then(function (d) {
			var devices = Array.isArray(d) ? d :
				(d.MediaContainer && d.MediaContainer.Device) || d.Device || [];
			if (!Array.isArray(devices)) devices = [devices];
			return devices.filter(function (dev) {
				return String(dev.provides || "").split(",").map(function (x) {
					return x.trim().toLowerCase();
				}).indexOf("server") !== -1;
			});
		});
	}

	// Order connections by how likely they are to be fast and to work from a
	// phone on the same network: local first, then direct https, relay last —
	// relay is Plex's proxy, works anywhere but is slow, and we pull ~13 KB per
	// scene through it.
	function rankConnections(server) {
		var conns = server.connections || server.Connection || [];
		if (!Array.isArray(conns)) conns = [conns];
		return conns.slice().sort(function (a, b) {
			function score(c) {
				var s = 0;
				if (c.relay) s += 100;
				if (c.local) s -= 10;
				if (String(c.uri || "").indexOf("https") === 0) s -= 1;
				return s;
			}
			return score(a) - score(b);
		});
	}

	// Race every connection at once, rather than trying them in order.
	//
	// plex.tv advertises several routes per server — a LAN address, a public
	// one, usually a relay — and which of them works depends entirely on where
	// you are. Probing in order means waiting out each dead route's timeout
	// before the next is even attempted, and a LAN address that no longer
	// resolves is the common case the moment you leave the house.
	//
	// Ranking BREAKS TIES; it does not decide. Everything that answers inside
	// the window is collected, then preferred local -> direct -> relay, and only
	// then by speed. Taking the literal first responder would sometimes pick a
	// relay over a LAN address twenty milliseconds behind it, and Plex relays
	// are bandwidth-limited — which matters when every scene is a fetch.
	//
	// See trickplayer-knowledge findings/F-016.
	var PROBE_TIMEOUT_MS = 8000;

	// How long to keep waiting for a BETTER-ranked route once some route has
	// answered. This is the part that makes racing actually pay.
	//
	// Waiting for every probe to settle before choosing sounds right and is
	// useless: a route that black-holes packets — a LAN address that plex.tv
	// still advertises after you have left the house — never fails fast, it
	// times out. Wait for it and the race costs the full timeout, exactly like
	// probing in order. Measured against a real server with one dead route
	// ahead of a live one:
	//
	//     serial                    8022 ms
	//     raced, wait for all       8001 ms   <- no gain whatsoever
	//     raced + this grace window  411 ms   <- 19.5x, same route chosen
	//
	// So: as soon as anything answers, only better-ranked routes are still
	// worth waiting for, and only briefly.
	var RANK_GRACE_MS = 400;

	// fetch() has no timeout of its own, and a route that black-holes packets
	// would otherwise hang until the browser gives up — long past the point the
	// user has concluded the app is broken.
	function probeOne(uri, token, timeoutMs) {
		return new Promise(function (resolve) {
			var settled = false;
			function done(ok) {
				if (settled) return;
				settled = true;
				resolve(ok);
			}
			var timer = setTimeout(function () { done(false); }, timeoutMs);
			fetch(uri + "/identity", {
				headers: { Accept: "application/json", "X-Plex-Token": token }
			}).then(function (r) {
				clearTimeout(timer);
				done(!!r.ok);
			}).catch(function () {
				clearTimeout(timer);
				done(false);
			});
		});
	}

	function probe(server, token, onProgress, timeoutMs) {
		var conns = rankConnections(server);
		if (!conns.length) return Promise.resolve(null);
		timeoutMs = timeoutMs || PROBE_TIMEOUT_MS;

		if (onProgress) onProgress(null, 0, conns.length);

		var started = Date.now();
		var best = null;          // { uri, rank, ms }
		var answered = 0;
		var settled = 0;
		var finished = false;

		return new Promise(function (resolve) {
			var overall = null;
			var grace = null;

			function finish() {
				if (finished) return;
				finished = true;
				if (overall) clearTimeout(overall);
				if (grace) clearTimeout(grace);
				resolve(best ? best.uri : null);
			}

			function consider() {
				if (!best) return;
				// Rank 0 is decisive — nothing still in flight can beat it.
				if (best.rank === 0) { finish(); return; }
				// Otherwise give better-ranked routes a brief chance, once.
				if (grace === null) grace = setTimeout(finish, RANK_GRACE_MS);
			}

			overall = setTimeout(finish, timeoutMs);

			conns.forEach(function (c, rank) {
				probeOne(c.uri, token, timeoutMs).then(function (ok) {
					settled++;
					if (ok) {
						answered++;
						// Prefer by rank, then by speed.
						var ms = Date.now() - started;
						if (!best || rank < best.rank ||
							(rank === best.rank && ms < best.ms)) {
							best = { uri: c.uri, rank: rank, ms: ms };
						}
						if (onProgress) onProgress(c.uri, answered, conns.length);
						consider();
					}
					if (settled === conns.length) finish();
				});
			});
		});
	}

	global.PlexAuth = {
		clientId: clientId,
		createPin: createPin,
		resumablePin: resumablePin,
		clearPin: clearPin,
		checkPin: checkPin,
		linkUrl: linkUrl,
		resources: resources,
		probe: probe
	};
})(window);
