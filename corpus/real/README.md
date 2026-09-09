# Real captured fixtures

Everything else in `corpus/` is synthetic or metadata-only. These are
different: **they contain actual frame bytes**, captured from a real Plex
server by `tools/corpus/capture-fixture.js`.

Nothing is in here yet. This directory is the slot and the instructions.

## Why bother, given the synthetic fixtures work

The synthetic ones cover the rules well and caught real bugs. What they cannot
do is tell you what an encoder *actually writes*. A real capture pins:

* **The real header values.** `corpus/timeline/synthetic.bif` stores `0` in
  the multiplier field because that is what Plex writes — but that is an
  assumption restated, not a fact confirmed. A capture confirms it.
* **The real frame-size distribution**, which is what [[F-007]]'s
  median-relative blank threshold is calibrated against.
* **The real duplicate structure**, which is the one [[F-001]] turns on.
  `corpus/scene/episode.frames.json` reproduces the measured *proportions*,
  but it is a model of a duplicate run, not a duplicate run.

## The content must be licensed for redistribution

Non-negotiable, and the reason this directory is separate from the rest. The
capture tool refuses to run without `--attribution`, and appends every capture
to `ATTRIBUTION.md`.

The Blender open movies are the natural source — all CC-BY 3.0, all
downloadable, all fine to redistribute frames from with credit.

### Which one, though — this matters more than it looks

| | Frames | Dialogue | Exercises |
|---|---|---|---|
| **Big Buck Bunny** | animation, long static holds | **none — it is wordless** | timeline half only |
| **Sintel** | animation | yes, with official subtitles in many languages | both halves |
| **Tears of Steel** | live action + VFX | yes, with official subtitles | both halves |

**Big Buck Bunny has no dialogue**, so it has no subtitle track. Two
consequences worth knowing before you spend the time:

1. It cannot exercise the cue, scene-assignment or cue-layout half of the
   corpus at all.
2. It will not pass this project's own eligibility filter ([[F-014]]), which
   requires a subtitle stream with a non-null `key`. The capture tool
   deliberately bypasses that check and captures the timeline half anyway —
   but the app itself would not offer the item.

Against that, it is arguably the **best** available choice for the half it
does cover: animation with long held shots is exactly the content that
produces byte-identical duplicate frames, which is [[F-001]]'s whole subject.

**Suggestion:** capture Big Buck Bunny for the timeline and duplicate half,
and add Sintel or Tears of Steel if you want the subtitle half covered by real
data too. They are not mutually exclusive — the tool namespaces by `--name`.

## Capturing one

Plex must have generated the index first: **Settings → Library → Generate
video preview thumbnails**, then Analyze the item and wait. The tool says so
if the index is missing rather than failing obscurely.

Sign in through the Timeline Tuner first — the capture tool reuses its
session.

```bash
node tools/corpus/capture-fixture.js \
  --search "Big Buck Bunny" \
  --name big-buck-bunny \
  --attribution "Big Buck Bunny (c) 2008 Blender Foundation, CC BY 3.0, peach.blender.org"
```

Add `--dry-run` to resolve the item and report frame count, multiplier, track
size and duplicate share without writing anything. Worth doing first.

If the title matches more than one item the tool lists the candidates and
stops; pass `--rating-key` instead.

## What it writes

| File | Contents |
|---|---|
| `<name>.bif` | A valid BIF with **real frame bytes**. Whole file if it fits the budget (2 MB default), otherwise the first N frames re-emitted with a correct sentinel. |
| `<name>.expected.json` | Header values, frame records and duplicate map — taken from the file, not from a parser. |
| `<name>.frames.json` | Metadata for the **whole original** — timings and lengths, no bytes — so scene policy runs at real scale even when the `.bif` is truncated. |
| `<name>.cues.json` | Cue timings only, if the item has a subtitle track. No dialogue text. |
| `ATTRIBUTION.md` | Appended credit for every capture. |

A truncated `.bif` is **derived**: offsets are recomputed and the sentinel is
rewritten. The payloads are the server's actual bytes, so the real header
values, real sizes and real duplicate structure all survive — which is
everything the fixture exists for.

## Then

`tools/corpus/check-corpus.js` and each platform runner pick up anything in
here automatically, and skip cleanly when it is absent. Re-run
`tools/corpus/sync-corpus.sh` to push the new fixture to the platform repos,
and update the **Conformance** line of whichever findings it now pins.
