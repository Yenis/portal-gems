/* The wormhole rendezvous (mailbox) client: everything from opening the
 * WebSocket to holding a confirmed shared key.
 *
 * Message schema in native/magic-wormhole/src/core/server_messages.rs, key
 * handling in core/key.rs. The one asymmetry worth remembering is that the
 * `pake` phase body is PLAINTEXT JSON (it carries the PAKE message itself),
 * while every later phase body is secretbox-encrypted under a phase key. */
#ifndef WH_MAILBOX_H
#define WH_MAILBOX_H

#include "ws.h"
#include "spake2.h"
#include "box.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Largest phase plaintext this client handles. Transfer v1 phase messages -
 * transit hints, offer, answer - run to a few hundred bytes; 2 KB is
 * generous. */
#define WH_PHASE_MAX 2048

/* Every buffer the mailbox layer needs, in one block the caller declares
 * statically. Nothing here goes on the stack: Symbian gives a thread 8 KB by
 * default, and a single phase message with its hex encoding is most of that.
 * Roughly 35 KB in total. */
typedef struct {
    unsigned char rx[8192];      /* websocket receive */
    char msg[8192];              /* one inbound message */
    char out[8192];              /* one outbound message */
    unsigned char work[2 * (WH_PHASE_MAX + 32)];
    unsigned char wire[WH_PHASE_MAX + WH_NONCE_LEN + WH_TAG_LEN];
    char hex[2 * (WH_PHASE_MAX + WH_NONCE_LEN + WH_TAG_LEN) + 1];
} wh_mailbox_bufs;

typedef struct {
    wh_ws ws;
    char side[11];             /* ours: 5 random bytes, hex */
    char their_side[32];       /* learned from the first peer message */
    char nameplate[32];
    char mailbox[64];
    unsigned char key[32];     /* the wormhole key, once PAKE completes */
    int have_key;
    int have_their_side;
    unsigned long tx_phase;    /* next numeric phase we will send */
    unsigned long rx_phase;    /* next numeric phase we expect from them */
    wh_spake2 pake;

    /* Caller-owned buffers. Nothing here allocates. */
    wh_mailbox_bufs *b;

    /* Set when the server sends an error message; useful for diagnostics. */
    int server_error;
} wh_mailbox;

/* Wire up the buffers before anything else. */
void wh_mailbox_init(wh_mailbox *m, wh_mailbox_bufs *bufs);

/* Connect, wait for the welcome, and bind to the app id. Returns 0. */
int wh_mailbox_connect(wh_mailbox *m, const char *host, unsigned int port,
                       const char *path, const char *appid);

/* Claim the nameplate at the front of `code` and open the mailbox it names. */
int wh_mailbox_claim(wh_mailbox *m, const char *code);

/* Ask the server for a fresh nameplate, build a full code from it with two
 * words from the PGP list, claim it and open the mailbox. The code is what
 * the user reads out or types into the other device. */
int wh_mailbox_allocate(wh_mailbox *m, char *code_out, unsigned long cap);

/* Run the PAKE: send our message, wait for theirs, derive the shared key.
 * A wrong code is not detected here - it produces a different key, which
 * only shows up when the version phase fails to decrypt. */
int wh_mailbox_pake(wh_mailbox *m, const char *appid, const char *code);

/* Exchange version phases. Success here is what confirms the code was
 * right: their version body only decrypts if both sides derived the same
 * key. Returns 0 on success, -2 specifically on a decryption failure. */
int wh_mailbox_version(wh_mailbox *m);

/* Send `plaintext` in the next numeric phase, encrypted. */
int wh_mailbox_send_phase(wh_mailbox *m, const char *plaintext,
                          unsigned long len);

/* Wait for the peer's next numeric-phase message and decrypt it into `out`.
 * Returns the plaintext length, or -1. */
long wh_mailbox_recv_phase(wh_mailbox *m, char *out, unsigned long cap);

/* Close the mailbox with a mood, then drop the connection. */
void wh_mailbox_close(wh_mailbox *m, const char *mood);

#ifdef __cplusplus
}
#endif
#endif /* WH_MAILBOX_H */
