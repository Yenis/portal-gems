/* The wormhole protocol's key derivations.
 *
 * Mirrors native/magic-wormhole/src/core/key.rs. Every one of these is
 * pinned by a vector in tests/vectors/vectors.h. */
#ifndef WH_KDF_H
#define WH_KDF_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_KEY_LEN 32
/* Longest purpose string we build internally is "<appid>/transit-key". */
#define WH_PURPOSE_MAX 160

/* derive_key(key, purpose) - HKDF-SHA256, zero salt, 32 bytes out. */
void wh_derive_key(const unsigned char key[WH_KEY_LEN],
                   const unsigned char *purpose, unsigned long purpose_len,
                   unsigned char out[WH_KEY_LEN]);

/* Same, for a NUL-terminated purpose. */
void wh_derive_key_str(const unsigned char key[WH_KEY_LEN],
                       const char *purpose, unsigned char out[WH_KEY_LEN]);

/* derive_phase_key(side, key, phase). The purpose is
 * "wormhole:phase:" || sha256(side) || sha256(phase), with the two digests
 * as RAW BYTES, not hex - the single easiest thing to get wrong here. */
void wh_derive_phase_key(const char *side, const unsigned char key[WH_KEY_LEN],
                         const char *phase, unsigned char out[WH_KEY_LEN]);

/* derive_key(key, "wormhole:verifier") */
void wh_derive_verifier(const unsigned char key[WH_KEY_LEN],
                        unsigned char out[WH_KEY_LEN]);

/* derive_key(key, "<appid>/transit-key"). Returns -1 if appid is too long
 * to fit WH_PURPOSE_MAX. */
int wh_derive_transit_key(const unsigned char key[WH_KEY_LEN], const char *appid,
                          unsigned char out[WH_KEY_LEN]);

/* Lowercase hex, writes 2*len + 1 bytes including the NUL. */
void wh_hex(const unsigned char *in, unsigned long len, char *out);

/* Decode hex. Returns the byte count, or -1 on a bad digit, an odd length,
 * or a buffer that is too small. */
long wh_unhex(const char *in, unsigned long len, unsigned char *out,
              unsigned long cap);

#ifdef __cplusplus
}
#endif
#endif /* WH_KDF_H */
