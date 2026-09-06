/* Platform layer for Symbian OS 9.x / S60 3rd Edition.
 *
 * Implements native/wormhole-mini/src/net.h with RSocket. Everything above
 * this file is portable C and is already tested on the host and on 32-bit
 * ARM; this is the only part that is Symbian-specific.
 *
 * Synchronous style: each operation is issued and then waited on with
 * User::WaitForRequest. That is the right shape for the headless console
 * build, and it matches the blocking interface the protocol code expects.
 * A GUI build must not call these from the UI thread - it would freeze the
 * display - so the application runs them in a worker thread (see
 * packages/app-symbian).
 *
 * UNVERIFIED until the SDK build runs. */

#include <e32base.h>
#include <e32cons.h>
#include <es_sock.h>
#include <in_sock.h>
#include <random.h>       /* TRandom, from the platform crypto module */
#include <commdbconnpref.h>

extern "C" {
#include "../src/net.h"
}

/* No allocation after startup: connections come from a fixed pool. Two is
 * enough for the whole protocol - one mailbox, one transit. */
#define WH_MAX_CONN 4

struct wh_conn {
    RSocket socket;
    TBool used;
};

static RSocketServ gSocketServ;
static RConnection gConnection;
static TBool gNetStarted = EFalse;
/* Whether gConnection is usable. When it is not we still try: sockets can
 * be opened straight on the socket server, which uses the system's implicit
 * connection. A phone with no SIM can easily have no usable default
 * connection while Wi-Fi works perfectly for anything that asks. */
static TBool gHaveConnection = EFalse;
static wh_conn gConns[WH_MAX_CONN];

static TInt gLastStage = WH_NET_STAGE_NONE;
static TInt gLastError = KErrNone;

/* Cancellation. gCancelReq is owned by the worker thread; the UI thread
 * completes it through RThread::RequestComplete, which is what makes a
 * blocked read return. The flag is separate so the reason survives after
 * RequestComplete has nulled the pointer. */
static TRequestStatus gCancelReq;
static TRequestStatus* gCancelPtr = NULL;
static volatile TInt gCancelled = 0;

extern "C" void wh_net_cancel_arm(void)
{
    gCancelReq = KRequestPending;
    gCancelPtr = &gCancelReq;
    gCancelled = 0;
}

extern "C" int wh_net_cancelled(void)
{
    return gCancelled;
}

/* Called from the UI thread with the worker's handle. Raising the flag and
 * completing the request are both needed: the flag is what the protocol code
 * sees, the completion is what wakes it up to look. */
void WhminiCancelWorker(RThread& aWorker)
{
    gCancelled = 1;
    if (gCancelPtr) aWorker.RequestComplete(gCancelPtr, KErrCancel);
}

static void Fail(TInt aStage, TInt aErr)
{
    gLastStage = aStage;
    gLastError = aErr;
}

extern "C" int wh_net_have_connection(void)
{
    return gHaveConnection ? 1 : 0;
}

extern "C" int wh_net_last_stage(void)
{
    return gLastStage;
}

extern "C" long wh_net_last_error(void)
{
    return (long)gLastError;
}

/* Brings up the socket server and an outbound connection. On S60 this is
 * what triggers the access point prompt, so it happens once and is then
 * shared by the mailbox and transit sockets. */
static TInt StartNetwork()
{
    if (gNetStarted) return KErrNone;

    TInt err = gSocketServ.Connect();
    if (err != KErrNone) {
        Fail(WH_NET_STAGE_SOCKETSERV, err);
        return err;
    }

    /* Three attempts, weakest assumption last. Failing to start a named
     * connection is not a reason to give up on networking: what matters is
     * that a socket can be opened, and the implicit connection can do that
     * on its own. */
    err = gConnection.Open(gSocketServ);
    if (err == KErrNone) {
        /* 1. Ask the user which access point to use. */
        TCommDbConnPref pref;
        pref.SetDialogPreference(ECommDbDialogPrefPrompt);
        err = gConnection.Start(pref);

        /* 2. Whatever the phone considers the default. */
        if (err != KErrNone) err = gConnection.Start();

        if (err == KErrNone) {
            gHaveConnection = ETrue;
        } else {
            /* Remember why, in case everything below fails too, then carry
             * on without it. */
            Fail(WH_NET_STAGE_CONNSTART, err);
            gConnection.Close();
        }
    } else {
        Fail(WH_NET_STAGE_CONNOPEN, err);
    }

    /* 3. No usable RConnection - sockets go on the implicit connection. */
    gNetStarted = ETrue;
    return KErrNone;
}

