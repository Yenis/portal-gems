/* The worker side: settings, and the thread that actually runs a transfer.
 *
 * Nothing here touches the UI. It reports progress and outcome by writing
 * into the shared TJob, which the UI thread polls. */

#include <e32base.h>
#include <f32file.h>

#include "whmini.h"

extern "C" {
#include "../../../native/wormhole-mini/src/mailbox.h"
#include "../../../native/wormhole-mini/src/xfer.h"
#include "../../../native/wormhole-mini/src/net.h"
}

static const char *const KAppId = "lothar.com/wormhole/text-or-file-xfer";

_LIT(KSettingsFile, "E:\\PortalGems\\server.txt");
_LIT(KDestDir, "E:\\PortalGems\\");

/* About 100 KB of buffers, static because Symbian gives a thread 8 KB of
 * stack and the protocol needs far more than that in one place. */
static wh_mailbox_bufs gMailboxBufs;
static wh_xfer_bufs gXferBufs;
static TWhminiSettings gSettings;
static TJob* gJob;

/* --- small string helpers; there is no C library on this target --------- */

static void CopyCStr(char* aDst, TInt aCap, const char* aSrc)
{
    TInt i = 0;
    while (aSrc[i] && i < aCap - 1) { aDst[i] = aSrc[i]; i++; }
    aDst[i] = '\0';
}

/* Strip leading and trailing blanks and control characters.
 *
 * A host is compared byte for byte by the address parser, so one trailing
 * space - invisible on screen, easy to type on a phone, and preserved by
 * every layer in between - turns a literal address into something that
 * falls through to DNS and fails with KErrDndNameNotFound. Trim once, here,
 * where every host string arrives. */
static void TrimInPlace(char* aText)
{
    TInt start = 0;
    TInt end;
    TInt i;

    while (aText[start] && (unsigned char)aText[start] <= ' ') start++;

    end = start;
    for (i = start; aText[i]; i++) {
        if ((unsigned char)aText[i] > ' ') end = i + 1;
    }

    for (i = 0; start + i < end; i++) aText[i] = aText[start + i];
    aText[end - start] = '\0';
}

static TBool SameStr(const char* aA, const char* aB)
{
    TInt i = 0;
    while (aA[i] && aA[i] == aB[i]) i++;
    return aA[i] == '\0' && aB[i] == '\0';
}

static TUint ParseUint(const char* aText, TUint aFallback)
{
    TUint v = 0;
    TInt i = 0;
    if (aText[0] < '0' || aText[0] > '9') return aFallback;
    while (aText[i] >= '0' && aText[i] <= '9') {
        v = v * 10 + (TUint)(aText[i] - '0');
        i++;
    }
    return v;
}

/* --- settings ----------------------------------------------------------- */

void WhminiTrim(char* aText)
{
    TrimInPlace(aText);
}

void WhminiDefaultSettings(TWhminiSettings& aSettings)
{
    aSettings.iMailboxHost[0] = '\0';
    aSettings.iMailboxPort = 4000;
    CopyCStr(aSettings.iMailboxPath, sizeof(aSettings.iMailboxPath), "/v1");
    aSettings.iRelayHost[0] = '\0';
    aSettings.iRelayPort = 4001;
}

static void ApplySetting(TWhminiSettings& aS, const char* aKey, const char* aValue)
{
    if (SameStr(aKey, "mailbox_host")) {
        CopyCStr(aS.iMailboxHost, sizeof(aS.iMailboxHost), aValue);
        TrimInPlace(aS.iMailboxHost);
    }
    else if (SameStr(aKey, "mailbox_port")) aS.iMailboxPort = ParseUint(aValue, 4000);
    else if (SameStr(aKey, "mailbox_path")) CopyCStr(aS.iMailboxPath, sizeof(aS.iMailboxPath), aValue);
    else if (SameStr(aKey, "relay_host")) {
        CopyCStr(aS.iRelayHost, sizeof(aS.iRelayHost), aValue);
        TrimInPlace(aS.iRelayHost);
    }
    else if (SameStr(aKey, "relay_port")) aS.iRelayPort = ParseUint(aValue, 4001);
}

