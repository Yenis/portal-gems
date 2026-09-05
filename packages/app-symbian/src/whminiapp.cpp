/* Minimal Avkon application.
 *
 * Exists for one reason: a text console on this phone has no FEP, so the
 * keys carrying a printed number arrive as digits and a wormhole code
 * cannot be typed at all. CAknTextQueryDialog is a real editor with real
 * input handling, and the Avkon font is legible.
 *
 * The transfer runs on a worker thread (see whminiengine.cpp) because the
 * protocol code blocks with User::WaitForRequest, which must not happen on
 * a thread running an active scheduler. The UI polls the shared TJob. */

#include <e32base.h>
#include <coecntrl.h>
#include <eikenv.h>
#include <eikstart.h>
#include <aknapp.h>
#include <akndoc.h>
#include <aknappui.h>
#include <aknquerydialog.h>
#include <aknnotewrappers.h>
#include <avkon.hrh>
#include <avkon.rsg>
#include <whmini.rsg>

#include "whmini.hrh"
#include "whmini.h"

extern "C" {
#include "../../../native/wormhole-mini/src/net.h"
}

const TUid KUidWhminiApp = { 0xE1000001 };
const TInt KPollInterval = 250000;   /* microseconds */
const TInt KMaxLines = 7;
const TInt KWorkerStackSize = 32768;

/* --- the view ----------------------------------------------------------- */

class CWhminiContainer : public CCoeControl
    {
public:
    void ConstructL(const TRect& aRect);
    ~CWhminiContainer();
    void SetLine(TInt aIndex, const TDesC& aText);
    void ClearLines();
private:
    void Draw(const TRect& aRect) const;
    TBuf<64> iLines[KMaxLines];
    };

void CWhminiContainer::ConstructL(const TRect& aRect)
    {
    CreateWindowL();
    ClearLines();
    SetRect(aRect);
    ActivateL();
    }

CWhminiContainer::~CWhminiContainer()
    {
    }

void CWhminiContainer::ClearLines()
    {
    for (TInt i = 0; i < KMaxLines; i++) iLines[i].Zero();
    }

void CWhminiContainer::SetLine(TInt aIndex, const TDesC& aText)
    {
    if (aIndex < 0 || aIndex >= KMaxLines) return;
    iLines[aIndex] = aText.Left(iLines[aIndex].MaxLength());
    }

void CWhminiContainer::Draw(const TRect& aRect) const
    {
    CWindowGc& gc = SystemGc();
    const CFont* font = iEikonEnv->NormalFont();

    gc.SetPenStyle(CGraphicsContext::ENullPen);
    gc.SetBrushColor(KRgbWhite);
    gc.SetBrushStyle(CGraphicsContext::ESolidBrush);
    gc.DrawRect(aRect);

    gc.SetPenStyle(CGraphicsContext::ESolidPen);
    gc.SetPenColor(KRgbBlack);
    gc.UseFont(font);

    TInt lineHeight = font->HeightInPixels() + 4;
    TInt y = Rect().iTl.iY + lineHeight + 2;
    for (TInt i = 0; i < KMaxLines; i++)
        {
        if (iLines[i].Length())
            gc.DrawText(iLines[i], TPoint(Rect().iTl.iX + 4, y));
        y += lineHeight;
        }

    gc.DiscardFont();
    }

/* --- the app ui --------------------------------------------------------- */

class CWhminiAppUi : public CAknAppUi
    {
public:
    void ConstructL();
    ~CWhminiAppUi();
private:
    void HandleCommandL(TInt aCommand);
    void StartReceiveL();
    void AskForServerL();
    void Refresh();
    static TInt Tick(TAny* aSelf);

    CWhminiContainer* iContainer;
    CPeriodic* iTimer;
    RThread iWorker;
    TBool iWorkerRunning;
    TJob iJob;
    TWhminiSettings iSettings;
    };

