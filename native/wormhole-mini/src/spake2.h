/* SPAKE2 over ed25519, symmetric mode - the wormhole handshake.
 *
 * Matches the `spake2` 0.4 crate as the engine uses it
 * (native/magic-wormhole/src/core/key.rs::make_pake): the password is the
 * full code string, the identity is the app id, and both sides run the same
 * symmetric role blinded by the constant S.
 *
 * The message on the wire is 33 bytes: a 0x53 'S' side byte followed by the
 * compressed element. That is what goes in the `pake` phase as
 * {"pake_v1": "<hex>"}. */
#ifndef WH_SPAKE2_H
#define WH_SPAKE2_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_SPAKE2_MSG_LEN 33
#define WH_SPAKE2_KEY_LEN 32

typedef struct {
    unsigned char x[32];         /* our scalar */
    unsigned char pw_scalar[32]; /* password mapped into the scalar field */
    unsigned char msg1[32];      /* our element, without the side byte */
    unsigned char pw_hash[32];   /* sha256(password), for the transcript */
    unsigned char id_hash[32];   /* sha256(identity), for the transcript */
} wh_spake2;

/* Begin. `entropy` is 64 fresh random bytes, reduced mod L to pick our
 * scalar - the same construction curve25519-dalek's Scalar::random uses, so
 * a fixed input reproduces a known exchange. `out_msg` receives the 33 bytes
 * to send. */
void wh_spake2_start(wh_spake2 *st, const char *password, const char *identity,
                     const unsigned char entropy[64],
                     unsigned char out_msg[WH_SPAKE2_MSG_LEN]);

/* Complete with the peer's 33-byte message. Returns 0 and writes the shared
 * key, -1 if the message is malformed or not a valid curve point. A wrong
 * code is NOT reported here: SPAKE2 still produces a key, just a different
 * one, and the mismatch surfaces when the `version` phase fails to decrypt. */
int wh_spake2_finish(const wh_spake2 *st,
                     const unsigned char msg2[WH_SPAKE2_MSG_LEN],
                     unsigned char key[WH_SPAKE2_KEY_LEN]);

#ifdef __cplusplus
}
#endif
#endif /* WH_SPAKE2_H */
