// Drawing. Frame band, subtitle band, time band.
//
// Font names are family + size and BOTH must match a real system font — an
// invalid pair builds fine and then kills the JS VM at launch with a blank
// screen and nothing in the logs. Valid: Gothic-Regular/Bold 14/18/24/28,
// Bitham-Bold 42, Bitham-Black 30, Bitham-Light 42, Roboto-Condensed 21,
// Leco-Regular 20/26/28/32/36/38/42, Droid-Serif 28.
//
// Leco is a NUMBERS-only font; drawing a colon through it faults the app, so the
// time uses Bitham-Bold.
//
// Two redraw paths:
//   draw()     full frame — re-expands the picture, used when the scene changes
//   drawTime() time band only, via a clipped begin() — used on minute ticks so
//              the once-a-minute clock update never pays for frame expansion
// That split is what makes strip expansion cheap: the frame is only rebuilt when
// it actually changes.

import Poco from "commodetto/Poco";
import { FW, FH, FRAME_X, LAYOUT, STRIP_H, STRIP_COUNT } from "config";
import * as scenes from "scenes";

const render = new Poco(screen);

const fontTime = new render.Font("Bitham-Bold", 42);
const fontSub = new render.Font("Gothic-Regular", 18);
const fontSmall = new render.Font("Gothic-Regular", 14);

const white = render.makeColor(255, 255, 255);
const black = render.makeColor(0, 0, 0);
const dim = render.makeColor(128, 128, 128);

// The time band owns everything from here down, including the status line.
const TIME_TOP = LAYOUT.subY + LAYOUT.subH;

let status = "";
export function setStatus(s) { status = s; }

// True once a real frame has been painted. While the ring is empty we then keep
// those pixels on screen rather than repainting the band — see draw().
let hasPainted = false;

function panelH() {
	return render.unobstructed ? render.unobstructed.height : render.height;
}

// Greedy wrap. Subtitle lines are short, so this stays cheap.
function wrap(text, font, maxW, maxLines) {
	if (!text) return [];
	const words = text.split(" ");
	const lines = [];
	let line = "";
	for (const w of words) {
		const probe = line ? line + " " + w : w;
		if (render.getTextWidth(probe, font) <= maxW || !line) {
			line = probe;
		} else {
			lines.push(line);
			line = w;
			if (lines.length === maxLines) return lines;
		}
	}
	if (line && lines.length < maxLines) lines.push(line);
	return lines;
}

function paintFrame() {
	if (!scenes.hasFrame()) {
		render.fillRectangle(dim, FRAME_X, LAYOUT.frameY, FW, FH);
		const msg = "waiting for phone";
		const w = render.getTextWidth(msg, fontSub);
		render.drawText(msg, fontSub, black, (render.width - w) >> 1,
			LAYOUT.frameY + (FH >> 1) - 9);
		return;
	}
	// One strip at a time into a shared 3,200 B buffer. fillPattern with w/h
	// equal to the bitmap's own size draws it once rather than tiling, and it is
	// the only Poco path on Pebble that accepts ARGB2222.
	for (let k = 0; k < STRIP_COUNT; k++) {
		const bmp = scenes.stripAt(k);
		if (!bmp) break;
		render.fillPattern(bmp, FRAME_X, LAYOUT.frameY + k * STRIP_H, FW, STRIP_H);
	}
}

// A small hourglass, drawn from rectangles: Poco has no triangle fill and the
// system fonts cannot be relied on for an emoji glyph.
function paintHourglass() {
	// Solid 2px caps top and bottom, tapering to a 3px waist. Thinner caps read
	// as a bowtie rather than an hourglass at this size.
	const rows = [11, 11, 9, 7, 5, 3, 3, 5, 7, 9, 11, 11];
	const W = 11, H = rows.length;
	const x = FRAME_X + FW - W - 5;
	const y = LAYOUT.frameY + FH - H - 5;

	// Clip tightly to the badge so only these pixels of the held frame change.
	render.begin(x - 3, y - 3, W + 6, H + 6);
	render.fillRectangle(black, x - 3, y - 3, W + 6, H + 6);
	for (let i = 0; i < H; i++) {
		const w = rows[i];
		render.fillRectangle(white, x + ((W - w) >> 1), y + i, w, 1);
	}
	render.end();
}

function paintSubtitle() {
	const cur = scenes.current();
	const maxW = render.width - LAYOUT.inset * 2;
	const text = cur ? cur.cue : scenes.lastCue();
	const lines = wrap(text, fontSub, maxW, 3);
	let y = LAYOUT.subY;
	for (const line of lines) {
		const w = render.getTextWidth(line, fontSub);
		render.drawText(line, fontSub, white, (render.width - w) >> 1, y);
		y += fontSub.height;
	}
}

function paintTime(now) {
	const H = panelH();
	const hh = String(watch.hour12 ? (now.getHours() % 12 || 12) : now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const t = `${hh}:${mm}`;
	const tw = render.getTextWidth(t, fontTime);
	render.drawText(t, fontTime, white, (render.width - tw) >> 1,
		Math.min(LAYOUT.timeY, H - LAYOUT.timeH));
	if (status) {
		render.drawText(status, fontSmall, dim, LAYOUT.inset, H - fontSmall.height - 2);
	}
}

// Full redraw: frame + subtitle + time.
//
// When the ring has emptied but a frame HAS been shown, the frame band is left
// exactly as it is and only the bands below are repainted, plus a small
// hourglass. Holding a copy of the retired frame to redraw would cost 7,200
// bytes of chunk we do not have; the panel is already holding those pixels, so
// the cheapest correct move is to not touch them.
export function draw(date) {
	const now = date || new Date();

	if (!scenes.hasFrame() && hasPainted) {
		drawBelowFrame(now);
		paintHourglass();
		return;
	}

	render.begin();
	render.fillRectangle(black, 0, 0, render.width, render.height);
	paintFrame();
	paintSubtitle();
	paintTime(now);
	render.end();
	if (scenes.hasFrame()) hasPainted = true;
}

// Everything below the frame band, clipped so the frame is untouched.
function drawBelowFrame(now) {
	const top = LAYOUT.frameY + FH;
	const h = render.height - top;
	render.begin(0, top, render.width, h);
	render.fillRectangle(black, 0, top, render.width, h);
	paintSubtitle();
	paintTime(now);
	render.end();
}

// Time band only. begin(x,y,w,h) clips the update to that rect, leaving the
// frame and subtitle bands untouched — no expansion, no re-wrap.
export function drawTime(date) {
	const now = date || new Date();
	const h = render.height - TIME_TOP;
	render.begin(0, TIME_TOP, render.width, h);
	render.fillRectangle(black, 0, TIME_TOP, render.width, h);
	paintTime(now);
	render.end();
}

export { render };
