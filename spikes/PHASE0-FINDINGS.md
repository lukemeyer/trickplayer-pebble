# Phase 0 findings — watch side (Alloy / Emery)

Measured on SDK 4.33.1, QEMU emery emulator. Probe source: `spikes/phase0-probe/`.

## R1 — Runtime bitmaps: **RESOLVED, YES. No FFI blit needed.**

The plan's blocker-class risk is closed, and better than hoped: **the wire format can be handed to Poco directly, with zero conversion on the watch.**

`commodetto/Bitmap` is importable and `new Bitmap(w, h, format, arrayBuffer, 0)` works at runtime. `render.drawBitmap()` then draws it.

**Critical constraint.** `PocoBitmapDraw` on Pebble (`commodettoPocoBlit-pebble.c`) accepts **only three** source formats and `PBL_ASSERT(false)`s on everything else. That assert **hard-crashes the VM and wedges the emulator** — it is *not* a catchable JS exception:

| `Bitmap.*` | Value | Row stride | 200×112 frame |
|---|---|---|---|
| `MonochromeAligned` | 21 | `((w+31)>>5)*4` = 28 B | **3,136 B** |
| `Gray4` | 24 | `(w+3)>>2` = 50 B | **5,600 B** |
| (`Pebble`) | 22 | native `GBitmap*` | n/a |

`Bitmap.Monochrome` (3) is **not** the same thing and will crash. `screen.pixelFormat` on emery is `21` (MonochromeAligned).

Verified visually (`phase0-probe/shots/r1-verified.png`): a gradient with vertical rules renders with the rules **vertical**, confirming stride handling is correct in both formats.

### Gray4 is an alpha ramp, not a grey ramp

The palette is `{0xC0, 0x80, 0x40, 0x00}` in **ARGB2222**, composited with `GCompOpSet`. Those are four *alpha* levels of black over whatever is already on screen:

- index **0** = `0xC0` = opaque black (darkest)
- index **3** = `0x00` = fully transparent (background shows through)

So index runs **dark → light**, and the destination must be filled first (we fill white, which yields four effective greys). My first mapping had it inverted and the screenshot caught it immediately.

MonochromeAligned uses `GCompOpAssign` and is straightforwardly opaque 1-bit.

## Colour — **works, and is the chosen v1 format**

Emery is a 64-colour panel, so this was tested before committing. Colour is reachable, but by exactly one route:

- `render.fillPattern()` → `PocoBitmapPattern`, which accepts **`ARGB2222` (23)**: 8bpp, `GBitmapFormat8Bit`, **stride == width** (no padding), `GCompOpAssign` (opaque).
- `render.drawBitmap()` → `PocoBitmapDraw` does **not** accept ARGB2222.
- `PocoDrawFrame` is a `PBL_CROAK("unexpected PocoDrawFrame")` stub — no compressed-frame path exists.

`ARGB2222` is not exposed as a `Bitmap.*` constant; use the literal `23`. Byte layout is Pebble `GColor8` = `AARRGGBB`, 2 bits each; opaque alpha is `0b11`, so `0xC0 | r<<4 | g<<2 | b`.

64 colours is coarse enough that gradients band badly, so **per-channel Floyd–Steinberg is required**, not optional.

Measured at the shipping 200×112 frame (`shots/color-compare.png`):

| Format | Bytes/frame | Scenes buffered | ~Bytes/day¹ |
|---|---|---|---|
| 1-bit MonochromeAligned | 3,136 | ~12 | 53 KB |
| Gray4 | 5,600 | ~8 | 95 KB |
| **ARGB2222 (chosen)** | **22,400** | **3–4** | **381 KB** |

¹ ~60 glances/day at ~3.5 subtitle cues per frame ≈ 17 new scenes.

**Accepted trade-off.** Colour costs ~7x the bytes, and the sharper cost is buffer depth: 3–4 scenes instead of ~8–12 means refilling roughly every 12 glances rather than every 40. This was raised explicitly and chosen deliberately — the target hardware is the colour model.

**The obvious lever if refills prove annoying** (not in v1): hold ring slots as **4-bit palettised** (11,200 B, per-frame palette chosen on the phone) and expand to ARGB2222 into a single reusable 22,400 B scratch buffer at draw time. That halves both the wire bytes and the ring footprint, doubling depth, and needs no FFI — just an expansion loop. For a single video still, 16 optimised colours is usually indistinguishable from 64 fixed ones.

## R5 — Plex `Range`: **RESOLVED, YES** (real server, real episode)

`HEAD` returns `Accept-Ranges: bytes`; `-r 0-63` returns `206 Partial Content` with a correct `Content-Range`. Ranged fetching works.

It is also **load-bearing, not an optimisation**: the test episode's BIF is **9,497,976 bytes**. Base64'd into PKJS `localStorage` that would be ~12.7 MB — never going to fit. Fetch the index, then fetch frames by byte range.

