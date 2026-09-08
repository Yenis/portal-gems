/* Shared declarations for the PortalGems Symbian application.
 *
 * The transfer runs on a worker thread, not the UI thread. This is not
 * decoration: the portable core is synchronous, and the platform layer
 * waits with User::WaitForRequest. Calling that on a thread with a running
 * active scheduler consumes completions belonging to active objects and
 * corrupts the scheduler's accounting. A plain thread has no scheduler, so
 * the blocking style is correct there.
 *
 * The two threads share one TJob. Only simple word-sized fields cross the
 * boundary and only one side writes each of them, so no locking is needed;
 * the UI polls with a timer rather than being signalled. */
#ifndef WHMINI_H
#define WHMINI_H

#include <e32base.h>

enum TJobState
    {
    EJobIdle = 0,
    EJobConnecting,
    EJobShowingCode,      /* sending: the code is up, waiting to be typed */
    EJobWaitingForPeer,
    EJobReceiving,
    EJobUnpacking,        /* the archive is down; writing the files out */
    EJobZipping,          /* building the archive before a folder send */
    EJobSending,
    EJobDone,
    EJobFailed
    };

enum TJobKind
    {
    EJobKindReceive = 0,
    EJobKindSend,
    EJobKindSendFolder
    };

const TInt KJobTextLen = 128;

class TJob
    {
public:
    volatile TInt iKind;          /* in: TJobKind */
    volatile TInt iState;
    /* Set only after iCode has been fully written, so the UI never shows a
     * half-built code. */
    volatile TInt iCodeReady;
    volatile TInt iStage;         /* WH_NET_STAGE_* on failure */
    volatile TInt iError;         /* Symbian error code on failure */
    volatile TInt iRoute;         /* WH_ROUTE_* once the transit is up */
    volatile TUint iDone;         /* bytes received */
    volatile TUint iTotal;        /* bytes expected */
    char iCode[64];               /* receive: in. send: out, once ready. */
    char iPath[256];              /* send: in, the file to send */
    char iNameplate[32];          /* out: the nameplate actually claimed */
    char iMailbox[64];            /* out: the mailbox the server named */
    char iMessage[KJobTextLen];   /* out: what happened */
    char iFileName[KJobTextLen];  /* out: what arrived */
    };

/* Worker thread entry point. aPtr is a TJob*. */
TInt WhminiWorker(TAny* aPtr);

/* Settings, read from and written to E:\PortalGems\server.txt. */
class TWhminiSettings
    {
public:
    char iMailboxHost[64];
    TUint iMailboxPort;
    char iMailboxPath[32];
    char iRelayHost[64];
    TUint iRelayPort;
    /* Direct connections are off until they have been shown to work on this
     * phone. The relay is slower and always works; a fast path that hangs
     * is worse than a slow one that does not. */
    TInt iDirect;
    };

void WhminiDefaultSettings(TWhminiSettings& aSettings);
/* Strip surrounding blanks and control characters, in place. */
void WhminiTrim(char* aText);
TBool WhminiLoadSettings(TWhminiSettings& aSettings);
void WhminiSaveSettings(const TWhminiSettings& aSettings);

/* Shown in the app, and must match the version in sis/whmini.pkg. */
#define WHMINI_VERSION "v0.5.3"

#endif
