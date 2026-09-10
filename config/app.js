// Config page for the BIF watchface.
//
// Runs in the Pebble app's config webview — a real browser, unlike PKJS — so
// fetch and modern JS are fine here. It does auth and browsing only; the frames
// are fetched and decoded by PKJS, because this page's storage is a different
// origin and cannot hand anything over. The only channel out is the return URL,
// so the payload has to stay small: server, token, ids.
//
// Two ways in: Plex PIN sign-in (auth.js) or a pasted token. The PIN flow is
// awkward inside a webview — authorising means leaving for plex.tv, and a
// backgrounded webview may freeze its timers — so it never depends on polling
// alone: the PIN is persisted and resumed, and there is an explicit
// "I've authorised it" button. Manual token entry stays as the escape hatch.

(function () {
	"use strict";

	var $ = function (id) { return document.getElementById(id); };
	var state = { server: "", token: "", sections: [], servers: [], items: [], chosen: null };

	function setStatus(el, msg, kind) {
		var e = $(el);
		e.textContent = msg || "";
		e.className = "status" + (kind ? " " + kind : "");
	}

	function show(id, yes) { $(id).classList.toggle("hide", !yes); }

	// Token as a header, not a query parameter (F-021). Plex answers the CORS
	// preflight with `access-control-allow-headers: x-plex-token`, verified
	// against a real server from both a dev origin and the Pages origin.
	function api(path) {
		var url = state.server.replace(/\/$/, "") + path;
		return fetch(url, {
			headers: { Accept: "application/json", "X-Plex-Token": state.token }
		})
			.then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
	}

	// ------------------------------------------------------------- sign-in
	var pollTimer = null;

	function stopPolling() {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	}

	function showPin(pin) {
		$("pin-code").textContent = pin.code;
		$("pin-link").href = PlexAuth.linkUrl(pin.code);
		show("pin-idle", false);
		show("pin-active", true);
		setStatus("auth-status", "Waiting for you to authorise…");

		// Poll, but never rely on it: a backgrounded webview may freeze timers,
		// which is what the "I've authorised it" button is for.
		stopPolling();
		pollTimer = setInterval(function () { pollOnce(pin, true); }, 3000);
	}

	function resetSignIn(msg, kind) {
		stopPolling();
		show("pin-active", false);
		show("pin-idle", true);
		setStatus("auth-status", msg || "", kind);
	}

	function pollOnce(pin, quiet) {
		return PlexAuth.checkPin(pin.id).then(function (token) {
			if (!token) {
				if (!quiet) setStatus("auth-status", "Not authorised yet — try again in a moment.");
				return false;
			}
			stopPolling();
			state.token = token;
			setStatus("auth-status", "Signed in.", "ok");
			show("pin-active", false);
			show("pin-idle", true);
			listServers();
			return true;
		}).catch(function (e) {
			if (e.message === "expired") {
				resetSignIn("That code expired. Start again.", "err");
			} else if (!quiet) {
				setStatus("auth-status", "Check failed: " + e.message, "err");
			}
			return false;
		});
	}

	$("signin").addEventListener("click", function () {
		setStatus("auth-status", "Getting a code…");
		PlexAuth.createPin().then(showPin).catch(function (e) {
			setStatus("auth-status", e.message, "err");
		});
	});

	$("pin-check").addEventListener("click", function () {
		var pin = PlexAuth.resumablePin();
		if (!pin) { resetSignIn("That code is no longer valid. Start again.", "err"); return; }
		setStatus("auth-status", "Checking…");
		pollOnce(pin, false);
	});

	$("pin-cancel").addEventListener("click", function () {
		PlexAuth.clearPin();
		resetSignIn("");
	});

	// If the webview was reloaded mid-flow, pick the same PIN back up rather
	// than stranding the user on a code that is no longer being polled.
	var resumable = PlexAuth.resumablePin();
	if (resumable) {
		showPin(resumable);
		setStatus("auth-status", "Resumed — waiting for you to authorise…");
	}

	// ------------------------------------------------------------- servers
	function listServers() {
		setStatus("server-status", "Finding your servers…");
		show("card-server", true);
		PlexAuth.resources(state.token).then(function (servers) {
			if (!servers.length) throw new Error("no servers on this account");
			state.servers = servers;
			var sel = $("server-pick");
			sel.innerHTML = "";
			servers.forEach(function (s, i) {
				var o = document.createElement("option");
				o.value = String(i);
				o.textContent = s.name + (s.owned ? "" : " (shared)");
				sel.appendChild(o);
			});
			setStatus("server-status", servers.length + " server(s). Pick one and continue.");
		}).catch(function (e) {
			setStatus("server-status", e.message, "err");
		});
	}

	$("use-server").addEventListener("click", function () {
		var s = state.servers && state.servers[parseInt($("server-pick").value, 10)];
		if (!s) return;
		setStatus("server-status", "Finding a reachable address…");
		// Plex advertises addresses that often are not reachable from where the
		// phone actually is, so each is probed rather than trusted.
		PlexAuth.probe(s, state.token, function (uri, i, n) {
			setStatus("server-status", "Trying " + i + " of " + n + "…");
		}).then(function (uri) {
			if (!uri) {
				setStatus("server-status",
					"None of its addresses answered. Is the phone on the same network?", "err");
				return;
			}
			state.server = uri;
			$("server").value = uri;
			$("token").value = state.token;
			try { localStorage.setItem("bif.cfg", JSON.stringify({ s: uri, t: state.token })); }
			catch (e) { /* ignore */ }
			setStatus("server-status", "Connected to " + uri, "ok");
			loadSections();
		});
	});

	// ------------------------------------------------------------ connect
	$("connect").addEventListener("click", function () {
		state.server = $("server").value.trim();
		state.token = $("token").value.trim();
		if (!state.server || !state.token) {
			setStatus("auth-status", "Server address and token are both required.", "err");
			return;
		}
		try { localStorage.setItem("bif.cfg", JSON.stringify({ s: state.server, t: state.token })); }
		catch (e) { /* private mode */ }
		setStatus("auth-status", "Connecting…");
		loadSections();
	});

	// Shared by both routes in: PIN sign-in and manual token entry.
	function loadSections() {
		api("/library/sections").then(function (d) {
			var dirs = (d.MediaContainer && d.MediaContainer.Directory) || [];
			state.sections = dirs.filter(function (s) {
				return s.type === "show" || s.type === "movie";
			});
			if (!state.sections.length) throw new Error("no movie or TV libraries");

			var sel = $("section");
			sel.innerHTML = "";
			state.sections.forEach(function (s) {
				var o = document.createElement("option");
				o.value = s.key;
				o.textContent = s.title + "  (" + s.type + ")";
				sel.appendChild(o);
			});
			setStatus("auth-status", "Connected.", "ok");
			show("card-lib", true);
			onSectionChange();
		}).catch(function (e) {
			setStatus("auth-status",
				"Could not reach the server: " + e.message +
				". Check the address is reachable from this phone.", "err");
		});
	}

	function currentSection() {
		var key = $("section").value;
		for (var i = 0; i < state.sections.length; i++) {
			if (String(state.sections[i].key) === String(key)) return state.sections[i];
		}
		return null;
	}

	function onSectionChange() {
		var sec = currentSection();
		var isShow = sec && sec.type === "show";
		show("show-wrap", isShow);
		if (!isShow) return;

		setStatus("lib-status", "Loading shows…");
		api("/library/sections/" + sec.key + "/all").then(function (d) {
			var items = (d.MediaContainer && d.MediaContainer.Metadata) || [];
			var sel = $("show");
			sel.innerHTML = "";
			items.forEach(function (it) {
				var o = document.createElement("option");
				o.value = it.ratingKey;
				o.textContent = it.title;
				sel.appendChild(o);
			});
			setStatus("lib-status", items.length + " shows.");
		}).catch(function (e) {
			setStatus("lib-status", "Failed: " + e.message, "err");
		});
	}
	$("section").addEventListener("change", onSectionChange);

	// ------------------------------------------------------------- browse
	// Eligibility is checked LAZILY, one item at a time as the list is built.
	// trickplayer-g2 fetched full metadata for every item in the library up
	// front, in batches of 20 — far too slow on a phone, and most of it wasted.
	$("browse").addEventListener("click", function () {
		var sec = currentSection();
		if (!sec) return;
		var path = sec.type === "show"
			? "/library/metadata/" + $("show").value + "/allLeaves"
			: "/library/sections/" + sec.key + "/all";

		setStatus("lib-status", "Loading…");
		$("items").innerHTML = "";
		show("card-items", true);

		api(path).then(function (d) {
			var items = (d.MediaContainer && d.MediaContainer.Metadata) || [];
			setStatus("lib-status", items.length + " items; checking which are usable…");
			state.items = items;
			checkNext(items, 0, 0);
		}).catch(function (e) {
			setStatus("lib-status", "Failed: " + e.message, "err");
		});
	});

	// An item is usable only if it has BOTH a "sd" BIF index and a subtitle
	// stream with a non-null key. Most SRT streams on a Plex item are EMBEDDED
	// (key: null) and cannot be fetched separately — only sidecars can, so
	// filtering on codec alone would offer episodes that then show no dialogue.
	function usableStreams(meta) {
		var out = null;
		(meta.Media || []).forEach(function (m) {
			(m.Part || []).forEach(function (p) {
				var hasBif = p.indexes && String(p.indexes).indexOf("sd") !== -1;
				if (!hasBif) return;
				var sub = null;
				(p.Stream || []).forEach(function (st) {
					if (st.streamType === 3 && st.codec === "srt" && st.key && !sub) sub = st;
				});
				if (sub && !out) out = { timelineRef: p.id, subtitleRef: sub.key, subLang: sub.language || "" };
			});
		});
		return out;
	}

	function checkNext(items, i, found) {
		if (i >= items.length) {
			setStatus("item-status", found
				? found + " usable item(s). Pick one."
				: "None of these have both a trick-play index and an external subtitle file.",
				found ? "ok" : "err");
			return;
		}
		setStatus("lib-status", "Checking " + (i + 1) + " of " + items.length + "…");

		api("/library/metadata/" + items[i].ratingKey).then(function (d) {
			var meta = d.MediaContainer && d.MediaContainer.Metadata && d.MediaContainer.Metadata[0];
			var ok = meta ? usableStreams(meta) : null;
			if (ok) {
				found++;
				addItem(meta, ok);
			}
			checkNext(items, i + 1, found);
		}).catch(function () {
			checkNext(items, i + 1, found);
		});
	}

	function titleOf(meta) {
		if (meta.type === "episode") {
			var s = String(meta.parentIndex || 0);
			var e = String(meta.index || 0);
			if (s.length < 2) s = "0" + s;
			if (e.length < 2) e = "0" + e;
			return (meta.grandparentTitle || "") + " S" + s + "E" + e + " — " + meta.title;
		}
		return meta.title;
	}

	function addItem(meta, streams) {
		var li = document.createElement("li");
		li.innerHTML = "";
		li.appendChild(document.createTextNode(titleOf(meta)));
		var m = document.createElement("span");
		m.className = "meta";
		m.textContent = "subtitles: " + (streams.subLang || "unknown") +
			" · part " + streams.timelineRef;
		li.appendChild(m);

		li.addEventListener("click", function () {
			var all = $("items").querySelectorAll("li");
			for (var i = 0; i < all.length; i++) all[i].classList.remove("sel");
			li.classList.add("sel");
			state.chosen = {
				timelineRef: streams.timelineRef,
				subtitleRef: streams.subtitleRef,
				title: titleOf(meta),
				durMs: meta.duration || 0
			};
			$("save").disabled = false;
			show("card-opts", true);
			setStatus("item-status", "Selected: " + state.chosen.title, "ok");
		});
		$("items").appendChild(li);
	}

	// --------------------------------------------------------------- save
	function returnTo() {
		var q = location.search.substring(1).split("&");
		for (var i = 0; i < q.length; i++) {
			var kv = q[i].split("=");
			if (kv[0] === "return_to") return decodeURIComponent(kv[1]);
		}
		return "pebblejs://close#";
	}

	$("save").addEventListener("click", function () {
		if (!state.chosen) return;
		// Small on purpose: this travels as a URL fragment. Frames never come
		// through here — PKJS fetches them itself.
		var payload = {
			v: 1,
			server: state.server.replace(/\/$/, ""),
			token: state.token,
			timelineRef: state.chosen.timelineRef,
			subtitleRef: state.chosen.subtitleRef,
			title: state.chosen.title,
			durMs: state.chosen.durMs,
			opts: {
				intervalMs: parseInt($("interval").value, 10),
				skipSilent: $("skip").value === "1"
			}
		};
		document.location = returnTo() + encodeURIComponent(JSON.stringify(payload));
	});

	// Restore server/token so reconfiguring does not mean re-pasting.
	try {
		var saved = JSON.parse(localStorage.getItem("bif.cfg") || "null");
		if (saved) { $("server").value = saved.s || ""; $("token").value = saved.t || ""; }
	} catch (e) { /* ignore */ }
})();
