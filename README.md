# BIF Watchface (Pebble Time 2 / emery)

A Pebble watchface that shows a frame from a Plex BIF trick-play index plus the
subtitles from that moment, advancing through an episode as you interact with it.
Configuration (Plex auth, browsing, episode selection) happens on the phone.

Watch side is **Alloy** (Moddable XS JS). Phone side is **PebbleKit JS** — it does
the fetching, JPEG decode, palette selection and dithering, and sends the watch
display-ready bytes. The watch never fetches, by design: raw JPEG would cost
~8-15 KB/frame over BLE against 11,200 B for a pre-dithered palettised frame.

## Status

| Phase | State |
|---|---|
| 0 — spikes | **done** (watch side). See [spikes/PHASE0-FINDINGS.md](spikes/PHASE0-FINDINGS.md) |
| 1 — watch skeleton | **done** — layout, clock, scene ring, trigger registry |
| 2 — protocol | **done** — chunked AppMessage transport, verified end to end |
| 3 — config page | **built, not deployed** — Plex PIN sign-in, browse, select |
| 4 — content pipeline | **done** — frames and subtitles, against a real server |
| 5 — cache & policy | **done** — LRU cache, prefetch, resume, power/offline guards |
| 6 — enhancements | not started |

**Running on real hardware** (Pebble Time 2 + Pixel 10 Pro Fold over `--adb`):
real frames and synced subtitles, cached and prefetched, advancing on tap.
Outstanding: hosting the config page, Plex PIN sign-in, and a battery-life trial.

## Layout

```
src/c/mdbl.c              Alloy entry point — ONLY non-stock part is XS heap sizing
src/embeddedjs/
  main.js                 wiring only
  config.js               measured constants and tuning knobs
  face.js                 Poco drawing: frame / subtitle / time bands
  scenes.js               ring buffer, cursor, the single advance() path
  triggers.js             pluggable trigger registry
  proto.js                chunked scene transport (watch side)
src/pkjs/
  index.js                lifecycle, scene assembly, chunked sender
  plex.js                 ranged GETs, binary-read fallback
  bif.js                  BIF header/index parsing
  jpeg.js                 baseline JPEG decoder (no decoding exists in PKJS)
  render.js               downscale -> median cut -> dither -> 4bpp pack
  local-config.js         gitignored: dev Plex URL + token
spikes/                   Phase 0 probes, findings, and tools
```

`bif.js`, `jpeg.js` and `render.js` are written to run under both PKJS and Node,
so `spikes/tools/pipeline.js` exercises the exact shipping code against a real
server, and `spikes/tools/test_jpeg.js` validates the decoder against `sips`.

## Key facts (all measured — see PHASE0-FINDINGS.md)

- **Frames are 4-bit indexed + a per-frame 16-entry palette**, 11,200 B at
  200x112, expanded on-watch to ARGB2222. Visually indistinguishable from full
  64-colour at half the bytes.
- **`render.fillPattern()` is the only Poco path that accepts colour**
  (ARGB2222). `drawBitmap` rejects it. Passing an unsupported format trips
  `PBL_ASSERT` and **hard-crashes the VM** — not catchable from JS.
- **XS heap must be sized in `mdbl.c`.** The default holds about one frame, and
  a `creation` block in `src/embeddedjs/manifest.json` is silently ignored
  because our JS builds as a Moddable mod.
- **Font family and size must both be valid** or the VM dies at launch with a
  blank screen and nothing in the logs.

## Build and run

```bash
pebble build && pebble install --emulator emery --logs
```

Use `--logs` rather than a separate `pebble logs`: pypkjs holds the connection,
and a second client wedges the emulator (`libpebble2.exceptions.TimeoutError`).
If it wedges anyway: `pebble kill && pebble wipe`.

```bash
pebble emu-tap --direction y+          # fire the accel-tap trigger ("y+", not "+y")
pebble screenshot --no-open --emulator emery shots/x.png
```

There is no `pebble emu-touch` — touch cannot be exercised in the emulator at
all, which is why accel-tap is registered alongside it.

## Measured against real content

Test episode: Futurama S8E1, 24.5 min, 736 BIF frames.

| | |
|---|---|
| BIF file | 9.5 MB — far too big to cache whole, hence ranged fetches |
| BIF index | 5,960 B, fetched once |
| Native frame spacing | **2 s** — much finer than the ~10 s the design wants |
| Scene interval | 10 s (every 5th frame), independent of BIF spacing |
| Subtitles | 476 cues, 32 KB, parses in ~1 ms |
| **Cues per scene** | **avg 3.17** — so ~3 of 4 advances are text-only, no radio |
| Silent scenes | 14 of 150 (skipped) |
| Per scene on the phone | ~13 KB fetched, decode + encode 8-17 ms (pypkjs/V8) |
| On the wire | 11,216 B, vs 20,674 B for the raw JPEG |

The cue density is the number the whole design rests on: a scene spanning
several cues is what keeps the radio off for most glances.

## Config page

`config/` is a static page for the Pebble app's config webview. It connects to a
Plex server, lists libraries and shows, filters to usable items, and returns a
small JSON payload through the `pebblejs://close#` return URL. Frames never pass
through it — the webview is a separate origin from PKJS and cannot hand anything
over, so PKJS fetches them itself.

**Sign-in** (`config/auth.js`) issues a Plex PIN, shows a 4-character code, polls
until it is authorised, then lists servers and probes their advertised addresses
until one answers `/identity`.

The webview makes this harder than it looks — authorising means leaving for
plex.tv, and a backgrounded webview may freeze its timers — so it never relies on
polling alone:

