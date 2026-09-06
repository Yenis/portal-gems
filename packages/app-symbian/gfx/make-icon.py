#!/usr/bin/env python3
"""Generates the application icon as a bitmap/mask pair for bmconv.

Drawn in code rather than shipped as opaque binaries: at 44x44 there is
nothing an editor gives you that arithmetic does not, and this way the shape
is reviewable and the result reproducible.

S60 3rd Edition prefers scalable MIF icons, but building those needs
svgtbinencode.exe, a Windows binary, whereas bmconv is native. An MBM pair
is the format the toolchain can actually produce here.

Usage: python3 make-icon.py     (writes icon.bmp and icon_mask.bmp beside it)
"""
import os
import struct

SIZE = 44

# A cut gem, which is what the name asks for. Coordinates are the outline;
# the shape is split at the girdle so the crown can be lit differently from
# the pavilion.
TABLE_L, TABLE_R, TABLE_Y = 12, 32, 11
GIRDLE_L, GIRDLE_R, GIRDLE_Y = 5, 39, 19
TIP_X, TIP_Y = 22, 38

CROWN = [(TABLE_L, TABLE_Y), (TABLE_R, TABLE_Y), (GIRDLE_R, GIRDLE_Y), (GIRDLE_L, GIRDLE_Y)]
PAVILION = [(GIRDLE_L, GIRDLE_Y), (GIRDLE_R, GIRDLE_Y), (TIP_X, TIP_Y)]

CROWN_COLOUR = (0xA5, 0x94, 0xF0)      # lit from above
PAVILION_COLOUR = (0x6C, 0x5C, 0xE0)   # the body of the stone
FACET_COLOUR = (0x4A, 0x3C, 0xB8)      # cut lines
TABLE_COLOUR = (0xC8, 0xBD, 0xFA)      # the flat top catches the most light
BACKGROUND = (0, 0, 0)


def inside(poly, x, y):
    """Even-odd test at the pixel centre."""
    px, py = x + 0.5, y + 0.5
    hit = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xint = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xint:
                hit = not hit
    return hit


def line(pixels, mask, x1, y1, x2, y2, colour):
    """Integer Bresenham, only where the stone already is."""
    dx, dy = abs(x2 - x1), abs(y2 - y1)
    sx = 1 if x1 < x2 else -1
    sy = 1 if y1 < y2 else -1
    err = dx - dy
    while True:
        if 0 <= x1 < SIZE and 0 <= y1 < SIZE and mask[y1][x1]:
            pixels[y1][x1] = colour
        if x1 == x2 and y1 == y2:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x1 += sx
        if e2 < dx:
            err += dx
            y1 += sy


def build():
    pixels = [[BACKGROUND] * SIZE for _ in range(SIZE)]
    mask = [[0] * SIZE for _ in range(SIZE)]

    for y in range(SIZE):
        for x in range(SIZE):
            if inside(CROWN, x, y):
                pixels[y][x] = CROWN_COLOUR
                mask[y][x] = 255
            elif inside(PAVILION, x, y):
                pixels[y][x] = PAVILION_COLOUR
                mask[y][x] = 255

    # The table: a flat highlight across the top of the crown.
    for y in range(TABLE_Y, TABLE_Y + 4):
        for x in range(TABLE_L + 1, TABLE_R):
            if mask[y][x]:
                pixels[y][x] = TABLE_COLOUR

    # Facets. Enough to read as a cut stone, few enough to survive 44 pixels.
    line(pixels, mask, GIRDLE_L, GIRDLE_Y, TIP_X, TIP_Y, FACET_COLOUR)
    line(pixels, mask, GIRDLE_R, GIRDLE_Y, TIP_X, TIP_Y, FACET_COLOUR)
    line(pixels, mask, TABLE_L, TABLE_Y, GIRDLE_L, GIRDLE_Y, FACET_COLOUR)
    line(pixels, mask, TABLE_R, TABLE_Y, GIRDLE_R, GIRDLE_Y, FACET_COLOUR)
    line(pixels, mask, TABLE_L, TABLE_Y + 4, TIP_X, TIP_Y, FACET_COLOUR)
    line(pixels, mask, TABLE_R, TABLE_Y + 4, TIP_X, TIP_Y, FACET_COLOUR)
    line(pixels, mask, GIRDLE_L, GIRDLE_Y, GIRDLE_R, GIRDLE_Y, FACET_COLOUR)

    return pixels, mask


def write_bmp(path, rows):
    """24-bit BMP: bottom-up, rows padded to four bytes."""
    pad = (4 - (SIZE * 3) % 4) % 4
    body = bytearray()
    for y in range(SIZE - 1, -1, -1):
        for x in range(SIZE):
            r, g, b = rows[y][x]
            body += bytes((b, g, r))
        body += b"\x00" * pad
    header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(body), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, SIZE, SIZE, 1, 24, 0, len(body),
                       2835, 2835, 0, 0)
    with open(path, "wb") as f:
        f.write(header + info + body)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    pixels, mask = build()
    write_bmp(os.path.join(here, "icon.bmp"), pixels)
    write_bmp(os.path.join(here, "icon_mask.bmp"),
              [[(v, v, v) for v in row] for row in mask])
    print("wrote icon.bmp and icon_mask.bmp (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
