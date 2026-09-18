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
    EJobPairing,          /* invitation delivered; exchanging names */
    EJobDone,
    EJobFailed
    };

enum TJobKind
    {
    EJobKindReceive = 0,
    EJobKindSend,
    EJobKindSendFolder,
    EJobKindSendText,
    EJobKindPairHost,     /* show a code and send the invitation through it */
    EJobKindPairJoin      /* receive an invitation over a typed code */
    };

/* Where a job has got to, for the screen. A transfer that stalls looks
 * exactly like one that died until the phone says which step it is on, and
 * there is no debugger on the other end of this - only a photograph of the
 * screen. */
enum TJobStep
    {
    EStepNone = 0,
    EStepInvitation,        /* building the pairing invitation */
    EStepConnect,           /* opening the connection to the server */
    EStepAllocate,          /* asking the server for a code */
    EStepSendInvitation,    /* delivering the invitation through it */
    EStepAwaitHandshake,    /* waiting for the other device's name */
    EStepClaim,             /* claiming the code that was typed in */
    EStepReadInvitation,    /* waiting for the invitation to arrive */
    EStepSendName           /* sending our name back */
    };

/* Stored pairings. One file in the application's private directory
 * (C:\private\e1000001\), which platform security keeps every other
 * application out of - the nearest thing S60 3rd edition has to the Android
 * Keystore or the desktop's safeStorage. */
const TInt KMaxPairs = 16;

class TWhminiPair
    {
public:
    /* What the device calls itself, as it gave it when pairing. */
    char iName[128];
    /* A local rename, shown instead of iName on this phone only. Empty means
     * there is none, and clearing one brings iName back - which is why the
     * two are kept apart. */
    char iLabel[128];
    unsigned char iSecret[32];
    };

/* What to call a pairing on screen: the rename if there is one, else the
 * name it gave. Every screen and menu goes through this. */
const char* WhminiPairLabel(const TWhminiPair& aPair);

/* Returns how many were loaded, 0 if there is no file yet. */
TInt WhminiLoadPairs(TWhminiPair* aPairs, TInt aMax);
TInt WhminiAddPair(const char* aName, const unsigned char aSecret[32]);
TInt WhminiRenamePair(TInt aIndex, const char* aLabel);
TInt WhminiRemovePair(TInt aIndex);

/* Longest message, in UTF-16 characters as typed. The wire limit is
 * WH_TEXT_MAX bytes of UTF-8 for the whole offer, and a character outside
 * ASCII costs two or three of those, so the typed limit is set well below it
 * and the byte length is checked again after conversion. */
const TInt KMaxMessageChars = 400;

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
    /* A text message, UTF-8: in when sending one, out when one arrives.
     * TJob lives on the heap (it is a member of the AppUi), so a kilobyte
     * here never touches the 8 KB worker stack. */
    char iText[1024];
    volatile TInt iIsText;        /* out: the offer was a message */
    /* A paired transfer: the wormhole is opened on the code derived from
     * this secret and the clock, instead of one typed or allocated. */
    volatile TInt iPaired;
    unsigned char iSecret[32];
    /* Paired transfers: who, in. Pairing: who we paired with, out. */
    char iPeerName[128];
    /* out: one of TJobStep, updated as the worker goes. */
    volatile TInt iStep;
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
    /* What paired devices see this phone as. */
    char iDeviceName[64];
    };

void WhminiDefaultSettings(TWhminiSettings& aSettings);
/* Strip surrounding blanks and control characters, in place. */
void WhminiTrim(char* aText);
TBool WhminiLoadSettings(TWhminiSettings& aSettings);
void WhminiSaveSettings(const TWhminiSettings& aSettings);

/* Shown in the app, and must match the version in sis/whmini.pkg. */
#define WHMINI_VERSION "v0.8.0"

#endif
