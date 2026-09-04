/* The transit connection: the side channel the file bytes actually travel
 * over, separate from the mailbox.
 *
 * Relay only. We never listen for direct connections and never offer direct
 * hints - a phone behind carrier NAT would almost never win that race
 * anyway, and it keeps the code small. Both peers connect out to the same
 * relay, which pairs them by a token derived from the shared key.
 *
 * The relay carries ciphertext only, so it needs no TLS
 * (docs/VPS-SETUP.md runs it as plain TCP on 4001 for exactly this reason).
 *
 * Reference: native/magic-wormhole/src/transit.rs and transit/crypto.rs. */
#ifndef WH_TRANSIT_H
#define WH_TRANSIT_H

#include "net.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Largest plaintext the sender puts in one record. */
#define WH_RECORD_MAX 16384
/* Wire size of that: 4-byte length prefix + nonce + tag + plaintext. */
#define WH_RECORD_WIRE_MAX (WH_RECORD_MAX + 4 + 24 + 16)

/* Which side of the asymmetric handshake we play. The sender leads. */
#define WH_TRANSIT_LEADER 1
#define WH_TRANSIT_FOLLOWER 0

typedef struct {
    wh_conn *conn;
    unsigned char skey[32];
    unsigned char rkey[32];
    unsigned char snonce[24];
    unsigned char rnonce[24];
} wh_transit;

/* Connect to the relay and complete both handshakes. `role` is
 * WH_TRANSIT_LEADER when sending and WH_TRANSIT_FOLLOWER when receiving.
 * Returns 0. */
int wh_transit_connect_relay(wh_transit *t, const char *host, unsigned int port,
                             const unsigned char transit_key[32], int role);

/* Send one encrypted record. `work` needs WH_BOX_WORK(len) bytes. */
int wh_transit_send_record(wh_transit *t, const unsigned char *pt,
                           unsigned long len,
                           unsigned char *work, unsigned long work_cap,
                           unsigned char *wire, unsigned long wire_cap);

/* Receive and decrypt one record into `out`. Returns the plaintext length,
 * -1 on error, -2 on a nonce or authentication failure. */
long wh_transit_recv_record(wh_transit *t, unsigned char *out, unsigned long cap,
                            unsigned char *work, unsigned long work_cap,
                            unsigned char *wire, unsigned long wire_cap);

void wh_transit_close(wh_transit *t);

#ifdef __cplusplus
}
#endif
#endif /* WH_TRANSIT_H */
