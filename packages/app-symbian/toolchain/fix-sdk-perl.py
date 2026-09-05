#!/usr/bin/env python3
"""Make the S60 3rd FP2 SDK's Perl scripts run on a modern Perl.

The SDK's build scripts date from 2008 and use `defined %hash` / `defined
@array`, which Perl deprecated long ago and made a hard error in 5.22.
Without this, `bldmake bldfiles` dies immediately in e32plat.pm.

The replacement is the one perldeprecation documents: in boolean context a
bare `%hash` or `@array` is already true when non-empty, which is exactly
what these call sites ask.

Deliberately NOT a regex. `if (defined %{$Plat{$BSF}}) {` and
`if( defined @nodes)` both end in a paren that belongs to the `if`, not to
`defined` - a regex with an optional trailing `)` eats it and silently
produces `if %{$Plat{$BSF}} {`, which is a syntax error further down the
file. So this scans for the balanced extent of the expression instead.

Idempotent - safe to run twice.

Usage: python3 fix-sdk-perl.py $EPOCROOT/epoc32/tools
"""
import os
import sys

WORD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:"


def match_bracket(text, i):
    """Given i at an opening bracket, return the index just past its match."""
    pairs = {"(": ")", "{": "}", "[": "]"}
    close = pairs[text[i]]
    depth = 0
    while i < len(text):
        if text[i] in pairs:
            depth += 1
        elif text[i] == close and depth == 1:
            return i + 1
        elif text[i] in ")}]":
            depth -= 1
        i += 1
    return -1


def read_sigil_expr(text, i):
    """At a % or @ sigil, return the index just past the whole expression."""
    if i >= len(text) or text[i] not in "%@":
        return -1
    j = i + 1
    if j < len(text) and text[j] == "{":
        j = match_bracket(text, j)
        if j < 0:
            return -1
    else:
        start = j
        while j < len(text) and text[j] in WORD:
            j += 1
        if j == start:
            return -1
    # Trailing subscripts, e.g. @{$h{a}}{b} - none in this SDK, but cheap.
    while j < len(text) and text[j] in "{[":
        nxt = match_bracket(text, j)
        if nxt < 0:
            break
        j = nxt
    return j


def fix_text(text):
    out = []
    i = 0
    count = 0
    while True:
        k = text.find("defined", i)
        if k < 0:
            out.append(text[i:])
            break
        # Must be a whole word.
        before_ok = k == 0 or text[k - 1] not in WORD + "$&"
        j = k + len("defined")
        after = j
        while after < len(text) and text[after] in " \t":
            after += 1
        if not before_ok or after >= len(text):
            out.append(text[i:j])
            i = j
            continue

        if text[after] == "(":
            end = match_bracket(text, after)
            if end < 0:
                out.append(text[i:j])
                i = j
                continue
            inner = text[after + 1:end - 1].strip()
            if inner[:1] in ("%", "@"):
                out.append(text[i:k])
                out.append(inner)
                i = end
                count += 1
                continue
        elif text[after] in "%@":
            end = read_sigil_expr(text, after)
            if end > 0:
                out.append(text[i:k])
                out.append(text[after:end])
                i = end
                count += 1
                continue

        out.append(text[i:j])
        i = j
    return "".join(out), count


def unshadow_perl(root):
    """The SDK ships a Windows Perl distribution as `epoc32/tools/perl`, a
    DIRECTORY. Since epoc32/tools goes on PATH ahead of /usr/bin, `make`
    trying to run `perl -S makmake.pl` finds the directory instead of the
    interpreter and dies with "perl: Permission denied" - which looks
    nothing like the actual problem. Nothing on Linux uses it."""
    victim = os.path.join(root, "perl")
    if os.path.isdir(victim) and not os.path.islink(victim):
        target = victim + ".win32-unused"
        if os.path.exists(target):
            print("perl directory already renamed")
            return
        os.rename(victim, target)
        print("renamed epoc32/tools/perl -> perl.win32-unused")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: fix-sdk-perl.py <epoc32/tools directory>")
    root = sys.argv[1]
    unshadow_perl(root)
    total = 0
    for dirpath, _, names in os.walk(root):
        for name in names:
            if not name.endswith((".pm", ".pl")):
                continue
            path = os.path.join(dirpath, name)
            with open(path, "r", errors="surrogateescape") as f:
                text = f.read()
            fixed, n = fix_text(text)
            if n:
                with open(path, "w", errors="surrogateescape") as f:
                    f.write(fixed)
                print("%-56s %d" % (os.path.relpath(path, root), n))
                total += n
    print("\n%d substitutions" % total)


if __name__ == "__main__":
    main()
