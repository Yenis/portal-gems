#include "transit.h"
#include "kdf.h"
#include "box.h"

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

/* wh_net_read may return short; the framing needs exact counts. */
static int read_exact(wh_conn *c, unsigned char *buf, unsigned long n)
{
    unsigned long got = 0;
    while (got < n) {
        long r = wh_net_read(c, buf + got, n - got);
        if (r <= 0) return -1;
        got += (unsigned long)r;
    }
    return 0;
}

/* sodium_increment_be: +1 from the last byte, carrying left. */
static void nonce_inc(unsigned char *n)
{
    unsigned int c = 1;
    int i;
    for (i = 23; i >= 0; i--) {
        c += n[i];
        n[i] = (unsigned char)(c & 0xff);
        c >>= 8;
    }
}

static int append(char *dst, unsigned long cap, unsigned long *len, const char *s)
{
    unsigned long n = wh_strlen(s), i;
    if (*len + n >= cap) return -1;
    for (i = 0; i < n; i++) dst[*len + i] = s[i];
    *len += n;
    return 0;
}

int wh_transit_connect_relay(wh_transit *t, const char *host, unsigned int port,
                             const unsigned char transit_key[32], int role)
{
    unsigned char sub[32];
    unsigned char tside_raw[8];
    char hex[65];
    char tside[17];
    char line[160];
    unsigned char expect[96];
    unsigned char got[96];
    unsigned long len = 0;
    int i;

    for (i = 0; i < 24; i++) { t->snonce[i] = 0; t->rnonce[i] = 0; }

    if (wh_net_connect(&t->conn, host, port) != 0) return -1;

    /* 1. Relay handshake. The side here is a fresh 8-byte value, not the
     * mailbox side (transit.rs:1139). */
    wh_net_random(tside_raw, sizeof(tside_raw));
    wh_hex(tside_raw, sizeof(tside_raw), tside);
    wh_derive_key_str(transit_key, "transit_relay_token", sub);
    wh_hex(sub, 32, hex);

    if (append(line, sizeof(line), &len, "please relay ") != 0) return -1;
    if (append(line, sizeof(line), &len, hex) != 0) return -1;
    if (append(line, sizeof(line), &len, " for side ") != 0) return -1;
    if (append(line, sizeof(line), &len, tside) != 0) return -1;
    if (append(line, sizeof(line), &len, "\n") != 0) return -1;

    if (wh_net_write(t->conn, (const unsigned char *)line, len) != 0) return -1;
    if (read_exact(t->conn, got, 3) != 0) return -1;
    if (got[0] != 'o' || got[1] != 'k' || got[2] != '\n') return -1;

    /* 2. Transit handshake. Asymmetric: the leader writes its line, reads
     * the follower's, then writes "go\n". The two lines are different
     * lengths - 87 for the sender, 89 for the receiver, because "receiver"
     * is two characters longer - and transit/crypto.rs asserts both. */
    wh_derive_key_str(transit_key, role == WH_TRANSIT_LEADER
                                       ? "transit_sender" : "transit_receiver", sub);
    wh_hex(sub, 32, hex);
    len = 0;
    if (append(line, sizeof(line), &len,
               role == WH_TRANSIT_LEADER ? "transit sender " : "transit receiver ") != 0) {
        return -1;
    }
    if (append(line, sizeof(line), &len, hex) != 0) return -1;
    if (append(line, sizeof(line), &len, " ready\n\n") != 0) return -1;
    if (len != (role == WH_TRANSIT_LEADER ? 87UL : 89UL)) return -1;
    if (wh_net_write(t->conn, (const unsigned char *)line, len) != 0) return -1;

    wh_derive_key_str(transit_key, role == WH_TRANSIT_LEADER
                                       ? "transit_receiver" : "transit_sender", sub);
    wh_hex(sub, 32, hex);
    len = 0;
    if (append((char *)expect, sizeof(expect), &len,
               role == WH_TRANSIT_LEADER ? "transit receiver " : "transit sender ") != 0) {
        return -1;
    }
    if (append((char *)expect, sizeof(expect), &len, hex) != 0) return -1;
    if (append((char *)expect, sizeof(expect), &len, " ready\n\n") != 0) return -1;
    /* The follower additionally waits for the leader's "go". */
    if (role == WH_TRANSIT_FOLLOWER) {
        if (append((char *)expect, sizeof(expect), &len, "go\n") != 0) return -1;
    }
    if (len != (role == WH_TRANSIT_LEADER ? 89UL : 90UL)) return -1;

    if (read_exact(t->conn, got, len) != 0) return -1;
    for (i = 0; i < (int)len; i++) {
        if (got[i] != expect[i]) return -1;
    }

    /* The leader confirms the connection it has chosen. */
    if (role == WH_TRANSIT_LEADER) {
        if (wh_net_write(t->conn, (const unsigned char *)"go\n", 3) != 0) return -1;
    }

    /* 3. Record keys. The names are a historical misnomer for leader and
     * follower. The leader sends with the sender key; the follower sends
     * with the receiver key. Getting this backwards is the classic bug. */
    if (role == WH_TRANSIT_LEADER) {
        wh_derive_key_str(transit_key, "transit_record_sender_key", t->skey);
        wh_derive_key_str(transit_key, "transit_record_receiver_key", t->rkey);
    } else {
        wh_derive_key_str(transit_key, "transit_record_sender_key", t->rkey);
        wh_derive_key_str(transit_key, "transit_record_receiver_key", t->skey);
    }
    return 0;
}

