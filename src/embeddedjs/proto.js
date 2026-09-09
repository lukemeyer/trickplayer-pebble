// Watch side of the scene transport.
//
// Watch -> phone:  SceneReq {SceneReq: fromIdx, SceneTotal: count}
// Phone -> watch:  one scene as N chunks, strictly in order:
//                    {SceneIdx, SceneSeq, SceneTotal, SceneData}
//                  the final chunk also carrying
//                    {ScenePal, SceneCues, SceneTsMs}
//
// PKJS sends chunk N+1 only from the success callback of chunk N, so chunks
// arrive in order and a running offset is enough — no per-chunk seek, and no
// separate reassembly buffer beyond the scene's own.
//
// Byte-array tuples arrive as ArrayBuffer (pebble-appmessage.c uses
// xsmcSetArrayBuffer for TUPLE_BYTE_ARRAY); cstrings as String; uints as Number.

import Message from "pebble/message";
import { FW, FH, palBytes } from "config";

const KEYS = [
	"Hello", "SceneReq", "SceneIdx", "SceneSeq", "SceneTotal", "SceneData",
	"ScenePal", "SceneCues", "SceneTsMs", "SceneW", "SceneH", "SceneDepth",
	"Caps", "Err",
];

let msg = null;
let writable = false;
let pending = null;          // { idx, u8, off, total }
let queuedReq = null;        // coalesced request while not writable

let onScene = () => {};
let onState = () => {};

export function init(h) {
	onScene = h.onScene || onScene;
	onState = h.onState || onState;
}

export function start() {
	msg = new Message({
		keys: KEYS,
		// Cap the buffers. The default is app_message_inbox_size_maximum(),
		// which is drawn from the same C heap that the accelerometer
		// subscription needs — and that is already tight.
		input: 2048,
		output: 256,
		onReadable() {
			try { handle(this.read()); }
			catch (e) { trace(`proto: handle failed ${e}\n`); }
		},
		onWritable() {
			writable = true;
			onState("writable");
			if (queuedReq) {
				const q = queuedReq;
				queuedReq = null;
				requestScenes(q.from, q.count);
			}
		},
		onSuspend() {
			writable = false;
			onState("suspended");
		},
	});
}

export function isWritable() { return writable; }

export function requestScenes(fromIdx, count) {
	if (!msg || !writable) {
		// Coalesce: a burst of refill checks must not become a burst of radio.
		queuedReq = { from: fromIdx, count };
		return false;
	}
	try {
		msg.write(new Map([
			["SceneReq", fromIdx],
			["SceneTotal", count],
			["SceneW", FW],
			["SceneH", FH],
		]));
		return true;
	} catch (e) {
		trace(`proto: request failed ${e}\n`);
		queuedReq = { from: fromIdx, count };
		return false;
	}
}

function handle(map) {
	if (map.has("Err")) {
		onState("err:" + map.get("Err"));
		return;
	}
	if (!map.has("SceneIdx") || !map.has("SceneData")) return;

	const idx = map.get("SceneIdx");
	const seq = map.get("SceneSeq");
	const total = map.get("SceneTotal");
	const data = new Uint8Array(map.get("SceneData"));

	if (!pending || pending.idx !== idx || seq === 0) {
		pending = { idx, u8: new Uint8Array(palBytes(FW, FH)), off: 0, total };
	}

	// Guard against a dropped chunk: without in-order arrival the offset is
	// meaningless, so abandon the scene rather than assemble garbage.
	if (seq !== 0 && pending.off === 0) {
		trace(`proto: scene ${idx} chunk ${seq} without a start; dropping\n`);
		pending = null;
		return;
	}

	const room = pending.u8.length - pending.off;
	const n = data.length < room ? data.length : room;
	for (let i = 0; i < n; i++) pending.u8[pending.off + i] = data[i];
	pending.off += n;

	if (seq + 1 < total) return;

	const palBuf = map.has("ScenePal") ? new Uint8Array(map.get("ScenePal")) : null;
	const cues = map.has("SceneCues") ? String(map.get("SceneCues")) : "";
	const scene = {
		idx,
		tsMs: map.has("SceneTsMs") ? map.get("SceneTsMs") : 0,
		cues: cues ? cues.split("\n") : [],
		packed: pending.u8,
		pal: palBuf,
	};
	pending = null;

	if (!scene.pal) {
		trace(`proto: scene ${idx} arrived without a palette; dropping\n`);
		return;
	}
	onScene(scene);
}
