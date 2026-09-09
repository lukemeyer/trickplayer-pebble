// Trigger registry — the extension point.
//
// A source never calls advance() logic directly; it calls the `fire` callback it
// was handed. That keeps rate limiting, buffer accounting and redraw in one
// place (scenes.advance), so adding a source later cannot get any of it wrong.
//
// A source is { name, available(), start(fire), stop() }.
//
// v1 registers touch and accel-tap. Touch is the intended input on emery, but
// there is no `pebble emu-touch`, so its delivery is unverifiable in QEMU;
// accel-tap is confirmed working in a watchface and IS emulator-testable via
// `pebble emu-tap --direction y+`. Registering both keeps development testable
// and gives a fallback if touch turns out not to reach watchfaces on hardware.

const sources = [];

export function register(source) {
	sources.push(source);
}

export function startAll(fire) {
	const started = [];
	for (const s of sources) {
		let ok = false;
		try {
			ok = !!s.available();
		} catch (e) {
			trace(`trigger ${s.name}: available() threw ${e}\n`);
		}
		if (!ok) {
			trace(`trigger ${s.name}: unavailable\n`);
			continue;
		}
		try {
			s.start(fire);
			started.push(s.name);
		} catch (e) {
			// A source that fails to start must never take the watchface with it.
			trace(`trigger ${s.name}: start() failed ${e}\n`);
		}
	}
	return started;
}

export function stopAll() {
	for (const s of sources) {
		try { s.stop && s.stop(); } catch (e) { /* ignore */ }
	}
}

// ------------------------------------------------------------------ sources

// Touch is OFF by default: confirmed on a Pebble Time 2 that touch events do
// not reach a watchface. device.sensor.Touch is present and constructs happily,
// so nothing fails — the taps simply never arrive. (The C TouchService docs
// suggest watchfaces should get them; Core Devices' own skill says watchface
// input is "accelerometer tap only", and hardware agrees with the skill.)
//
// Leaving it subscribed is not free: with both sensors up, the C side logs
// "accel_service.c: Not enough memory to subscribe", so a dead sensor was
// competing for memory that AppMessage and the accelerometer need.
//
// Kept registered rather than deleted so it can be switched back on in one line
// if a firmware update changes this.
const TOUCH_ENABLED = false;

export function registerTouch() {
	register({
		name: "touch",
		// Feature-detect rather than assume: touch exists on emery/gabbro only.
		available: () => TOUCH_ENABLED &&
			!!(globalThis.device && device.sensor && device.sensor.Touch),
		start(fire) {
			this.t = new device.sensor.Touch({
				onSample() {
					const s = this.sample();
					// sample() returns an array of points, or something falsy
					// between contacts. Only a real contact counts.
					if (s && s.length) fire("touch");
				},
			});
		},
		stop() { this.t && this.t.close && this.t.close(); },
	});
}

export function registerAccelTap(Accelerometer) {
	register({
		name: "accel-tap",
		available: () => !!Accelerometer,
		start(fire) {
			this.a = new Accelerometer({
				onTap(dir) { fire("tap:" + dir); },
			});
		},
		stop() { this.a && this.a.close && this.a.close(); },
	});
}

// Future sources drop in here without touching advance():
//   - "minutechange": a plays-by-itself mode, trivial to add.
//   - "backlight": the ideal trigger (fires exactly when someone looks), but
//     Alloy exposes no backlight event and its declarative FFI has no
//     function-pointer type, so it needs fxBuildFFI host bindings. Deferred.
//   - "button": watchapps only; a watchface never receives button events.
