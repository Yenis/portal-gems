#!/usr/bin/env python3
"""Load a LOCAL mailbox server the way open chats would, and measure it.

This speaks the mailbox server's own protocol (bind, list, claim, open, add,
release, close) with made-up message bodies of realistic size. The server
never looks inside a body, so no cryptography is needed to load it honestly.

What one "chat" is here: two devices, each holding one connection open and
asking for the list of slots every --poll seconds. On top of that:

  --waiting   a share of chats has a sender sitting on a slot, unanswered.
              Every such slot is one more entry in every list reply.
  --rate      messages per minute per chat. Each is one full exchange on two
              fresh connections: claim, the handshake's four messages, the
              message, the acknowledgement, release, close.

Run a stock server first, in a scratch directory (it writes relay.sqlite):

    python3 -m venv venv
    venv/bin/pip install magic-wormhole-mailbox-server websockets psutil
    venv/bin/twist --log-level=error wormhole-mailbox \
        --port tcp:4000:interface=127.0.0.1 &

Then, with the server's pid so its CPU and memory are sampled:

    venv/bin/python scripts/mailbox-load.py --pid <pid> --chats 100,500,1000

It refuses any server that is not on this machine. Do not point a copy of
this at a server other people use.
"""

import argparse
import asyncio
import json
import os
import random
import secrets
import statistics
import sys
import time

import psutil
from websockets.asyncio.client import connect

APPID = "lothar.com/wormhole/text-or-file-xfer"


def hexbody(nbytes):
    return secrets.token_hex(nbytes)


class Stats:
    def __init__(self):
        self.list_ms = []
        self.list_bytes = []
        self.exch_ms = []
        self.errors = {}
        self.measuring = False

    def error(self, what):
        self.errors[what] = self.errors.get(what, 0) + 1


async def open_ws(url):
    ws = await connect(
        url, max_size=None, compression=None, ping_interval=None, open_timeout=30
    )
    await until(ws, "welcome")
    side = secrets.token_hex(5)
    await send(ws, type="bind", appid=APPID, side=side)
    return ws, side


async def send(ws, **msg):
    msg["id"] = secrets.token_hex(2)
    await ws.send(json.dumps(msg))


async def until(ws, kind, pred=None, timeout=60):
    """Read until a message of this type (and matching pred) arrives."""
    async with asyncio.timeout(timeout):
        while True:
            raw = await ws.recv()
            msg = json.loads(raw)
            if msg.get("type") == "error":
                raise RuntimeError("server error: %s" % msg.get("error"))
            if msg.get("type") == kind and (pred is None or pred(msg)):
                msg["_len"] = len(raw)
                return msg


async def poller(url, interval, stats, gate):
    """One device with a chat open: a connection, and `list` on a timer."""
    try:
        async with gate:
            ws, _ = await open_ws(url)
    except Exception as e:
        stats.error("poll-connect:" + type(e).__name__)
        return
    try:
        await asyncio.sleep(random.uniform(0, interval))
        while True:
            t0 = time.perf_counter()
            await send(ws, type="list")
            reply = await until(ws, "nameplates")
            if stats.measuring:
                stats.list_ms.append((time.perf_counter() - t0) * 1000)
                stats.list_bytes.append(reply["_len"])
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        stats.error("poll:" + type(e).__name__)
    finally:
        await ws.close()


async def waiter(url, stats, gate):
    """A sender on a slot nobody answers: one entry in everyone's list."""
    try:
        async with gate:
            ws, _ = await open_ws(url)
        nameplate = str(secrets.randbelow(10**16 - 10**15) + 10**15)
        await send(ws, type="claim", nameplate=nameplate)
        mailbox = (await until(ws, "claimed"))["mailbox"]
        await send(ws, type="open", mailbox=mailbox)
        await send(ws, type="add", phase="pake", body=hexbody(45))
    except Exception as e:
        stats.error("wait:" + type(e).__name__)
        return
    try:
        while True:
            await ws.recv()
    except asyncio.CancelledError:
        raise
    except Exception:
        pass
    finally:
        await ws.close()


async def join(url, nameplate):
    ws, side = await open_ws(url)
    await send(ws, type="claim", nameplate=nameplate)
    mailbox = (await until(ws, "claimed"))["mailbox"]
    await send(ws, type="open", mailbox=mailbox)
    return ws, side, mailbox


async def exchange(url, stats, msg_bytes):
    """One chat message: everything two devices say to the server for it."""
    nameplate = str(secrets.randbelow(10**16 - 10**15) + 10**15)
    t0 = time.perf_counter()
    a = b = None
    try:
        a, a_side, mailbox = await join(url, nameplate)
        await send(a, type="add", phase="pake", body=hexbody(45))

        # The receiver finds the slot in the list, then joins it.
        b, b_side = await open_ws(url)
        await send(b, type="list")
        await until(b, "nameplates")
        await send(b, type="claim", nameplate=nameplate)
        await until(b, "claimed")
        await send(b, type="open", mailbox=mailbox)

        def frm(side, phase):
            return lambda m: m.get("side") == side and m.get("phase") == phase

        await until(b, "message", frm(a_side, "pake"))
        await send(b, type="add", phase="pake", body=hexbody(45))
        await send(b, type="add", phase="version", body=hexbody(90))
        await until(a, "message", frm(b_side, "pake"))
        await send(a, type="add", phase="version", body=hexbody(90))
        await until(a, "message", frm(b_side, "version"))
        await until(b, "message", frm(a_side, "version"))
        for ws in (a, b):
            await send(ws, type="release", nameplate=nameplate)

        # The message itself, and the acknowledgement. 40 bytes of box
        # overhead, and the offer's own JSON around the text.
        await send(a, type="add", phase="0", body=hexbody(msg_bytes + 60))
        await until(b, "message", frm(a_side, "0"))
        await send(b, type="add", phase="0", body=hexbody(72))
        await until(a, "message", frm(b_side, "0"))

        for ws in (a, b):
            await send(ws, type="close", mailbox=mailbox, mood="happy")
        await until(a, "closed")
        await until(b, "closed")
        if stats.measuring:
            stats.exch_ms.append((time.perf_counter() - t0) * 1000)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        stats.error("exchange:" + type(e).__name__)
    finally:
        for ws in (a, b):
            if ws is not None:
                await ws.close()


