/* The worker side: settings, and the thread that actually runs a transfer.
 *
 * Nothing here touches the UI. It reports progress and outcome by writing
 * into the shared TJob, which the UI thread polls. */

#include <e32base.h>
#include <f32file.h>

#include "whmini.h"

extern "C" {
#include "../../../native/wormhole-mini/src/wordlist.h"
#include "../../../native/wormhole-mini/src/zip.h"
#include "../../../native/wormhole-mini/src/zipw.h"
#include "../../../native/wormhole-mini/src/mailbox.h"
#include "../../../native/wormhole-mini/src/xfer.h"
#include "../../../native/wormhole-mini/src/net.h"
}

static const char *const KAppId = "lothar.com/wormhole/text-or-file-xfer";

_LIT(KSettingsFile, "E:\\PortalGems\\server.txt");
_LIT(KDestDir, "E:\\PortalGems\\");
/* A folder is staged as a single archive in both directions: the offer must
 * state the archive's size before a byte goes out, and unpacking wants to
 * read the central directory at the end. */
_LIT(KStageZip, "E:\\PortalGems\\.stage.zip");

/* About 100 KB of buffers, static because Symbian gives a thread 8 KB of
 * stack and the protocol needs far more than that in one place. */
static wh_mailbox_bufs gMailboxBufs;
static wh_xfer_bufs gXferBufs;
/* Another ~100 KB of statics for folder work. Static because an 8 KB
 * Symbian thread stack cannot hold any of it, and because the core
 * allocates nothing after startup by design. */
static wh_inflate_state gInflate;
static unsigned char gZipDir[64UL * 1024UL];
/* The file-copy buffer is static rather than local because ZipTree
 * recurses: eight kilobytes per level would exhaust any thread stack worth
 * having by the third subdirectory. Only one file is read at a time, so
 * sharing it is safe. */
static TBuf8<8192> gCopyBuf;
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

struct TFileSource
    {
    RFile iFile;
    TInt iError;
    };

extern "C" long WhminiSourceRead(void* aCtx, unsigned char* aBuf,
                                 unsigned long aCap)
{
    TFileSource* src = (TFileSource*)aCtx;
    TPtr8 buf(aBuf, 0, (TInt)aCap);
    TInt err = src->iFile.Read(buf);
    if (err != KErrNone) {
        src->iError = err;
        return -1;
    }
    return (long)buf.Length();
}

/* --- folders ------------------------------------------------------------ */

/* Guards against a pathological tree, and against this recursion using more
 * of an 8 KB stack than it should. */
const TInt KMaxZipDepth = 16;

struct TZipSink
    {
    RFile iFile;
    TInt iError;
    };

extern "C" int WhminiZipOut(void* aCtx, const unsigned char* aBuf,
                            unsigned long aLen)
    {
    TZipSink* z = (TZipSink*)aCtx;
    TPtrC8 chunk(aBuf, (TInt)aLen);
    TInt err = z->iFile.Write(chunk);
    if (err != KErrNone)
        {
        z->iError = err;
        return -1;
        }
    return 0;
    }

/* Walk `aDir`, adding everything beneath it. Entry paths are relative with
 * no top-level component and directories are recorded so empty ones
 * survive, matching what the engine produces. */