void CWhminiAppUi::ConstructL()
    {
    BaseConstructL(EAknEnableSkin);

    iContainer = new (ELeave) CWhminiContainer;
    iContainer->SetMopParent(this);
    iContainer->ConstructL(ClientRect());
    AddToStackL(iContainer);

    iTimer = CPeriodic::NewL(CActive::EPriorityStandard);

    iJob.iState = EJobIdle;
    iJob.iDone = 0;
    iJob.iTotal = 0;
    iJob.iMessage[0] = '\0';
    iJob.iFileName[0] = '\0';
    iWorkerRunning = EFalse;

    WhminiLoadSettings(iSettings);
    Refresh();
    }

CWhminiAppUi::~CWhminiAppUi()
    {
    if (iTimer)
        {
        iTimer->Cancel();
        delete iTimer;
        }
    if (iWorkerRunning) iWorker.Close();
    if (iContainer)
        {
        RemoveFromStack(iContainer);
        delete iContainer;
        }
    }

/* Redraw the whole status area from the job. Cheap enough to do wholesale
 * rather than track what changed. */
void CWhminiAppUi::Refresh()
    {
    TBuf<64> line;

    iContainer->ClearLines();
    iContainer->SetLine(0, _L("PortalGems"));

    if (iSettings.iMailboxHost[0] == '\0')
        {
        iContainer->SetLine(2, _L("No server set."));
        iContainer->SetLine(3, _L("Options > Set server"));
        iContainer->DrawNow();
        return;
        }

    TBuf<64> host;
    host.Copy(TPtrC8((const TUint8*)iSettings.iMailboxHost));
    line.Format(_L("Server: %S"), &host);
    iContainer->SetLine(1, line);

    switch (iJob.iState)
        {
        case EJobIdle:
            iContainer->SetLine(3, _L("Options > Receive file"));
            break;
        case EJobConnecting:
            iContainer->SetLine(3, _L("Connecting..."));
            break;
        case EJobWaitingForPeer:
            iContainer->SetLine(3, _L("Waiting for sender..."));
            break;
        case EJobReceiving:
            {
            TBuf<64> name;
            name.Copy(TPtrC8((const TUint8*)iJob.iFileName));
            iContainer->SetLine(3, name);
            TUint pct = iJob.iTotal ? (iJob.iDone * 100 / iJob.iTotal) : 0;
            line.Format(_L("%u%%  (%u / %u bytes)"), pct, iJob.iDone, iJob.iTotal);
            iContainer->SetLine(4, line);
            break;
            }
        case EJobDone:
            {
            TBuf<64> name;
            name.Copy(TPtrC8((const TUint8*)iJob.iFileName));
            iContainer->SetLine(3, _L("Received:"));
            iContainer->SetLine(4, name);
            iContainer->SetLine(5, _L("Saved to E:\\PortalGems\\"));
            break;
            }
        case EJobFailed:
            {
            TBuf<64> msg;
            msg.Copy(TPtrC8((const TUint8*)iJob.iMessage));
            iContainer->SetLine(3, msg);
            if (iJob.iError != 0)
                {
                line.Format(_L("stage %d, error %d"), iJob.iStage, iJob.iError);
                iContainer->SetLine(4, line);
                }
            /* Bracket the host and give its length: a stray space is
             * otherwise invisible and looks like a network fault. */
            TBuf<64> h;
            h.Copy(TPtrC8((const TUint8*)iSettings.iMailboxHost));
            line.Format(_L("host [%S] len %d"), &h, h.Length());
            iContainer->SetLine(5, line);
            break;
            }
        default:
            break;
        }

    iContainer->DrawNow();
    }

TInt CWhminiAppUi::Tick(TAny* aSelf)
    {
    CWhminiAppUi* self = (CWhminiAppUi*)aSelf;
    self->Refresh();

    if (self->iJob.iState == EJobDone || self->iJob.iState == EJobFailed)
        {
        self->iTimer->Cancel();
        if (self->iWorkerRunning)
            {
            self->iWorker.Close();
            self->iWorkerRunning = EFalse;
            }
        }
    return 0;
    }

