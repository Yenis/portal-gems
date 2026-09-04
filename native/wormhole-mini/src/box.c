#include "box.h"
#include "../vendor/tweetnacl/tweetnacl.h"

#define ZEROBYTES 32
#define BOXZEROBYTES 16

int wh_box_seal(const unsigned char key[32], const unsigned char nonce[WH_NONCE_LEN],
                const unsigned char *pt, unsigned long ptlen,
                unsigned char *work, unsigned long work_len,
                unsigned char *out, unsigned long out_cap,
                unsigned long *out_len)
{
    unsigned char *m, *c;
    unsigned long mlen = ptlen + ZEROBYTES;
    unsigned long i;

    if (work_len < WH_BOX_WORK(ptlen)) return -1;
    if (out_cap < WH_BOX_WIRE(ptlen)) return -1;

    m = work;
    c = work + mlen;

    for (i = 0; i < ZEROBYTES; i++) m[i] = 0;
    for (i = 0; i < ptlen; i++) m[ZEROBYTES + i] = pt[i];

    if (crypto_secretbox(c, m, (unsigned long long)mlen, nonce, key) != 0) return -1;

    /* c has BOXZEROBYTES of leading zeros; the wire carries what follows. */
    for (i = 0; i < WH_NONCE_LEN; i++) out[i] = nonce[i];
    for (i = 0; i < ptlen + WH_TAG_LEN; i++) {
        out[WH_NONCE_LEN + i] = c[BOXZEROBYTES + i];
    }
    *out_len = WH_BOX_WIRE(ptlen);
    return 0;
}

int wh_box_open(const unsigned char key[32],
                const unsigned char *wire, unsigned long wire_len,
                unsigned char *work, unsigned long work_len,
                unsigned char *out, unsigned long out_cap,
                unsigned long *out_len)
{
    unsigned char *m, *c;
    unsigned long ptlen, clen;
    unsigned long i;

    if (wire_len < WH_NONCE_LEN + WH_TAG_LEN) return -1;
    ptlen = wire_len - WH_NONCE_LEN - WH_TAG_LEN;
    if (work_len < WH_BOX_WORK(ptlen)) return -1;
    if (out_cap < ptlen) return -1;

    clen = ptlen + ZEROBYTES;
    c = work;
    m = work + clen;

    for (i = 0; i < BOXZEROBYTES; i++) c[i] = 0;
    for (i = 0; i < ptlen + WH_TAG_LEN; i++) {
        c[BOXZEROBYTES + i] = wire[WH_NONCE_LEN + i];
    }

    if (crypto_secretbox_open(m, c, (unsigned long long)clen, wire, key) != 0) {
        return -2;
    }

    for (i = 0; i < ptlen; i++) out[i] = m[ZEROBYTES + i];
    *out_len = ptlen;
    return 0;
}