static TInt ZipTree(wh_zipw& aW, RFs& aFs, const TDesC& aDir,
                    const TDesC8& aPrefix, TInt aDepth,
                    TUint& aFiles, TUint& aBytes)
    {
    CDir* dir = NULL;
    TInt err;
    TInt i;

    if (aDepth > KMaxZipDepth) return KErrOverflow;

    err = aFs.GetDir(aDir, KEntryAttNormal | KEntryAttDir, ESortByName, dir);
    if (err != KErrNone) return err;

    for (i = 0; i < dir->Count(); i++)
        {
        const TEntry& e = (*dir)[i];
        TFileName path;
        TBuf8<256> rel;

        if (aDir.Length() + e.iName.Length() + 2 > path.MaxLength())
            {
            delete dir;
            return KErrOverflow;
            }
        path.Copy(aDir);
        path.Append(e.iName);

        if (aPrefix.Length() + e.iName.Length() + 2 > rel.MaxLength())
            {
            delete dir;
            return KErrOverflow;
            }
        rel.Copy(aPrefix);
        rel.Append(e.iName);

        if (e.IsDir())
            {
            TBuf8<258> dirEntry;
            path.Append('\\');
            dirEntry.Copy(rel);
            dirEntry.Append('/');
            dirEntry.Append(TChar(0));      /* NUL for the C API */

            if (wh_zipw_add_dir(&aW, (const char*)dirEntry.Ptr()) != WH_ZIPW_OK)
                {
                delete dir;
                return KErrGeneral;
                }
            {
                TBuf8<258> subPrefix;
                subPrefix.Copy(rel);
                subPrefix.Append('/');
                err = ZipTree(aW, aFs, path, subPrefix, aDepth + 1, aFiles, aBytes);
            }
            if (err != KErrNone)
                {
                delete dir;
                return err;
                }
            }
        else
            {
            RFile f;
            TBuf8<257> name;

            name.Copy(rel);
            name.Append(TChar(0));

            err = f.Open(aFs, path, EFileRead | EFileShareReadersOnly);
            if (err != KErrNone) { delete dir; return err; }

            if (wh_zipw_begin_file(&aW, (const char*)name.Ptr()) != WH_ZIPW_OK)
                {
                f.Close();
                delete dir;
                return KErrGeneral;
                }
            for (;;)
                {
                err = f.Read(gCopyBuf);
                if (err != KErrNone) break;
                if (gCopyBuf.Length() == 0) break;
                if (wh_zipw_write(&aW, gCopyBuf.Ptr(),
                                  (unsigned long)gCopyBuf.Length()) != WH_ZIPW_OK)
                    {
                    err = KErrGeneral;
                    break;
                    }
                aBytes += (TUint)gCopyBuf.Length();
                }
            f.Close();
            if (err != KErrNone) { delete dir; return err; }
            if (wh_zipw_end_file(&aW) != WH_ZIPW_OK) { delete dir; return KErrGeneral; }
            aFiles++;
            }
        }

    delete dir;
    return KErrNone;
    }

/* Zip entry names use '/' and are 8-bit; Symbian paths use '\\' and are
 * 16-bit. Also refuses anything wh_zip_name_is_safe would not accept, so a
 * hostile archive cannot write outside the destination. */
static TInt EntryToPath(const char* aName, const TDesC& aDest, TFileName& aOut)
    {
    TPtrC8 name8((const TUint8*)aName);
    TInt i;

    if (!wh_zip_name_is_safe(aName)) return KErrBadName;
    if (aDest.Length() + name8.Length() + 1 > aOut.MaxLength()) return KErrOverflow;

    aOut.Copy(aDest);
    for (i = 0; i < name8.Length(); i++)
        {
        TChar c = (TChar)name8[i];
        aOut.Append(c == '/' ? TChar('\\') : c);
        }
    return KErrNone;
    }

struct TUnpackSink
    {
    RFile iFile;
    TUint iWritten;
    TUint iCap;
    TInt iError;
    };

extern "C" int WhminiUnpackOut(void* aCtx, const unsigned char* aBuf,
                               unsigned long aLen)
    {
    TUnpackSink* u = (TUnpackSink*)aCtx;
    TPtrC8 chunk(aBuf, (TInt)aLen);
    TInt err;

    if (u->iWritten + aLen > u->iCap)
        {
        /* Past what the offer claimed, by a wide margin: a zip bomb, not
         * rounding error. */
        u->iError = KErrTooBig;
        return -1;
        }
    err = u->iFile.Write(chunk);
    if (err != KErrNone)
        {
        u->iError = err;
        return -1;
        }
    u->iWritten += (TUint)aLen;
    return 0;
    }

extern "C" long WhminiZipFileRead(void* aCtx, unsigned long aOffset,
                                  unsigned char* aBuf, unsigned long aLen)
    {
    RFile* f = (RFile*)aCtx;
    TPtr8 p(aBuf, 0, (TInt)aLen);
    if (f->Read((TInt)aOffset, p, (TInt)aLen) != KErrNone) return -1;
    return (long)p.Length();
    }

/* Unpack the staged archive into `aDest`. Returns the number of files. */
static TInt UnpackStaged(RFs& aFs, const TDesC& aDest, TUint aCap, TInt& aFiles)
    {
    RFile zf;
    wh_zip zip;
    wh_zip_iter it;
    wh_zip_entry entry;
    TInt size = 0;
    TInt rc;
    TUint total = 0;

    aFiles = 0;
    if (zf.Open(aFs, KStageZip, EFileRead | EFileShareReadersOnly) != KErrNone)
        {
        return KErrNotFound;
        }
    if (zf.Size(size) != KErrNone) { zf.Close(); return KErrGeneral; }

    if (wh_zip_open(&zip, WhminiZipFileRead, &zf, (unsigned long)size) != WH_ZIP_OK)
        {
        zf.Close();
        return KErrCorrupt;
        }

    aFs.MkDirAll(aDest);

    rc = wh_zip_first(&zip, &it, &entry);
    while (rc == WH_ZIP_OK)
        {
        TFileName path;
        TInt err = EntryToPath(entry.name, aDest, path);
        if (err != KErrNone) { zf.Close(); return err; }

        if (entry.is_dir)
            {
            aFs.MkDirAll(path);
            }
        else
            {
            TUnpackSink sink;
            aFs.MkDirAll(path);          /* creates the parent chain */
            sink.iWritten = 0;
            sink.iCap = aCap > total ? aCap - total : 0;
            sink.iError = KErrNone;
            if (sink.iFile.Replace(aFs, path, EFileWrite) != KErrNone)
                {
                zf.Close();
                return KErrWrite;
                }
            if (wh_zip_extract(&zip, &entry, &gInflate, WhminiUnpackOut, &sink)
                    != WH_ZIP_OK)
                {
                sink.iFile.Close();
                zf.Close();
                return sink.iError != KErrNone ? sink.iError : KErrCorrupt;
                }
            sink.iFile.Close();
            total += sink.iWritten;
            aFiles++;
            }
        rc = wh_zip_next(&zip, &it, &entry);
        }

    zf.Close();
    return rc < 0 ? KErrCorrupt : KErrNone;
    }