TBool WhminiLoadSettings(TWhminiSettings& aSettings)
{
    RFs fs;
    RFile file;
    TBuf8<1024> raw;
    TInt i = 0;

    WhminiDefaultSettings(aSettings);
    if (fs.Connect() != KErrNone) return EFalse;
    if (file.Open(fs, KSettingsFile, EFileRead) != KErrNone) {
        fs.Close();
        return EFalse;
    }
    TInt err = file.Read(raw);
    file.Close();
    fs.Close();
    if (err != KErrNone) return EFalse;

    while (i < raw.Length()) {
        char key[32];
        char value[80];
        TInt k = 0, v = 0;
        while (i < raw.Length() && raw[i] != '=' && raw[i] != '\n' && raw[i] != '\r') {
            if (k < (TInt)sizeof(key) - 1) key[k++] = (char)raw[i];
            i++;
        }
        key[k] = '\0';
        TrimInPlace(key);
        if (i < raw.Length() && raw[i] == '=') {
            i++;
            while (i < raw.Length() && raw[i] != '\n' && raw[i] != '\r') {
                if (v < (TInt)sizeof(value) - 1) value[v++] = (char)raw[i];
                i++;
            }
        }
        value[v] = '\0';
        if (k > 0) ApplySetting(aSettings, key, value);
        while (i < raw.Length() && (raw[i] == '\n' || raw[i] == '\r')) i++;
    }
    return aSettings.iMailboxHost[0] != '\0';
}

void WhminiSaveSettings(const TWhminiSettings& aSettings)
{
    RFs fs;
    RFile file;
    TBuf8<512> out;

    if (fs.Connect() != KErrNone) return;
    fs.MkDirAll(KSettingsFile);
    if (file.Replace(fs, KSettingsFile, EFileWrite) != KErrNone) {
        fs.Close();
        return;
    }

    out.Append(_L8("mailbox_host="));
    out.Append(TPtrC8((const TUint8*)aSettings.iMailboxHost));
    out.Append(_L8("\nmailbox_port="));
    out.AppendNum((TInt)aSettings.iMailboxPort);
    out.Append(_L8("\nmailbox_path="));
    out.Append(TPtrC8((const TUint8*)aSettings.iMailboxPath));
    out.Append(_L8("\nrelay_host="));
    out.Append(TPtrC8((const TUint8*)aSettings.iRelayHost));
    out.Append(_L8("\nrelay_port="));
    out.AppendNum((TInt)aSettings.iRelayPort);
    out.Append(_L8("\n"));

    file.Write(out);
    file.Close();
    fs.Close();
}

/* --- the transfer ------------------------------------------------------- */

struct TFileSink
    {
    RFile iFile;
    TInt iError;
    };

extern "C" int WhminiSinkWrite(void* aCtx, const unsigned char* aData,
                               unsigned long aLen)
{
    TFileSink* sink = (TFileSink*)aCtx;
    TPtrC8 chunk(aData, (TInt)aLen);
    TInt err = sink->iFile.Write(chunk);
    if (err != KErrNone) {
        sink->iError = err;
        return -1;
    }
    return 0;
}

extern "C" void WhminiProgress(void* aCtx, unsigned long aDone, unsigned long aTotal)
{
    (void)aCtx;
    if (gJob) {
        gJob->iDone = (TUint)aDone;
        gJob->iTotal = (TUint)aTotal;
    }
}

static void Finish(TJob* aJob, TInt aState, const char* aMessage)
{
    CopyCStr(aJob->iMessage, KJobTextLen, aMessage);
    aJob->iStage = wh_net_last_stage();
    aJob->iError = (TInt)wh_net_last_error();
    aJob->iState = aState;
}

