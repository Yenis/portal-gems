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
    EJobWaitingForPeer,
    EJobReceiving,
    EJobDone,
    EJobFailed
    };

const TInt KJobTextLen = 128;

class TJob
    {
public:
    volatile TInt iState;
    volatile TInt iStage;         /* WH_NET_STAGE_* on failure */
    volatile TInt iError;         /* Symbian error code on failure */
    volatile TUint iDone;         /* bytes received */
    volatile TUint iTotal;        /* bytes expected */
    char iCode[64];               /* in: the wormhole code */
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
    };

void WhminiDefaultSettings(TWhminiSettings& aSettings);
/* Strip surrounding blanks and control characters, in place. */
void WhminiTrim(char* aText);
TBool WhminiLoadSettings(TWhminiSettings& aSettings);
void WhminiSaveSettings(const TWhminiSettings& aSettings);

#endif