/* Parse "a.b.c.d" ourselves.
 *
 * TInetAddr::Input is supposed to do this, but on the device it did not: a
 * literal 192.168.1.79 fell through to the resolver, which then tried to
 * look it up as a host name and returned KErrDndNameNotFound (-5120). Doing
 * the parse here removes both the guesswork and a dependency on a resolver
 * we have no need of for a numeric address. */
static TBool ParseDottedQuad(const TDesC& aText, TUint32& aOut)
{
    TUint32 addr = 0;
    TInt i = 0;
    TInt part;

    for (part = 0; part < 4; part++) {
        TInt value = 0;
        TInt digits = 0;
        while (i < aText.Length() && aText[i] >= '0' && aText[i] <= '9') {
            value = value * 10 + (aText[i] - '0');
            if (value > 255) return EFalse;
            digits++;
            i++;
        }
        if (digits == 0 || digits > 3) return EFalse;
        addr = (addr << 8) | (TUint32)value;
        if (part < 3) {
            if (i >= aText.Length() || aText[i] != '.') return EFalse;
            i++;
        }
    }
    if (i != aText.Length()) return EFalse;

    aOut = addr;
    return ETrue;
}

/* Accepts a dotted-quad directly and falls back to DNS. Taking the literal
 * path first matters: it keeps a numeric server address working even where
 * name resolution is unavailable - which, with no access point started, is
 * exactly the situation. */
static TInt ResolveHost(const TDesC& aHost, TInetAddr& aAddr)
{
    TUint32 literal;
    if (ParseDottedQuad(aHost, literal)) {
        aAddr.SetAddress(literal);
        return KErrNone;
    }

    /* Still worth a try for IPv6 literals and anything else it handles. */
    if (aAddr.Input(aHost) == KErrNone) return KErrNone;

    RHostResolver resolver;
    TInt err = gHaveConnection
                   ? resolver.Open(gSocketServ, KAfInet, KProtocolInetUdp, gConnection)
                   : resolver.Open(gSocketServ, KAfInet, KProtocolInetUdp);
    if (err != KErrNone) {
        Fail(WH_NET_STAGE_RESOLVE, err);
        return err;
    }

    TNameEntry entry;
    TRequestStatus status;
    resolver.GetByName(aHost, entry, status);
    User::WaitForRequest(status);
    resolver.Close();

    if (status.Int() != KErrNone) {
        Fail(WH_NET_STAGE_RESOLVE, status.Int());
        return status.Int();
    }

    aAddr = TInetAddr(entry().iAddr);
    return KErrNone;
}

extern "C" int wh_net_connect(wh_conn **out, const char *host, unsigned int port)
{
    TInt slot = -1;
    for (TInt i = 0; i < WH_MAX_CONN; i++) {
        if (!gConns[i].used) { slot = i; break; }
    }
    if (slot < 0) {
        Fail(WH_NET_STAGE_NOSLOT, KErrNone);
        return -1;
    }

    gLastStage = WH_NET_STAGE_NONE;
    gLastError = KErrNone;

    if (StartNetwork() != KErrNone) return -1;

    /* The protocol layer deals in 8-bit C strings; Symbian wants a
     * descriptor. Host names here are ASCII. */
    TBuf<256> hostBuf;
    TPtrC8 hostPtr((const TUint8 *)host);
    if (hostPtr.Length() >= hostBuf.MaxLength()) return -1;
    hostBuf.Copy(hostPtr);

    TInetAddr addr;
    if (ResolveHost(hostBuf, addr) != KErrNone) return -1;
    addr.SetPort((TUint)port);

    RSocket &sock = gConns[slot].socket;
    TInt err = gHaveConnection
                   ? sock.Open(gSocketServ, KAfInet, KSockStream, KProtocolInetTcp,
                               gConnection)
                   : sock.Open(gSocketServ, KAfInet, KSockStream, KProtocolInetTcp);
    if (err != KErrNone) {
        Fail(WH_NET_STAGE_SOCKOPEN, err);
        return -1;
    }

    TRequestStatus status;
    sock.Connect(addr, status);
    User::WaitForRequest(status);
    if (status.Int() != KErrNone) {
        Fail(WH_NET_STAGE_CONNECT, status.Int());
        sock.Close();
        return -1;
    }

    /* Connected. Clear anything StartNetwork recorded on its way through the
     * fallback chain, so a later failure is not blamed on a step that was
     * survivable and survived. */
    gLastStage = WH_NET_STAGE_NONE;
    gLastError = KErrNone;

    gConns[slot].used = ETrue;
    *out = &gConns[slot];
    return 0;
}

extern "C" int wh_net_write(wh_conn *c, const unsigned char *buf, unsigned long len)
{
    /* RSocket::Write completes only when everything has been sent, so there
     * is no partial-write loop to run here. */
    TPtrC8 data(buf, (TInt)len);
    TRequestStatus status;
    c->socket.Write(data, status);
    User::WaitForRequest(status);
    return status.Int() == KErrNone ? 0 : -1;
}