int wh_transit_send_record(wh_transit *t, const unsigned char *pt,
                           unsigned long len,
                           unsigned char *work, unsigned long work_cap,
                           unsigned char *wire, unsigned long wire_cap)
{
    unsigned char hdr[4];
    unsigned long wire_len = 0;

    if (wh_box_seal(t->skey, t->snonce, pt, len, work, work_cap,
                    wire, wire_cap, &wire_len) != 0) {
        return -1;
    }
    hdr[0] = (unsigned char)((wire_len >> 24) & 0xff);
    hdr[1] = (unsigned char)((wire_len >> 16) & 0xff);
    hdr[2] = (unsigned char)((wire_len >> 8) & 0xff);
    hdr[3] = (unsigned char)(wire_len & 0xff);

    if (wh_net_write(t->conn, hdr, 4) != 0) return -1;
    if (wh_net_write(t->conn, wire, wire_len) != 0) return -1;
    nonce_inc(t->snonce);
    return 0;
}

long wh_transit_recv_record(wh_transit *t, unsigned char *out, unsigned long cap,
                            unsigned char *work, unsigned long work_cap,
                            unsigned char *wire, unsigned long wire_cap)
{
    unsigned char hdr[4];
    unsigned long n, plen = 0;
    int i, rc;

    if (read_exact(t->conn, hdr, 4) != 0) return -1;
    n = ((unsigned long)hdr[0] << 24) | ((unsigned long)hdr[1] << 16) |
        ((unsigned long)hdr[2] << 8) | (unsigned long)hdr[3];
    if (n < 24 + 16 || n > wire_cap) return -1;

    if (read_exact(t->conn, wire, n) != 0) return -1;

    /* Records must arrive in order: the nonce is a counter, and a peer that
     * skips or replays one is not talking the protocol. */
    for (i = 0; i < 24; i++) {
        if (wire[i] != t->rnonce[i]) return -2;
    }

    rc = wh_box_open(t->rkey, wire, n, work, work_cap, out, cap, &plen);
    if (rc == -2) return -2;
    if (rc != 0) return -1;
    nonce_inc(t->rnonce);
    return (long)plen;
}

void wh_transit_close(wh_transit *t)
{
    if (t->conn) {
        wh_net_close(t->conn);
        t->conn = 0;
    }
}
