# Shared knowledge

This is **Trickplayer watchface** — the Pebble build of Trickplayer, one of three
implementations of the same product:

| Repo | Platform |
|---|---|
| `trickplayer-g2` | Even Realities G2 |
| `trickplayer-pebble` | Pebble Time 2 |
| `trickplayer-wearos` | Wear OS |

Findings that are not specific to Pebble live in **`trickplayer-knowledge`**,
not here.

## The rule

A non-obvious discovery gets a `findings/` entry in `trickplayer-knowledge`,
with the per-platform *applies / status* table filled in, **before the PR that
acts on it merges**.

"Does not apply to Pebble, because X" is a complete answer and takes ten
seconds. Silence is what costs six months — see `PLAN.md` §2 for the three
corrections that sat in one repo's comments while the other two shipped the bug.

## What belongs where

**`trickplayer-knowledge`** — the rules, and the conformance corpus that
enforces them: trick-play index parsing, SRT parsing and cue-window ownership,
scene selection policy, cursor semantics, the media-source contract.

**Here** — everything shaped by this platform's constraints: the image pipeline,
the transport, the trigger model, layout, and config UI. Those are genuinely
different across the three and are not worth unifying.

## Vocabulary

Domain terms are standardized across all three repos. `Timeline` (not
`BifIndex`), `FrameRef`, `timelineRef`, `itemId`, `subtitleRef`, `scene`
(not `chunk`). See `PLAN.md` §7, Phase 0.
