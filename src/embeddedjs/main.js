// BIF Watchface — Alloy / Pebble Time 2 (emery).
//
// Wiring only — the work lives in face/scenes/triggers/proto.
//
// ORDER MATTERS HERE. The XS machine and the C-side services share the app's
// ~122.5 KB heap, and it is tight enough that whoever allocates last loses:
// creating the Battery sensor before AppMessage made app_message_open() fail,
// which throws out of the Message constructor and kills the watchface with no
// error on screen. So set things up in order of how essential they are —
// transport, then input, then the optional sensors.

import Accelerometer from "embedded:sensor/Accelerometer";
import Battery from "embedded:sensor/Battery";
import * as face from "face";
import * as scenes from "scenes";
import * as triggers from "triggers";
import * as proto from "proto";
import { RING_SIZE } from "config";

let advances = 0;

// Below this, stop pulling new frames. Advancing text within an already-buffered
// scene still works and costs nothing, so the face degrades to "subtitles over a
// held frame" rather than going dead.
const LOW_BATTERY_PCT = 20;
let battery = null;
let batteryPct = 100;

function readBattery() {
	if (!battery) return batteryPct;
	try { batteryPct = battery.sample().percent; } catch (e) { /* keep last */ }
	return batteryPct;
}
function lowPower() { return battery ? readBattery() < LOW_BATTERY_PCT : false; }
function connected() {
	try { return !!(watch.connected && watch.connected.app); } catch (e) { return false; }
}

function updateStatus() {
	const c = scenes.current();
	const where = c ? `${c.idx}:${c.cueNum}/${c.cueCount}` : "-";
	// Say why the face is standing still, rather than just looking frozen.
	let flag = "";
	if (!connected()) flag = " [offline]";
	else if (lowPower()) flag = " [low pwr]";
	// Plain concatenation of short pieces; see fire() on why this path avoids
	// building more strings than it must.
	face.setStatus(where + "  adv " + advances + flag);
}

// ------------------------------------------------------------------- wiring
scenes.init({
	onChange() {
		advances++;
		face.draw();
	},
	onNeedScenes(fromIdx, count) {
		if (lowPower()) {
			trace(`refill ${fromIdx} suppressed: battery ${batteryPct}%\n`);
			return;
		}
		if (!connected()) {
			// Not an error — the retry happens on the "connected" event below.
			trace(`refill ${fromIdx} suppressed: phone disconnected\n`);
			return;
		}
		if (!proto.requestScenes(fromIdx, count)) {
			// proto coalesces the request and replays it once writable.
			trace(`refill ${fromIdx} x${count} deferred\n`);
		}
	},
});

proto.init({
	onScene(scene) {
		const wasEmpty = scenes.freeSlots() === RING_SIZE;
		const took = scenes.push(scene);
		trace(`scene ${scene.idx} ${took ? "accepted" : "REJECTED (ring full)"}\n`);
		updateStatus();
		// Only redraw when this scene is the one on screen. Redrawing on every
		// arrival re-expands seven strips while the next scene's chunks are still
		// streaming, and a busy watch drops them — that produced
		// "chunk 1 without a start" mid-refill.
		if (wasEmpty && took) face.draw();
	},
	onState(s) {
		trace(`proto: ${s}\n`);
		updateStatus();
	},
});

// FIRST: the transport. app_message_open() needs C heap and must win it.
proto.start();

// SECOND: input.
triggers.registerTouch();
triggers.registerAccelTap(Accelerometer);
const started = triggers.startAll(fire);
trace(`triggers started: ${started.join(",") || "NONE"}\n`);

// LAST: optional sensors. If there is no memory left for these, the watchface
// still works — lowPower() just reports false and no refill is ever suppressed.
try {
	battery = new Battery({});
	batteryPct = battery.sample().percent;
	trace(`battery ${batteryPct}%\n`);
} catch (e) {
	trace(`battery unavailable (${e}); power guard disabled\n`);
}

// Every trigger funnels through scenes.advance(), which owns the rate limit — so
// a source added later cannot bypass it.
function fire(reason) {
	// No template literal here: fire() runs on every tap and each interpolated
	// string is slot-heap garbage. The slot heap is the one that aborts.
	const moved = scenes.advance(reason);
	trace(moved ? "advance\n" : "advance ignored\n");
	updateStatus();
	face.draw();
}

// Prime the ring; resumes at the persisted position rather than restarting the
// episode.
scenes.maybeRefill();
updateStatus();

// minutechange fires immediately on registration, so this is also the initial
// draw. After that use the clipped time-band redraw: the frame has not changed,
// and a full redraw would re-expand the picture once a minute for nothing.
let drawnOnce = false;
watch.addEventListener("minutechange", e => {
	if (drawnOnce) face.drawTime(e.date);
	else { face.draw(e.date); drawnOnce = true; }
});

// Connection state is not guaranteed to fire on registration; read it directly.
trace(`phone connected: ${connected()}, resuming at scene ${scenes.resumeAt()}\n`);
watch.addEventListener("connected", () => {
	trace(`connection changed: ${connected()}\n`);
	// Refills suppressed while disconnected are retried here — otherwise a
	// watchface that started out of range would never recover.
	if (connected()) scenes.maybeRefill();
	updateStatus();
	face.draw();
});

// Timeline Quick View changes the drawable area; the layout reads unobstructed
// bounds, so it just needs a redraw.
watch.addEventListener("resize", () => face.draw());
