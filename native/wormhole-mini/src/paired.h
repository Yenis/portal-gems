/* Meeting a paired device on a derived code.
 *
 * Both sides of a paired transfer - and the handshake that finishes pairing -
 * open an ordinary wormhole, just on a code neither of them typed: the one
 * wh_pair_derive_code gives for the current five-minute bucket. The sender
 * claims it outright; the receiver polls the buckets either side of its own
 * clock, because two clocks rarely agree to the second. These mirror
 * completePairingAsScanner / waitForPairingAsDisplayer and the paired flows
 * in the apps, including their timeouts. */
#ifndef WH_PAIRED_H
#define WH_PAIRED_H

#include "mailbox.h"
#include "pair.h"

#ifdef __cplusplus
extern "C" {
#endif

/* PAIRED_SEND_TIMEOUT_MS, PAIRED_RECEIVE_TIMEOUT_MS and
 * PAIRED_ATTEMPT_TIMEOUT_MS in packages/core/src/pairing.ts. */
#define WH_PAIRED_SEND_TIMEOUT_MS    45000UL
#define WH_PAIRED_RECEIVE_TIMEOUT_S  60UL
#define WH_PAIRED_ATTEMPT_TIMEOUT_MS 10000UL

typedef struct {
    const char *host;
    unsigned int port;
    const char *path;
    const char *appid;
} wh_paired_server;

/* Sender: connect, claim the current bucket's code, and complete the
 * handshake with whoever joins it. `code` receives the code used.
 *
 * Returns 0 with `m` ready for transfer messages; -1 on a network or protocol
 * failure; -2 if the key did not match (the peer holds a different secret);
 * -3 if nobody joined within WH_PAIRED_SEND_TIMEOUT_MS. */
int wh_paired_open_sender(wh_mailbox *m, const wh_paired_server *srv,
                          const unsigned char secret[WH_PAIR_SECRET_LEN],
                          char code[WH_PAIR_CODE_MAX]);

/* Receiver: look for a sender on the current bucket's code and the ones either
 * side of it, until one turns up or WH_PAIRED_RECEIVE_TIMEOUT_S passes.
 *
 * A nameplate is only claimed once the server lists it, so polling never
 * creates one; and each attempt on a listed nameplate is bounded by
 * WH_PAIRED_ATTEMPT_TIMEOUT_MS, because a sender that died while waiting
 * leaves its nameplate listed and would otherwise hold the attempt open.
 *
 * Returns 0 with `m` ready for transfer messages; -1 on a failure that is not
 * worth retrying; -3 if no sender appeared in time. */
int wh_paired_open_receiver(wh_mailbox *m, const wh_paired_server *srv,
                            const unsigned char secret[WH_PAIR_SECRET_LEN],
                            char code[WH_PAIR_CODE_MAX]);

#ifdef __cplusplus
}
#endif
#endif /* WH_PAIRED_H */