### Real BIF structure (24.5 min episode)

| | |
|---|---|
| File size | 9,497,976 B |
| Frame count | 736 |
| Index size | 5,960 B (`64 + 8*(count+1)`) — cheap to fetch and cache |
| **Frame spacing** | **2 seconds** |
| JPEG size | min 580 B, max 21,670 B, **avg 12,896 B** |
| JPEG dimensions | **320x180** — downscales cleanly to 200x112 |
| Sentinel entry | ts `0xFFFFFFFF`, offset = EOF. Confirmed present. |

Parser validated: `sum(frame sizes) + index == file size` exactly.

**Two things to get right:**

1. **`timestampMultiplier` (offset 16) is `0`, not 1000.** Per the BIF spec, 0 means "use the 1000 ms default". So it must be read as `mult = readU32(16) || 1000`. `trickplayer-g2`'s hardcoded `* 1000` is correct here only by luck, and naively *reading* the field — which the plan called for — yields all-zero timestamps and a broken cue→frame mapping.

2. **Frames are 2s apart, not the ~10s the plan assumed.** This matters: the whole "most advances stay inside the same frame, so send ~100 B of text" efficiency argument depends on several subtitle cues sharing a frame. At 2s spacing with ~3s cues, nearly every advance would cross into a new frame and the saving evaporates.

   **Fix: decouple the scene interval from the BIF's native spacing.** Pick a frame every N seconds of video (default ~10s, i.e. every 5th BIF frame) and group all cues in that window into one scene. Restores ~3.5 cues/scene. Finer native spacing is a bonus — it just means the chosen frame lands closer to the cue.

## Fonts are free; the baseline overhead is not

Measured by creating one font every 3s with instrumentation on:

| After | chunk used | slot used |
|---|---|---|
| baseline | 28,088 / 86,016 | 5,776 |
| + Gothic-Regular 18 | **28,088** | 11,600 |
| + Gothic-Regular 14 | **28,088** | 12,016 |
| + Bitham-Bold 42 | **28,088** | 12,432 |

**Pebble system fonts cost zero chunk** — they live in firmware ROM. Each costs only ~400 B of *slot*. Don't ration fonts.

The real constraint is the **~28 KB baseline chunk overhead** (Poco scratch and runtime), leaving **~58 KB usable** of the 86 KB.

**Consequence for the colour choice:** measured capacity is **3 colour frames maximum, 2 as a safe working number** — tighter than the 3–4 estimated when the format was chosen. Frames must share that ~58 KB with subtitle strings, message reassembly and headroom.

## 64-colour vs 16-colour palette, on a real frame

