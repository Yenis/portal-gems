/* The ed25519 group operations SPAKE2 needs, exposed from TweetNaCl.
 *
 * TweetNaCl has all of this, but as `static` internals of crypto_sign. So
 * src/ed25519.c compiles vendor/tweetnacl/tweetnacl.c inside its own
 * translation unit rather than patching the vendored file, which stays
 * byte-identical to upstream and separately auditable. Nothing else in the
 * project links tweetnacl.c directly.
 *
 * A point is an extended-coordinate quadruple of 16-limb field elements:
 * 4 * 16 = 64 values of TweetNaCl's i64. Kept opaque so `gf` does not leak. */
#ifndef WH_ED25519_H
#define WH_ED25519_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    long long v[64];
} wh_ed_point;

/* Decompress 32 bytes into a point. Returns 0, or -1 if the bytes are not a
 * valid curve point. */
int wh_ed_decompress(wh_ed_point *out, const unsigned char in[32]);

/* Compress a point to its 32-byte encoding. */
void wh_ed_compress(unsigned char out[32], const wh_ed_point *p);

/* p += q */
void wh_ed_add(wh_ed_point *p, const wh_ed_point *q);

/* out = s * p, and out = s * basepoint. `s` is little-endian and must
 * already be reduced mod the group order. */
void wh_ed_scalarmult(wh_ed_point *out, const wh_ed_point *p,
                      const unsigned char s[32]);
void wh_ed_scalarbase(wh_ed_point *out, const unsigned char s[32]);

/* out = in mod L, where `in` is 64 little-endian bytes. This is exactly
 * curve25519-dalek's `Scalar::from_bytes_mod_order_wide`. */
void wh_sc_reduce_wide(unsigned char out[32], const unsigned char in[64]);

/* out = -in mod L. */
void wh_sc_neg(unsigned char out[32], const unsigned char in[32]);

#ifdef __cplusplus
}
#endif
#endif /* WH_ED25519_H */
