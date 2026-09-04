#include "ed25519.h"

/* Pulls in TweetNaCl's static internals: add, cswap, pack, scalarmult,
 * scalarbase, unpackneg, reduce and the group order L. */
#include "../vendor/tweetnacl/tweetnacl.c"

/* gf is i64[16]; a point is gf[4], laid out exactly as wh_ed_point::v. */
#define AS_GF(p) ((gf *)((p)->v))
#define AS_CONST_GF(p) ((gf *)((void *)(p)->v))

int wh_ed_decompress(wh_ed_point *out, const unsigned char in[32])
{
    gf *r = AS_GF(out);

    /* unpackneg yields -P, not P: it negates x when the parity matches the
     * sign bit, which is the opposite of plain decompression. Undo that by
     * negating x again and recomputing the T coordinate, which unpackneg
     * built from the negated x. */
    if (unpackneg(r, in) != 0) return -1;
    Z(r[0], gf0, r[0]);
    M(r[3], r[0], r[1]);
    return 0;
}

void wh_ed_compress(unsigned char out[32], const wh_ed_point *p)
{
    pack(out, AS_CONST_GF(p));
}

void wh_ed_add(wh_ed_point *p, const wh_ed_point *q)
{
    /* TweetNaCl's add reads q and writes only p, but is not const-qualified. */
    add(AS_GF(p), AS_CONST_GF(q));
}

void wh_ed_scalarmult(wh_ed_point *out, const wh_ed_point *p,
                      const unsigned char s[32])
{
    wh_ed_point scratch;
    int i;

    /* scalarmult swaps values in and out of its second argument, so it must
     * be given a copy rather than the caller's point. */
    for (i = 0; i < 64; i++) scratch.v[i] = p->v[i];
    scalarmult(AS_GF(out), AS_GF(&scratch), s);
}

void wh_ed_scalarbase(wh_ed_point *out, const unsigned char s[32])
{
    scalarbase(AS_GF(out), s);
}

void wh_sc_reduce_wide(unsigned char out[32], const unsigned char in[64])
{
    unsigned char buf[64];
    int i;

    for (i = 0; i < 64; i++) buf[i] = in[i];
    reduce(buf);
    for (i = 0; i < 32; i++) out[i] = buf[i];
}

void wh_sc_neg(unsigned char out[32], const unsigned char in[32])
{
    unsigned char buf[64];
    int borrow = 0;
    int i;

    /* L - in, little-endian with borrow. `in` is assumed reduced, so the
     * result is in [1, L]; reduce() then maps the L case (in == 0) back to
     * zero, which is what -0 should be. */
    for (i = 0; i < 32; i++) {
        int d = (int)L[i] - (int)in[i] - borrow;
        if (d < 0) {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        buf[i] = (unsigned char)d;
    }
    for (i = 32; i < 64; i++) buf[i] = 0;

    reduce(buf);
    for (i = 0; i < 32; i++) out[i] = buf[i];
}