static void Finish(TJob* aJob, TInt aState, const char* aMessage)
{
    /* "You stopped this" and "this went wrong" deserve different words, and
     * only the platform layer knows which happened. */
    if (aState == EJobFailed && wh_net_cancelled()) aMessage = "Cancelled";
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

    /* Which mailbox we ended up in. Two peers that never meet are almost
     * always in different mailboxes, and without this there is no way to
     * see that from the phone. */
    CopyCStr(aJob->iNameplate, sizeof(aJob->iNameplate), mailbox.nameplate);
    CopyCStr(aJob->iMailbox, sizeof(aJob->iMailbox), mailbox.mailbox);

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
    /* A folder arrives as one archive, staged and then unpacked. Only the
     * name check below differs: a folder's name is its own, a file's comes
     * from the offer. */
    if (offer.is_directory) {
        CopyCStr(offer.filename, sizeof(offer.filename), offer.dirname);
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

        if (offer.is_directory) {
            path.Copy(KStageZip);
        } else {
            nameBuf.Copy(TPtrC8((const TUint8*)offer.filename));
            path.Append(nameBuf);
        }

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

        if (rc == 0 && offer.is_directory) {
            TFileName dest(KDestDir);
            TInt files = 0;
            TInt err;

            aJob->iState = EJobUnpacking;
            nameBuf.Copy(TPtrC8((const TUint8*)offer.dirname));
            dest.Append(nameBuf);
            dest.Append('\\');

            err = UnpackStaged(fs, dest, (TUint)wh_unpack_cap(offer.num_bytes),
                               files);
            fs.Delete(KStageZip);
            if (err != KErrNone) {
                fs.Close();
                Finish(aJob, EJobFailed,
                       err == KErrTooBig ? "Archive is larger than it claimed"
                                         : "Could not unpack the folder");
                wh_mailbox_close(&mailbox, "errory");
                return;
            }
            aJob->iDone = (TUint)files;
        }
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

/* Send: allocate a code, publish it for the UI to display, then wait for
 * whoever types it. The wait is inside wh_mailbox_pake and can be long -
 * which is exactly why this runs on its own thread. */
static void RunSendJob(TJob* aJob)
{
    wh_mailbox mailbox;
    RFs fs;
    TFileSource source;
    TFileName path;
    char code[WH_CODE_MAX];
    char name[128];
    TInt size = 0;
    TInt rc;

    TBool folder = (aJob->iKind == EJobKindSendFolder);
    TUint numFiles = 0;
    TUint numBytes = 0;

    aJob->iState = EJobConnecting;

    path.Copy(TPtrC8((const TUint8*)aJob->iPath));

    if (fs.Connect() != KErrNone) {
        Finish(aJob, EJobFailed, "Cannot open the file system");
        return;
    }

    if (folder) {
        /* Build the archive first: the offer has to state its size before a
         * byte of it goes out. */
        wh_zipw w;
        TZipSink zsink;
        TInt err;

        aJob->iState = EJobZipping;

        if (path.Length() && path[path.Length() - 1] != '\\') path.Append('\\');

        fs.MkDirAll(KStageZip);
        zsink.iError = KErrNone;
        if (zsink.iFile.Replace(fs, KStageZip, EFileWrite) != KErrNone) {
            fs.Close();
            Finish(aJob, EJobFailed, "Cannot stage the archive");
            return;
        }
        wh_zipw_init(&w, WhminiZipOut, &zsink, gZipDir, sizeof(gZipDir));
        err = ZipTree(w, fs, path, KNullDesC8, 0, numFiles, numBytes);
        if (err == KErrNone && wh_zipw_finish(&w) != WH_ZIPW_OK) err = KErrGeneral;
        zsink.iFile.Close();

        if (err != KErrNone) {
            fs.Delete(KStageZip);
            fs.Close();
            Finish(aJob, EJobFailed,
                   err == KErrOverflow ? "Folder is nested too deeply"
                                       : "Could not build the archive");
            return;
        }
        if (numFiles == 0) {
            fs.Delete(KStageZip);
            fs.Close();
            Finish(aJob, EJobFailed, "That folder is empty");
            return;
        }

        /* The offer carries the folder's own name, not the staging file's. */
        {
            TInt end = path.Length() - 1;          /* skip the trailing '\\' */
            TInt start = end - 1;
            TInt i;
            while (start >= 0 && path[start] != '\\' && path[start] != ':') start--;
            start++;
            name[0] = '\0';
            for (i = 0; start + i < end && i < (TInt)sizeof(name) - 1; i++) {
                name[i] = (char)path[start + i];
            }
            name[i] = '\0';
        }

        path.Copy(KStageZip);
    }
    source.iError = KErrNone;
    if (source.iFile.Open(fs, path, EFileRead | EFileShareReadersOnly) != KErrNone) {
        fs.Close();
        Finish(aJob, EJobFailed, "Cannot open that file");
        return;
    }
    if (source.iFile.Size(size) != KErrNone || size <= 0) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "That file is empty or unreadable");
        return;
    }

    /* Offer the bare name, never the path it happened to come from. A
     * folder already named itself above. */
    if (!folder) {
        TParsePtrC parse(path);
        TPtrC leaf = parse.NameAndExt();
        TInt i;
        for (i = 0; i < leaf.Length() && i < (TInt)sizeof(name) - 1; i++) {
            name[i] = (char)leaf[i];
        }
        name[i] = '\0';
    }
    CopyCStr(aJob->iFileName, KJobTextLen, name);
    aJob->iTotal = (TUint)size;

    wh_mailbox_init(&mailbox, &gMailboxBufs);

    if (wh_mailbox_connect(&mailbox, gSettings.iMailboxHost, gSettings.iMailboxPort,
                           gSettings.iMailboxPath, KAppId) != 0) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "Could not reach the server");
        return;
    }

    if (wh_mailbox_allocate(&mailbox, code, sizeof(code)) != 0) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "Could not get a code");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    CopyCStr(aJob->iCode, sizeof(aJob->iCode), code);
    CopyCStr(aJob->iNameplate, sizeof(aJob->iNameplate), mailbox.nameplate);
    aJob->iCodeReady = 1;
    aJob->iState = EJobShowingCode;

    if (wh_mailbox_pake(&mailbox, KAppId, code) != 0) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "Handshake failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    rc = wh_mailbox_version(&mailbox);
    if (rc == -2) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "The other side used a wrong code");
        wh_mailbox_close(&mailbox, "scary");
        return;
    }
    if (rc != 0) {
        source.iFile.Close();
        fs.Close();
        Finish(aJob, EJobFailed, "Handshake failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    aJob->iState = EJobSending;

    if (folder) {
        rc = wh_xfer_send_folder(&mailbox, KAppId, name, (unsigned long)size,
                                 (unsigned long)numFiles, (unsigned long)numBytes,
                                 gSettings.iRelayHost, gSettings.iRelayPort,
                                 &gXferBufs, WhminiSourceRead, &source,
                                 WhminiProgress, NULL);
    } else {
        rc = wh_xfer_send_file(&mailbox, KAppId, name, (unsigned long)size,
                               gSettings.iRelayHost, gSettings.iRelayPort,
                               &gXferBufs, WhminiSourceRead, &source,
                               WhminiProgress, NULL);
    }
    source.iFile.Close();
    if (folder) fs.Delete(KStageZip);
    fs.Close();

    if (rc == -2) {
        Finish(aJob, EJobFailed, "The other side declined");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }
    if (rc == -3) {
        Finish(aJob, EJobFailed, "Checksum mismatch");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }
    if (rc != 0) {
        Finish(aJob, EJobFailed, "Transfer failed");
        wh_mailbox_close(&mailbox, "errory");
        return;
    }

    Finish(aJob, EJobDone, "Sent, and confirmed by the other side");
    wh_mailbox_close(&mailbox, "happy");
}

TInt WhminiWorker(TAny* aPtr)
{
    TJob* job = (TJob*)aPtr;
    CTrapCleanup* cleanup = CTrapCleanup::New();

    gJob = job;
    wh_net_cancel_arm();
    WhminiLoadSettings(gSettings);

    if (cleanup) {
        TRAPD(err, job->iKind == EJobKindReceive ? RunJob(job)
                                                 : RunSendJob(job));
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
