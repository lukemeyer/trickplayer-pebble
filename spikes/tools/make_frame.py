#!/usr/bin/env python3
"""Encode a BIF JPEG frame for the Pebble emery display, two ways.

  full : ARGB2222, 64 fixed colours, Floyd-Steinberg per channel.   22,400 B
  pal  : 4-bit indexed into a per-frame 16-entry palette (median cut),
         Floyd-Steinberg in palette space.                          11,200 B + 16 B

Emits an embeddedjs module as an ARRAY of short base64 chunks. A single ~30k-char
string literal faults the mod at load; short chunks decoded straight into the
destination buffer avoid ever materialising a big string.

Usage: make_frame.py <frame.jpg> <full|pal> <out.js>
"""
import base64, struct, subprocess, sys, tempfile, os

W, H = 200, 112                   # override with argv[4], argv[5]
CHUNK = 1024                      # base64 chars per literal; multiple of 4


def load_rgb(jpg):
    """Decode + downscale via macOS sips, read back as BMP."""
    tmp = tempfile.mktemp(suffix=".bmp")
    subprocess.run(["sips", "-z", str(H), str(W), "-s", "format", "bmp",
                    jpg, "--out", tmp], check=True, capture_output=True)
    d = open(tmp, "rb").read()
    os.unlink(tmp)
    off = struct.unpack_from("<I", d, 10)[0]
    w, h = struct.unpack_from("<ii", d, 18)
    topdown, h = h < 0, abs(h)
    row = (w * 3 + 3) // 4 * 4
    px = []
    for y in range(h):
        yy = y if topdown else h - 1 - y
        base = off + yy * row
        px.append([(d[base + x * 3 + 2], d[base + x * 3 + 1], d[base + x * 3])
                   for x in range(w)])
    return px, w, h


def snap64(c):
    """Nearest colour representable on a 64-colour Pebble panel."""
    return tuple(min(3, max(0, round(v * 3 / 255))) * 85 for v in c)


def argb(c2):
    """(r,g,b) at 0/85/170/255 -> GColor8 byte AARRGGBB, opaque."""
    r, g, b = (v // 85 for v in c2)
    return 0xC0 | (r << 4) | (g << 2) | b


def median_cut(pixels, n=16):
    """Classic median cut, but each final entry snapped into the 64-colour space
    so the comparison is 16-of-64 vs all-64 rather than 16 unattainable colours.

    Over-split deliberately: snapping to 64 colours makes nearby boxes collapse
    onto the same entry, so cutting to exactly n leaves duplicates and wastes
    slots. Cut to 4n and keep the first n distinct snapped colours, largest
    boxes first."""
    boxes = [pixels]
    target = n * 4
    while len(boxes) < target:
        boxes.sort(key=lambda b: max(
            (max(p[i] for p in b) - min(p[i] for p in b)) for i in range(3))
            if len(b) > 1 else -1, reverse=True)
        big = boxes.pop(0)
        if len(big) < 2:
            boxes.append(big)
            break
        ch = max(range(3), key=lambda i: max(p[i] for p in big) - min(p[i] for p in big))
        big.sort(key=lambda p: p[ch])
        m = len(big) // 2
        boxes += [big[:m], big[m:]]
    # biggest boxes first, so the colours that cover the most pixels win the slots
    pal = []
    for b in sorted((b for b in boxes if b), key=len, reverse=True):
        avg = tuple(sum(p[i] for p in b) // len(b) for i in range(3))
        s = snap64(avg)
        if s not in pal:
            pal.append(s)
        if len(pal) == n:
            break
    while len(pal) < n:
        pal.append(pal[-1])
    return pal[:n]


def emit(path, mode, data, pal, w, h):
    b64 = base64.b64encode(bytes(data)).decode()
    parts = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)]
    with open(path, "w") as f:
        f.write(f"// Real Plex BIF frame, {mode} encoding, {w}x{h}, {len(data)} bytes.\n")
        f.write("// Array of short base64 chunks: one big literal faults the mod at load.\n")
        f.write(f'export const MODE = "{mode}";\n')
        f.write(f"export const FW = {w}, FH = {h};\n")
        f.write("export const PAL = [" + ",".join(str(argb(c)) for c in pal) + "];\n"
                if pal else "export const PAL = null;\n")
        f.write("export default [\n")
        for p in parts:
            f.write(f'"{p}",\n')
        f.write("];\n")
    print(f"{mode}: {len(data)} bytes -> {len(parts)} chunks -> {path}")


def main():
    global W, H
    jpg, mode, out = sys.argv[1], sys.argv[2], sys.argv[3]
    if len(sys.argv) > 5:
        W, H = int(sys.argv[4]), int(sys.argv[5])
    px, w, h = load_rgb(jpg)

    if mode == "full":
        buf = bytearray(w * h)
        cur = [[0, 0, 0] for _ in range(w + 2)]
        nxt = [[0, 0, 0] for _ in range(w + 2)]
        for y in range(h):
            for c in nxt:
                c[0] = c[1] = c[2] = 0
            for x in range(w):
                p, q = px[y][x], [0, 0, 0]
                for c in range(3):
                    want = p[c] + cur[x + 1][c]
                    lvl = max(0, min(3, round(want * 3 / 255)))
                    q[c] = lvl
                    e = want - lvl * 85
                    cur[x + 2][c] += e * 7 // 16
                    nxt[x][c] += e * 3 // 16
                    nxt[x + 1][c] += e * 5 // 16
                    nxt[x + 2][c] += e * 1 // 16
                buf[y * w + x] = 0xC0 | (q[0] << 4) | (q[1] << 2) | q[2]
            cur, nxt = nxt, cur
        emit(out, "full", buf, None, w, h)

    else:
        flat = [p for row in px for p in row]
        pal = median_cut(list(flat), 16)
        stride = (w + 1) // 2
        buf = bytearray(stride * h)
        cur = [[0, 0, 0] for _ in range(w + 2)]
        nxt = [[0, 0, 0] for _ in range(w + 2)]
        for y in range(h):
            for c in nxt:
                c[0] = c[1] = c[2] = 0
            for x in range(w):
                p = px[y][x]
                want = [max(0, min(255, p[c] + cur[x + 1][c])) for c in range(3)]
                bi, bd = 0, 1 << 30
                for i, pc in enumerate(pal):
                    d = sum((want[c] - pc[c]) ** 2 for c in range(3))
                    if d < bd:
                        bi, bd = i, d
                for c in range(3):
                    e = want[c] - pal[bi][c]
                    cur[x + 2][c] += e * 7 // 16
                    nxt[x][c] += e * 3 // 16
                    nxt[x + 1][c] += e * 5 // 16
                    nxt[x + 2][c] += e * 1 // 16
                # high nibble = even x
                if x & 1:
                    buf[y * stride + (x >> 1)] |= bi
                else:
                    buf[y * stride + (x >> 1)] |= bi << 4
            cur, nxt = nxt, cur
        emit(out, "pal", buf, pal, w, h)


main()
