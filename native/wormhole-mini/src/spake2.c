#include "spake2.h"
#include "ed25519.h"
#include "sha256.h"

#define SIDE_SYMMETRIC 0x53 /* 'S' */

/* spake2::ed25519::Ed25519Group::const_s - the point the symmetric mode
 * blinds with. Both sides use it, which is what makes the role symmetric. */
static const unsigned char WH_SPAKE2_S[32] = {
    0x6f, 0x00, 0xda, 0xe8, 0x7c, 0x1b, 0xe1, 0xa7, 0x3b, 0x59, 0x22, 0xef,
    0x43, 0x1c, 0xd8, 0xf5, 0x78, 0x79, 0x56, 0x9c, 0x22, 0x2d, 0x22, 0xb1,
    0xcd, 0x71, 0xe8, 0x54, 0x6a, 0xb8, 0xe6, 0xf1
};

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

/* spake2::ed25519::ed25519_hash_to_scalar:
 *   okm = HKDF-SHA256(salt="", ikm=password, info="SPAKE2 pw", 48 bytes)
 *   scalar = int(okm, big-endian) mod L
 * The big-endian read becomes a byte reversal into a little-endian buffer.
 *
 * The salt is an empty string rather than absent, but HMAC pads both an
 * empty key and a 32-byte zero key to the same 64 zero bytes, so the zero
 * salt in wh_hkdf_sha256 gives an identical PRK. */
static void wh_spake2_pw_scalar(const char *password, unsigned char out[32])
{
    unsigned char okm[48];
    unsigned char reducible[64];
    int i;

    wh_hkdf_sha256((const unsigned char *)password, wh_strlen(password),
                   (const unsigned char *)"SPAKE2 pw", 9, okm, sizeof(okm));

    for (i = 0; i < 64; i++) reducible[i] = 0;
    for (i = 0; i < 48; i++) reducible[48 - 1 - i] = okm[i];

    wh_sc_reduce_wide(out, reducible);
}

void wh_spake2_start(wh_spake2 *st, const char *password, const char *identity,
                     const unsigned char entropy[64],
                     unsigned char out_msg[WH_SPAKE2_MSG_LEN])
{
    wh_ed_point s_point, blinded, m1;
    int i;

    wh_spake2_pw_scalar(password, st->pw_scalar);
    wh_sc_reduce_wide(st->x, entropy);

    wh_sha256((const unsigned char *)password, wh_strlen(password), st->pw_hash);
    wh_sha256((const unsigned char *)identity, wh_strlen(identity), st->id_hash);

    /* m1 = basepoint*x + S*pw */
    wh_ed_decompress(&s_point, WH_SPAKE2_S);
    wh_ed_scalarbase(&m1, st->x);
    wh_ed_scalarmult(&blinded, &s_point, st->pw_scalar);
    wh_ed_add(&m1, &blinded);
    wh_ed_compress(st->msg1, &m1);

    out_msg[0] = SIDE_SYMMETRIC;
    for (i = 0; i < 32; i++) out_msg[1 + i] = st->msg1[i];
}

int wh_spake2_finish(const wh_spake2 *st,
                     const unsigned char msg2[WH_SPAKE2_MSG_LEN],
                     unsigned char key[WH_SPAKE2_KEY_LEN])
{
    wh_ed_point s_point, y_point, unblind, tmp, k_point;
    unsigned char neg_pw[32];
    unsigned char k_bytes[32];
    unsigned char transcript[5 * 32];
    const unsigned char *their = msg2 + 1;
    const unsigned char *first, *second;
    int cmp, i;

    if (msg2[0] != SIDE_SYMMETRIC) return -1;
    if (wh_ed_decompress(&y_point, their) != 0) return -1;

    /* K = (Y + S*(-pw)) * x */
    wh_ed_decompress(&s_point, WH_SPAKE2_S);
    wh_sc_neg(neg_pw, st->pw_scalar);
    wh_ed_scalarmult(&unblind, &s_point, neg_pw);
    tmp = y_point;
    wh_ed_add(&tmp, &unblind);
    wh_ed_scalarmult(&k_point, &tmp, st->x);
    wh_ed_compress(k_bytes, &k_point);

    /* transcript = sha256(pw) || sha256(id) || min(msgs) || max(msgs) || K.
     * Neither side knows which of them is which, so the two messages are
     * sorted bytewise to give both the same order. */
    cmp = 0;
    for (i = 0; i < 32 && cmp == 0; i++) {
        if (st->msg1[i] != their[i]) cmp = (st->msg1[i] < their[i]) ? -1 : 1;
    }
    if (cmp < 0) {
        first = st->msg1;
        second = their;
    } else {
        first = their;
        second = st->msg1;
    }

    for (i = 0; i < 32; i++) {
        transcript[i] = st->pw_hash[i];
        transcript[32 + i] = st->id_hash[i];
        transcript[64 + i] = first[i];
        transcript[96 + i] = second[i];
        transcript[128 + i] = k_bytes[i];
    }

    wh_sha256(transcript, sizeof(transcript), key);
    return 0;
}