Tested with a real frame (#300) from the user's episode, both encodings rendered on the panel at the same size (`shots/compare-real.png`):

| | Bytes @200x112 | Scenes in ~58 KB | Verdict |
|---|---|---|---|
| ARGB2222, 64 fixed colours | 22,400 | 2–3 | baseline |
| **4-bit + per-frame 16 palette** | **11,200** (+16 B) | **~5** | **indistinguishable, arguably cleaner** |

The palette version is not visibly worse, and if anything looks less noisy: a palette fitted to the frame's own colours needs less error diffusion than approximating hues out of a fixed 64. Any single video still uses a narrow slice of the gamut, so 16 well-chosen entries go a long way.

**The on-watch expansion mechanism is proven.** `spikes/phase0-probe` decoded 11,200 B of 4-bit indices and expanded them to a 22,400 B ARGB2222 scratch buffer in JS, then drew via `fillPattern` — no FFI, no crash, at the full 200x112 (`shots/real-pal-200.png`). So the palette route needs only a median-cut step on the phone plus that expansion loop.

Palette generation is `spikes/tools/make_frame.py`. One wrinkle worth keeping: median cut must **over-split** (cut to 4n boxes, keep the first n distinct entries, largest boxes first). Cutting to exactly 16 leaves duplicates once entries are snapped into the 64-colour space — the first attempt yielded only 9 distinct colours.

## Mod string-literal size limit

Embedding a frame as a base64 string literal in an `embeddedjs` module: **7,468 chars loads fine; 29,868 chars faults the app at module load** (`App fault!`, PC 0, before any user code runs). There is a size ceiling somewhere between. Irrelevant to the shipping design — frames arrive over AppMessage — but it blocks embedding a full-size test frame in a probe. Work around it by splitting into an array of shorter literals and joining at runtime.

## R6 — XS heap: **RESOLVED, and it needs an explicit fix in `mdbl.c`**

The plan assumed the C build report's "Free RAM available (heap): 130,796 bytes". That is the **C** heap and is not what holds our buffers. The XS VM gets a fixed block, and the Pebble default (`build/devices/pebble/manifest.json`) is small:

```json
"creation": { "static": 32768, "chunk": { "initial": 8192 }, "heap": { "initial": 512 }, "stack": 384 }
```

8 KB of chunk space dies after **one** 3,136 B scene. Setting `creation` in the app's `src/embeddedjs/manifest.json` has **no effect** — our JS builds as a Moddable *mod*, so sizing comes from the machine `mdbl.c` creates.

The fix is `ModdableCreationRecord` in `src/c/mdbl.c`:

**Final config for this project** (app heap on emery is ~122,568 B total, and stack+slot+chunk is drawn from it):

```c
ModdableCreationRecord cr = {
  .recordSize = sizeof(cr),
  .stack = 8192, .slot = 20480, .chunk = 86016,   // 114,688 of ~122,568
};
moddable_createMachine(&cr);
```

Measured results:

| chunk | 3,136 B (1-bit) slots | 22,400 B (colour) slots |
|---|---|---|
| 8192 (default) | 1 | — |
| 32768 | 6 | — |
| 65536 | 17 (53,312 B) | 2 |
| **86016** | — | **3** (+16,680 B of probe bitmaps also held) |
| 94208 | no gain — total exceeds app heap and clamps | 3 |

So **86016 is the practical ceiling**. Without the probe's extra bitmaps the real app should hold **3–4 colour scenes**.

`slot` matters too and is easy to overlook: instrumentation showed slot at **15,792 / 16,368 — nearly full** with a 12-buffer ring, since every ArrayBuffer also consumes slots. Hence 20480 rather than 16384. Don't shrink slot to buy chunk.

**Gotchas, both undocumented:**
- Despite `//!< 0 for default` in `pebble.h`, a **zero in any of stack/slot/chunk makes the whole record invalid** ("invalid ModdableCreationRecord", VM never starts). Set all three explicitly.
- `.stack` is documented in bytes but behaves like the manifest's slot count — `.stack = 1024` gave `stack overflow (-3)` at launch. 8192 is fine.

## R7 — Triggers: touch **cannot be verified in the emulator**

- `device.sensor.Touch` **is present on emery and constructs fine inside a watchface** (`R7: Touch present=true`).
- But there is **no `pebble emu-touch` command** — the emulator cannot inject touchscreen events at all. (`emu-tap` is the *accelerometer*.) So touch *delivery* is unverifiable until hardware.

**Consequence for v1:** register accel-tap alongside touch from the start. Accelerometer tap is confirmed working in a watchface and *is* emulator-testable:

```
pebble emu-tap --direction y+     # note: "y+", not "+y"
```

gave `R7b: accel tap #1 dir="y+"`. This keeps Phases 1–2 fully testable without hardware, and is exactly what the trigger registry was designed for.

## Toolchain notes earned the hard way

- **Invalid font = white screen, no error.** `new render.Font("Gothic-14", 14)` is wrong — the family is `Gothic-Regular`, size `14`. A bad family/size combination kills the JS VM at launch with a blank screen and *nothing in the logs*. The skill documents this; I hit it anyway. Valid: Gothic-Regular/Bold 14/18/24/28, Bitham-Bold 42, Bitham-Black 30, Leco-Regular 20–42, Roboto-Condensed 21, Droid-Serif 28.
- **`pebble logs` as a second client wedges the emulator** (`libpebble2.exceptions.TimeoutError`) — pypkjs holds the connection. Use `pebble install --emulator emery --logs`, which streams on the same connection.
- Recovery from any wedge: `pebble kill && pebble wipe`, then rebuild + install.
- Because catching startup logs is a race, have the probe **re-emit results on a `setInterval`**; then attaching late still captures everything.
- `kModdableCreationFlagLogInstrumentation` gives real slot/chunk stats but logs **every second** and drowns the log. Turn it on only to measure.

## Still open

- ~~**R2/R3/R4**~~ **CLOSED on real hardware** (Pebble Time 2 + Android, via
  `pebble install --adb`): binary XHR uses `arraybuffer` on the real runtime;
  decode + palette + dither is 44/110/212 ms (min/median/max) versus 8–17 ms in
  the emulator; localStorage caching persists across restarts. The phone side
  stays in PebbleKit JS — no need for PebbleKit Android.

  Original note, kept because it was the right instinct: the emulator's PKJS is
  **pypkjs on STPyV8 (V8)**, so anything measured there is *optimistic*.

  **Dev phone is Android.** That means: (a) the R3 fallback if pure-JS JPEG decode is too slow is **PebbleKit Android**, not iOS; (b) these can be settled on the real runtime rather than the emulator, via `pebble install --adb` ("Connect to the Pebble app on an Android device over adb, starting its developer connection for you"). Do the R2/R3/R4 probe over adb, not in QEMU. The final build still has to satisfy iOS's JavaScriptCore too, so re-check decode timing there before shipping.
- **R5** (does Plex serve `Range` on `/library/parts/{id}/indexes/sd`) — needs a real server URL + token.