static void RunJob(TJob* aJob)
{
    wh_mailbox mailbox;
    wh_offer offer;
    TInt rc;

    aJob->iState = EJobConnecting;

    wh_mailbox_init(&mailbox, &gMailboxBufs);

    if (wh_mailbox_connect(&mailbox, gSettings.iMailboxHost, gSettings.iMailboxPort,
                           gSettings.iMailboxPath, KAppId) != 0) {
        Finish(aJob, EJobFailed, "Could not reach the server");
        return;
    }
    if (wh_mailbox_claim(&mailbox, aJob->iCode) != 0) {
        Finish(aJob, EJobFailed, "That code is not waiting on this server");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    aJob->iState = EJobWaitingForPeer;

    if (wh_mailbox_pake(&mailbox, KAppId, aJob->iCode) != 0) {
        Finish(aJob, EJobFailed, "Handshake failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    rc = wh_mailbox_version(&mailbox);
    if (rc == -2) {
        Finish(aJob, EJobFailed, "Wrong code");
        wh_mailbox_close(&mailbox, "scary");
        return;
    }
    if (rc != 0) {
        Finish(aJob, EJobFailed, "Handshake failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    if (wh_xfer_await_offer(&mailbox, gSettings.iRelayHost, gSettings.iRelayPort,
                            &offer) != 0) {
        Finish(aJob, EJobFailed, "No usable offer");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }
    if (offer.is_directory) {
        wh_xfer_reject(&mailbox, "this client can only receive single files");
        Finish(aJob, EJobFailed, "Folders are not supported yet");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    /* The name comes off the network. Refuse anything with a path separator
     * or a drive letter rather than trying to clean it up. */
    {
        const char* n = offer.filename;
        TInt i;
        if (n[0] == '\0') {
            Finish(aJob, EJobFailed, "Bad file name");
            wh_mailbox_close(&mailbox, "errory");
            return;
        }
        for (i = 0; n[i]; i++) {
            if (n[i] == '/' || n[i] == '\\' || n[i] == ':') {
                wh_xfer_reject(&mailbox, "bad filename");
                Finish(aJob, EJobFailed, "Refused a suspicious file name");
                wh_mailbox_close(&mailbox, "errory");
                return;
            }
        }
    }

    CopyCStr(aJob->iFileName, KJobTextLen, offer.filename);
    aJob->iTotal = (TUint)offer.filesize;
    aJob->iState = EJobReceiving;

    {
        RFs fs;
        TFileSink sink;
        TFileName path(KDestDir);
        TBuf<256> nameBuf;

        if (fs.Connect() != KErrNone) {
            Finish(aJob, EJobFailed, "Cannot open the file system");
            wh_mailbox_close(&mailbox, "errory");
            return;
        }
        fs.MkDirAll(KDestDir);
        nameBuf.Copy(TPtrC8((const TUint8*)offer.filename));
        path.Append(nameBuf);

        sink.iError = KErrNone;
        if (sink.iFile.Replace(fs, path, EFileWrite) != KErrNone) {
            fs.Close();
            Finish(aJob, EJobFailed, "Cannot write to the memory card");
            wh_mailbox_close(&mailbox, "errory");
            return;
        }

        rc = wh_xfer_accept(&mailbox, KAppId, &offer,
                            gSettings.iRelayHost, gSettings.iRelayPort,
                            &gXferBufs, WhminiSinkWrite, &sink,
                            WhminiProgress, NULL);
        sink.iFile.Close();
        fs.Close();
    }

    if (rc != 0) {
        Finish(aJob, EJobFailed, "Transfer failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    Finish(aJob, EJobDone, "Saved to E:\\PortalGems\\");
    wh_mailbox_close(&mailbox, "happy");
}

TInt WhminiWorker(TAny* aPtr)
{
    TJob* job = (TJob*)aPtr;
    CTrapCleanup* cleanup = CTrapCleanup::New();

    gJob = job;
    WhminiLoadSettings(gSettings);

    if (cleanup) {
        TRAPD(err, RunJob(job));
        if (err != KErrNone && job->iState != EJobFailed) {
            Finish(job, EJobFailed, "Unexpected error");
            job->iError = err;
        }
        delete cleanup;
    } else {
        Finish(job, EJobFailed, "Out of memory");
    }

    wh_net_shutdown();
    gJob = NULL;
    return KErrNone;
}
