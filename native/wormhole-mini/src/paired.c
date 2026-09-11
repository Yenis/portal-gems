#include "paired.h"
#include "net.h"

/* The PAKE is where a waiting side blocks: wh_mailbox_pake posts ours and
 * then reads theirs, which only arrives once a peer has joined. The version
 * exchange straight after it is one round trip. Both run under `timeout_ms`,
 * and the platform default is restored whatever happens. */
static int handshake_within(wh_mailbox *m, const char *appid, const char *code,
                            unsigned long timeout_ms)
{
    int rc;

    wh_net_set_read_timeout(timeout_ms);
    rc = wh_mailbox_pake(m, appid, code);
    if (rc == 0) rc = wh_mailbox_version(m);
    wh_net_set_read_timeout(0);
    return rc;
}

int wh_paired_open_sender(wh_mailbox *m, const wh_paired_server *srv,
                          const unsigned char secret[WH_PAIR_SECRET_LEN],
                          char code[WH_PAIR_CODE_MAX])
{
    unsigned long started = wh_net_unix_time();
    int rc;

    wh_pair_derive_code(secret, wh_pair_bucket(started), code);

    if (wh_mailbox_connect(m, srv->host, srv->port, srv->path, srv->appid) != 0) return -1;
    /* Claiming creates the nameplate if the receiver has not been by yet;
     * its polling finds it on the next pass. */
    if (wh_mailbox_claim(m, code) != 0) {
        wh_mailbox_close(m, "errory");
        return -1;
    }

    rc = handshake_within(m, srv->appid, code, WH_PAIRED_SEND_TIMEOUT_MS);
    if (rc == -2) {
        wh_mailbox_close(m, "scary");
        return -2;
    }
    if (rc != 0) {
        /* A read that ran out the whole window means nobody came; anything
         * sooner is a real failure worth reporting as one. */
        int timed_out = wh_net_unix_time() - started >= WH_PAIRED_SEND_TIMEOUT_MS / 1000UL - 1;
        wh_mailbox_close(m, "lonely");
        return timed_out ? -3 : -1;
    }
    return 0;
}

int wh_paired_open_receiver(wh_mailbox *m, const wh_paired_server *srv,
                            const unsigned char secret[WH_PAIR_SECRET_LEN],
                            char code[WH_PAIR_CODE_MAX])
{
    unsigned long deadline = wh_net_unix_time() + WH_PAIRED_RECEIVE_TIMEOUT_S;
    wh_mailbox_bufs *bufs = m->b;
    int connected = 0;
    int list_failures = 0;

    while (wh_net_unix_time() < deadline) {
        /* Most likely first, as candidateBuckets() orders them. Recomputed
         * each round, so a poll that runs across a bucket boundary follows
         * the clock rather than chasing codes nobody will use again. */
        unsigned long b = wh_pair_bucket(wh_net_unix_time());
        unsigned long candidates[3];
        int i;
        candidates[0] = b;
        candidates[1] = b - 1;
        candidates[2] = b + 1;

        for (i = 0; i < 3; i++) {
            int listed, rc;

            if (wh_net_cancelled()) {
                if (connected) wh_mailbox_close(m, "errory");
                return -1;
            }
            wh_pair_derive_code(secret, candidates[i], code);

            /* One connection serves every "is it there?" question; a claim
             * uses it up, and a fresh one is made for the next. */
            if (!connected) {
                wh_mailbox_init(m, bufs);
                if (wh_mailbox_connect(m, srv->host, srv->port, srv->path,
                                       srv->appid) != 0) {
                    return -1;
                }
                connected = 1;
            }

            listed = wh_mailbox_nameplate_listed(m, code);
            if (listed < 0) {
                /* The connection may be what failed; start over with a
                 * fresh one rather than trusting it for the next question.
                 * If fresh ones fail too - a server whose list will not fit
                 * one message, say - polling harder will not help. */
                wh_mailbox_close(m, "errory");
                connected = 0;
                if (++list_failures >= 3) return -1;
                continue;
            }
            list_failures = 0;
            if (!listed) continue;

            if (wh_mailbox_claim(m, code) != 0) {
                /* Claimed by two others already, or gone in between: either
                 * way, not our transfer. */
                wh_mailbox_close(m, "errory");
                connected = 0;
                continue;
            }
            rc = handshake_within(m, srv->appid, code, WH_PAIRED_ATTEMPT_TIMEOUT_MS);
            if (rc == 0) return 0;

            /* A stale nameplate from a sender that died, or a peer holding a
             * different secret. Leave it and keep looking. */
            wh_mailbox_close(m, rc == -2 ? "scary" : "errory");
            connected = 0;
        }
    }

    if (connected) wh_mailbox_close(m, "lonely");
    return -3;
}