async def exchanges(url, stats, per_second, msg_bytes):
    if per_second <= 0:
        return
    running = set()
    try:
        while True:
            await asyncio.sleep(random.expovariate(per_second))
            t = asyncio.create_task(exchange(url, stats, msg_bytes))
            running.add(t)
            t.add_done_callback(running.discard)
    finally:
        for t in running:
            t.cancel()


async def sample(proc, me, out, stop):
    proc.cpu_percent(None)
    me.cpu_percent(None)
    while not stop.is_set():
        await asyncio.sleep(1)
        out["server_cpu"].append(proc.cpu_percent(None))
        out["client_cpu"].append(me.cpu_percent(None))
        out["rss"] = proc.memory_info().rss


def pct(values, p):
    if not values:
        return float("nan")
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * p))]


async def stage(args, chats, proc):
    stats = Stats()
    gate = asyncio.Semaphore(200)
    tasks = [
        asyncio.create_task(poller(args.url, args.poll, stats, gate))
        for _ in range(chats * 2)
    ]
    tasks += [
        asyncio.create_task(waiter(args.url, stats, gate))
        for _ in range(int(chats * args.waiting))
    ]
    per_second = chats * args.rate / 60.0
    tasks.append(
        asyncio.create_task(exchanges(args.url, stats, per_second, args.msg_bytes))
    )

    # Let every connection open and take its first turn before measuring.
    await asyncio.sleep(min(args.poll, 30) + 5 + chats / 400)
    usage = {"server_cpu": [], "client_cpu": [], "rss": 0}
    stop = asyncio.Event()
    sampler = (
        asyncio.create_task(sample(proc, psutil.Process(), usage, stop))
        if proc
        else None
    )
    stats.measuring = True
    await asyncio.sleep(args.seconds)
    stats.measuring = False
    stop.set()
    if sampler:
        await sampler

    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    cpu = usage["server_cpu"]
    row = {
        "chats": chats,
        "conns": chats * 2 + int(chats * args.waiting),
        "list/s": len(stats.list_ms) / args.seconds,
        "list p50": pct(stats.list_ms, 0.50),
        "list p95": pct(stats.list_ms, 0.95),
        "list max": max(stats.list_ms, default=float("nan")),
        "reply B": statistics.mean(stats.list_bytes) if stats.list_bytes else 0,
        "msg/s": len(stats.exch_ms) / args.seconds,
        "msg p50": pct(stats.exch_ms, 0.50),
        "msg p95": pct(stats.exch_ms, 0.95),
        "srv cpu": statistics.mean(cpu) if cpu else float("nan"),
        "srv max": max(cpu, default=float("nan")),
        "srv MB": usage["rss"] / 1e6,
        "cli cpu": (
            statistics.mean(usage["client_cpu"])
            if usage["client_cpu"]
            else float("nan")
        ),
        "errors": sum(stats.errors.values()),
    }
    return row, stats.errors


def show(rows):
    cols = list(rows[0].keys())
    print("  ".join("%9s" % c for c in cols))
    for row in rows:
        print(
            "  ".join(
                "%9d" % row[c] if isinstance(row[c], int) else "%9.1f" % row[c]
                for c in cols
            )
        )
    sys.stdout.flush()


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="ws://127.0.0.1:4000/v1")
    ap.add_argument("--pid", type=int, help="the server's pid, to sample it")
    ap.add_argument("--chats", default="100", help="stages, comma-separated")
    ap.add_argument("--poll", type=float, default=10, help="seconds between polls")
    ap.add_argument("--waiting", type=float, default=0.1, help="share of chats")
    ap.add_argument("--rate", type=float, default=4, help="messages/min per chat")
    ap.add_argument("--msg-bytes", type=int, default=600)
    ap.add_argument("--seconds", type=float, default=40, help="measured per stage")
    args = ap.parse_args()

    host = args.url.split("//", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0]
    if host not in ("127.0.0.1", "localhost", "[::1]"):
        sys.exit("refusing: %s is not this machine" % host)

    proc = psutil.Process(args.pid) if args.pid else None
    print(
        "poll %gs, %g%% of chats waiting, %g messages/min per chat, %d-byte messages"
        % (args.poll, args.waiting * 100, args.rate, args.msg_bytes)
    )
    rows = []
    for chats in [int(c) for c in args.chats.split(",")]:
        row, errors = await stage(args, chats, proc)
        rows.append(row)
        show(rows[-1:] if len(rows) > 1 else rows)
        if errors:
            print("    errors:", errors)
        await asyncio.sleep(3)
    if len(rows) > 1:
        print()
        show(rows)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        os._exit(130)