- **`strong: false` on purpose.** A "strong" PIN returns a 25-character code for
  the deep-link flow; only short codes can be typed at plex.tv/link. The short
  code lets you authorise from a **different device**, which sidesteps navigating
  the webview away entirely. (The deep link is still offered.)
- **The PIN is persisted and resumed**, so a reload continues the same code
  instead of stranding you on a dead one. Expiry (~13 min) is detected.
- **An explicit "I've authorised it" button**, so nothing depends on a timer.
- **Manual token entry** remains, collapsed, as the escape hatch.

**It is still not hosted.** `CONFIG_URL` in `src/pkjs/index.js` points at
`https://lukemeyer.github.io/bif-watchface-pebble/config/`, which does not exist
yet. Publish `config/` to GitHub Pages (or anywhere https) and set the URL to
match. Locally: `python3 -m http.server 8791` in `config/`, then
`pebble emu-app-config --file config/index.html`.

Server addresses are ranked local → direct https → relay before probing: relay is
Plex's proxy, works anywhere but is slow, and we pull ~13 KB per scene.

**Eligibility is stricter than it looks.** An item is only usable if it has both
a `sd` BIF index and a subtitle stream with a **non-null `key`**. Most SRT
streams on a Plex item are embedded in the media file and cannot be fetched
separately; only sidecars can. On the test library that filter took Futurama from
157 episodes to 50. Checking is lazy, one item at a time (~15 s for 157 over a
LAN) — the original bulk-checked the whole library in batches of 20, which is far
worse on a phone.

## On-device results

Measured on a Pebble Time 2 with an Android phone — the figures that the
emulator could not give, since its PKJS is V8-based and flatters everything.

| | Emulator (pypkjs/V8) | **Real Android PKJS** |
|---|---|---|
| Binary XHR | `arraybuffer` | **`arraybuffer`** — fast path works, Latin-1 fallback unused |
| Decode + palette + dither | 8–17 ms | **44 / 110 / 212 ms** (min / median / max, n=10) |
| Scene delivery over BLE | instant | ~1–2 s per scene (11 chunks) |
| Range requests | supported | supported |
| Cache across restart | works | works (`cache holds 10 scenes`) |

Median 105 ms is roughly 8x the emulator, exactly as expected, and far below the
~500 ms that would have forced the phone side onto PebbleKit Android. **R2 and R3
are both closed.**

**Touch does not reach a watchface.** Confirmed on a Pebble Time 2: tapping the
screen does nothing. `device.sensor.Touch` is present and constructs without
error, so nothing fails — the events simply never arrive. The C `TouchService`
docs imply watchfaces should receive them; Core Devices' own skill says watchface
input is "accelerometer tap only", and the hardware agrees with the skill.

Touch is therefore disabled by default (`TOUCH_ENABLED` in `triggers.js`), left
registered so it can be switched back on in one line if firmware changes. The
accelerometer tap is the working trigger.

## The memory budget (read this before adding watch-side code)

The XS machine and the C-side services share the app's ~122.5 KB heap, and they
are a **zero-sum tug of war**. `mdbl.c` sizes the machine; whatever is left is
what AppMessage and the sensors get.

The failure mode is nasty and worth recognising: at `chunk = 69632` every module
loaded fine and then the app **restarted immediately at the first
`new Message()`**. `app_message_open()` had failed for want of C heap, and it
aborts hard — a `try`/`catch` around `proto.start()` catches nothing, and there is
no error on screen. `chunk = 57344` leaves the C side ~28 KB and fixes it.

Adding watch-side JS grows the mod, which erodes the same margin. If the app
starts relaunching after a change, suspect this before suspecting the change.

**The mod itself is resident in XS memory.** This is the part that bit hardest:
every module added grows `mc.xsa` (~17.5 KB now) and shrinks the same budget, so
settings that booted last week stop booting after a few hundred lines of JS. Both
heaps ran out in turn — first `# Slot allocation: failed in fixed size heap`,
then `# Chunk allocation: 16 bytes failed` — and the total cannot grow, because
that is the C heap AppMessage needs.

The way out was to **reduce demand, not reshuffle**: the frame went from 200x112
to **160x90**, which drops a resident scene from 14,400 to 9,760 bytes and the
wire cost from 11,200 to 7,200 (36% less radio per frame). Letterboxed 20px each
side; still 16:9.

Current split: stack 8192 / slot 36864 / chunk 49152 = 94,208, leaving ~28 KB for
the C side. `RING_SIZE` is 1.

**A warning worth heeding:** repeatedly installing builds that abort at startup
crash-looped a real watch badly enough that it factory-reset itself. If a build
aborts, revert and install a known-good one immediately rather than iterating on
the device.

## Known issues

- Removing the (non-functional) touch subscription did **not** free enough C heap
  to raise `XS_CHUNK` back to 69632 — that value still destabilises the app, so
  `RING_SIZE` stays at 2. Reverted; do not retry without watching for the
  relaunch-at-`new Message()` signature.
- `RING_SIZE` is 1, so there is a brief wait when a scene's cues run out and the
  next is fetched. The frame band is **not** repainted during that wait — the
  panel keeps the pixels it already has and only an hourglass badge is drawn over
  the corner, so the picture stays in full colour for nothing. Holding a copy to
  redraw would have cost 7,200 bytes of chunk that is not available. Depth 2 at 160x90 needs ~16,800 of chunk
  against ~18,000 available — plausible but unproven, and not worth risking the
  watch to find out. Try it only with a known-good build ready to reinstall.
- Frame is 160x90 rather than the panel's full 200 width. See the memory budget.
- `MIN_DWELL_MS` is 60s, so repeated manual taps are ignored while testing.
