#!/usr/bin/env python3
"""Validates build/written.zip with a real zip library.

The C tests read back what the C writer produced, which proves the two
agree with each other. This proves they agree with the format.

Run: python3 tools/checkzip.py build/written.zip
"""
import sys
import zipfile
import zlib

EXPECTED = [
    ("notes.txt", b"a short note"),
    ("photos/one.bin", bytes(i & 0xFF for i in range(300))),
    ("empty/", b""),
    ("big.bin", bytes((i * 7 + 11) & 0xFF for i in range(100000))),
    ("a/b/c/deep.txt", b"deep"),
]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "build/written.zip"
    problems = []

    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad is not None:
            problems.append("testzip reported a bad entry: %s" % bad)

        names = z.namelist()
        want = [n for n, _ in EXPECTED]
        if names != want:
            problems.append("names %r, expected %r" % (names, want))

        for name, data in EXPECTED:
            if name not in names:
                continue
            got = z.read(name)
            if got != data:
                problems.append(
                    "%s: %d bytes crc %08x, expected %d bytes crc %08x"
                    % (name, len(got), zlib.crc32(got) & 0xFFFFFFFF,
                       len(data), zlib.crc32(data) & 0xFFFFFFFF))
            info = z.getinfo(name)
            if info.compress_type != zipfile.ZIP_STORED:
                problems.append("%s: compress_type %d, expected stored"
                                % (name, info.compress_type))
            # The reference client chmods to external_attr >> 16 on extract,
            # so a zero mode makes a directory unwritable and the transfer
            # fails part-way. Pin real permissions.
            mode = info.external_attr >> 16
            want = 0o040755 if name.endswith("/") else 0o100644
            if mode != want:
                problems.append("%s: unix mode 0o%o, expected 0o%o"
                                % (name, mode, want))

    if problems:
        print("checkzip: FAILED")
        for p in problems:
            print("  " + p)
        return 1
    print("checkzip: python zipfile agrees - %d entries, all stored, contents match"
          % len(EXPECTED))
    return 0


if __name__ == "__main__":
    sys.exit(main())
