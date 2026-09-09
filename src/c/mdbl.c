#include <pebble.h>

// Alloy entry point. The only reason this differs from the stock template is
// the XS machine sizing.
//
// The default Pebble Alloy machine (build/devices/pebble/manifest.json) is
// static 32768 / chunk 8192, which holds roughly ONE frame bitmap. Sizing is
// taken from this record, NOT from src/embeddedjs/manifest.json — our JS builds
// as a Moddable mod, so a "creation" block there is silently ignored.
//
// Measured on emery (see spikes/PHASE0-FINDINGS.md): app heap is ~122,568 B and
// stack+slot+chunk comes out of it. 8192+20480+86016 = 114,688 fits; pushing
// chunk to 94208 exceeds the budget and gains nothing. ~28 KB of chunk is
// baseline runtime overhead, leaving ~29 KB for scene buffers at chunk 57344.
//
// CRITICAL: the XS machine and the C side are a zero-sum tug of war over that
// heap, and AppMessage must win. At chunk 69632 (machine 106,496) the Message
// constructor's app_message_open() failed and took the watchface down with it —
// a HARD abort, not a catchable JS error, so try/catch around it does nothing
// and the only symptom is the app relaunching. 57344 leaves the C side ~28 KB,
// which is enough for AppMessage plus the sensors.
//
// Symptom to recognise: modules all load, then the app restarts immediately at
// the first `new Message()`. If that happens after adding watch-side code, this
// number is why — a bigger mod erodes the same margin.
//
// Two undocumented traps, both learned the hard way:
//   - "0 for default" in pebble.h is wrong. A zero in ANY of stack/slot/chunk
//     makes the whole record invalid and the VM never starts.
//   - .stack is documented in bytes but behaves like the manifest's slot count.
//     .stack = 1024 gives "stack overflow (-3)" at launch.
// Split rebalanced toward SLOT after the watch aborted with
// "# Slot allocation: failed in fixed size heap" — the slot heap ran out, not
// chunk. Slots hold objects, strings and function bodies, and the mod grew to
// ~17.5 KB of resident JS, so baseline slot usage climbed with every module
// added. RING_SIZE 1 needs far less chunk, so the surplus goes to slots.
//
// The total stays at 94,208: that is what leaves the C side the ~28 KB
// AppMessage needs, and it is not negotiable (see above).
#define XS_STACK  8192
#define XS_SLOT   36864
#define XS_CHUNK  49152

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = XS_STACK,
    .slot = XS_SLOT,
    .chunk = XS_CHUNK,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#else
    .flags = 0,   // kModdableCreationFlagLogInstrumentation did not emit over adb
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
