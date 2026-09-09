#include <pebble.h>

// Bisecting the accepted range: 65536 was rejected outright
// ("invalid ModdableCreationRecord"); the platform default is 8192.
#ifndef CHUNK_BYTES
#define CHUNK_BYTES 86016
#endif

// Phase 0: the stock template calls moddable_createMachine(NULL), which gives
// the Pebble default XS machine (build/devices/pebble/manifest.json:
// static 32768, chunk.initial 8192). That is far too small to hold a ring
// buffer of frame bitmaps — 8KB of chunk space dies after roughly one 3136B
// scene. ModdableCreationRecord.chunk/.slot are the documented knobs.
int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    // 0 = keep the platform default. Raising .stack to 1024 produced
    // "stack overflow (-3)" at startup, so its units are not what the doc
    // comment implies — leave stack and slot alone and move only .chunk,
    // which is where ArrayBuffers live.
    // NB: despite "0 for default" in the header, a zero here makes the whole
    // record invalid. All three must be given explicitly.
    // Platform defaults (build/devices/pebble/manifest.json) are in SLOTS:
    // stack 384, heap 512, chunk 8192 bytes. An XS slot is 16 bytes on 32-bit,
    // so stack 384 slots ~= 6144 bytes — which is why .stack=1024 overflowed.
    .stack = 8192,
    .slot = 20480,
    .chunk = CHUNK_BYTES,
    .flags = 0,   // set to kModdableCreationFlagLogInstrumentation to measure heap
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
