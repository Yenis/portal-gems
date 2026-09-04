/* SHA-256, HMAC-SHA256 and HKDF-SHA256.
 *
 * TweetNaCl only ships SHA-512, and the wormhole protocol derives every key
 * with HKDF-SHA256 (native/magic-wormhole/src/core/key.rs), so this is the
 * one primitive we have to supply ourselves.
 *
 * C89, no allocation, no floating point. Compiles as C and as C++ so the
 * Symbian toolchain can build it either way. */
#ifndef WH_SHA256_H
#define WH_SHA256_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_SHA256_LEN 32
#define WH_SHA256_BLOCK 64

typedef struct {
    unsigned int state[8];
    unsigned char buf[WH_SHA256_BLOCK];
    unsigned int buflen;
    unsigned int nbits_lo;   /* message length in bits, split to stay in 32 */
    unsigned int nbits_hi;
} wh_sha256_ctx;

void wh_sha256_init(wh_sha256_ctx *s);
void wh_sha256_update(wh_sha256_ctx *s, const unsigned char *data, unsigned long len);
void wh_sha256_final(wh_sha256_ctx *s, unsigned char out[WH_SHA256_LEN]);
void wh_sha256(const unsigned char *data, unsigned long len,
               unsigned char out[WH_SHA256_LEN]);

void wh_hmac_sha256(const unsigned char *key, unsigned long keylen,
                    const unsigned char *msg, unsigned long msglen,
                    unsigned char out[WH_SHA256_LEN]);

/* HKDF-SHA256 with an all-zero salt, which is what `Hkdf::new(None, key)`
 * means in the engine. `out_len` is capped at 255 * 32 bytes. Returns 0 on
 * success, -1 if out_len is too large. */
int wh_hkdf_sha256(const unsigned char *ikm, unsigned long ikm_len,
                   const unsigned char *info, unsigned long info_len,
                   unsigned char *out, unsigned long out_len);

#ifdef __cplusplus
}
#endif
#endif /* WH_SHA256_H */