/* Long, because one of these reads is legitimately spent waiting for a
 * person to type a code on the other side of the world. Its job is not to be
 * responsive; it is to make sure a stall eventually becomes a reportable
 * failure instead of an application that hangs until the phone is
 * rebooted - which is exactly what happened before this existed. */
#define WH_READ_TIMEOUT_US 180000000   /* three minutes */

extern "C" long wh_net_read(wh_conn *c, unsigned char *buf, unsigned long cap)
{
    /* RecvOneOrMore, not Read: Read waits for the buffer to fill, which
     * would deadlock a protocol that reads until it has one message. */
    TPtr8 data(buf, 0, (TInt)cap);
    TSockXfrLength received;
    TRequestStatus status;
    TRequestStatus timerStatus;
    RTimer timer;

    if (timer.CreateLocal() != KErrNone) {
        /* Without a timer we would rather read with no timeout than not at
         * all; an unbounded wait beats refusing to work. */
        c->socket.RecvOneOrMore(data, 0, status, received);
        User::WaitForRequest(status);
        if (status.Int() == KErrEof) return 0;
        if (status.Int() != KErrNone) return -1;
        return (long)received();
    }

    if (gCancelled) {
        timer.Close();
        return -1;
    }

    c->socket.RecvOneOrMore(data, 0, status, received);
    timer.After(timerStatus, WH_READ_TIMEOUT_US);

    /* Wait on the read, the timeout, and the cancel signal together. The
     * socket read is never cancelled speculatively - doing that on a timer
     * tick would risk losing bytes that had already arrived - so it is only
     * abandoned when we really are giving up. */
    {
        TRequestStatus* waits[3];
        TInt count = 2;
        waits[0] = &status;
        waits[1] = &timerStatus;
        if (gCancelPtr) waits[count++] = gCancelPtr;
        User::WaitForNRequest(waits, count);
    }

    if (status == KRequestPending) {
        /* Either the timeout or a cancel. Abandon the read and collect its
         * completion, or the outstanding request would outlive this call. */
        TBool cancelled = gCancelled ? ETrue : EFalse;
        c->socket.CancelRecv();
        User::WaitForRequest(status);
        /* Cancel always completes the request, whether or not it had already
         * fired, so the completion must always be collected. */
        timer.Cancel();
        User::WaitForRequest(timerStatus);
        timer.Close();
        if (!cancelled) Fail(WH_NET_STAGE_CONNECT, KErrTimedOut);
        return -1;
    }

    timer.Cancel();
    User::WaitForRequest(timerStatus);
    timer.Close();

    if (status.Int() == KErrEof) return 0;      /* clean close */
    if (status.Int() != KErrNone) return -1;
    return (long)received();
}

extern "C" void wh_net_close(wh_conn *c)
{
    if (c && c->used) {
        c->socket.Close();
        c->used = EFalse;
    }
}

extern "C" void wh_net_shutdown(void)
{
    /* The socket server session and the RConnection are opened once and
     * shared, so nothing else closes them. Leaving them open would survive
     * until process exit, but it also trips __UHEAP_MARKEND in a debug
     * build and holds the access point up longer than necessary. */
    for (TInt i = 0; i < WH_MAX_CONN; i++) {
        if (gConns[i].used) {
            gConns[i].socket.Close();
            gConns[i].used = EFalse;
        }
    }
    if (gNetStarted) {
        if (gHaveConnection) {
            gConnection.Close();
            gHaveConnection = EFalse;
        }
        gSocketServ.Close();
        gNetStarted = EFalse;
    }
}

extern "C" void wh_net_random(unsigned char *buf, unsigned long len)
{
    /* TRandom is the platform's cryptographic generator. Math::Random must
     * NOT be used here: it is a plain PRNG, and everything that flows
     * through this function - the SPAKE2 scalar, secretbox nonces, the
     * WebSocket masking key - is security-critical. If TRandom is ever
     * unavailable on a target, the answer is to add a real CSPRNG, not to
     * fall back to Math::Random. */
    TPtr8 ptr(buf, 0, (TInt)len);
    ptr.SetLength((TInt)len);
    TRAPD(err, TRandom::RandomL(ptr));
    if (err != KErrNone) {
        /* Failing loudly beats emitting predictable key material. */
        User::Panic(_L("whrandom"), err);
    }
}

/* TweetNaCl declares this and expects the platform to supply it. */
extern "C" void randombytes(unsigned char *buf, unsigned long long n)
{
    wh_net_random(buf, (unsigned long)n);
}