void CWhminiAppUi::AskForServerL()
    {
    TBuf<64> host;
    if (iSettings.iMailboxHost[0])
        host.Copy(TPtrC8((const TUint8*)iSettings.iMailboxHost));

    CAknTextQueryDialog* dlg = CAknTextQueryDialog::NewL(host);
    dlg->SetPromptL(_L("Server address"));
    if (!dlg->ExecuteLD(R_AVKON_DIALOG_QUERY_VALUE_TEXT)) return;
    if (host.Length() == 0) return;

    TInt i;
    for (i = 0; i < host.Length() && i < (TInt)sizeof(iSettings.iMailboxHost) - 1; i++)
        iSettings.iMailboxHost[i] = (char)host[i];
    iSettings.iMailboxHost[i] = '\0';
    WhminiTrim(iSettings.iMailboxHost);

    /* The relay is normally the same machine; server.txt can separate them. */
    for (i = 0; iSettings.iMailboxHost[i]; i++)
        iSettings.iRelayHost[i] = iSettings.iMailboxHost[i];
    iSettings.iRelayHost[i] = '\0';

    WhminiSaveSettings(iSettings);
    Refresh();
    }

void CWhminiAppUi::StartReceiveL()
    {
    if (iWorkerRunning)
        {
        CAknInformationNote* note = new (ELeave) CAknInformationNote(ETrue);
        note->ExecuteLD(_L("A transfer is already running"));
        return;
        }
    if (iSettings.iMailboxHost[0] == '\0')
        {
        AskForServerL();
        if (iSettings.iMailboxHost[0] == '\0') return;
        }

    TBuf<64> code;
    CAknTextQueryDialog* dlg = CAknTextQueryDialog::NewL(code);
    dlg->SetPromptL(_L("Wormhole code"));
    if (!dlg->ExecuteLD(R_AVKON_DIALOG_QUERY_VALUE_TEXT)) return;
    if (code.Length() == 0) return;

    TInt i;
    for (i = 0; i < code.Length() && i < (TInt)sizeof(iJob.iCode) - 1; i++)
        iJob.iCode[i] = (char)code[i];
    iJob.iCode[i] = '\0';

    iJob.iState = EJobIdle;
    iJob.iStage = 0;
    iJob.iError = 0;
    iJob.iDone = 0;
    iJob.iTotal = 0;
    iJob.iMessage[0] = '\0';
    iJob.iFileName[0] = '\0';

    TInt err = iWorker.Create(_L("whmini_worker"), WhminiWorker,
                              KWorkerStackSize, NULL, &iJob);
    if (err != KErrNone)
        {
        CAknErrorNote* note = new (ELeave) CAknErrorNote(ETrue);
        note->ExecuteLD(_L("Could not start the transfer"));
        return;
        }
    iWorkerRunning = ETrue;
    iWorker.Resume();

    iTimer->Cancel();
    iTimer->Start(KPollInterval, KPollInterval, TCallBack(Tick, this));
    Refresh();
    }

void CWhminiAppUi::HandleCommandL(TInt aCommand)
    {
    switch (aCommand)
        {
        case EWhminiCmdReceive:
            StartReceiveL();
            break;
        case EWhminiCmdServer:
            AskForServerL();
            break;
        case EAknSoftkeyExit:
        case EEikCmdExit:
            Exit();
            break;
        default:
            break;
        }
    }

/* --- boilerplate -------------------------------------------------------- */

class CWhminiDocument : public CAknDocument
    {
public:
    CWhminiDocument(CEikApplication& aApp) : CAknDocument(aApp) {}
private:
    CEikAppUi* CreateAppUiL() { return new (ELeave) CWhminiAppUi; }
    };

class CWhminiApplication : public CAknApplication
    {
private:
    CApaDocument* CreateDocumentL() { return new (ELeave) CWhminiDocument(*this); }
    TUid AppDllUid() const { return KUidWhminiApp; }
    };

LOCAL_C CApaApplication* NewApplication()
    {
    return new CWhminiApplication;
    }

GLDEF_C TInt E32Main()
    {
    return EikStart::RunApplication(NewApplication);
    }
