/* XSalsa20-Poly1305 in the wormhole wire format: nonce(24) || ciphertext.
 *
 * TweetNaCl's crypto_secretbox needs its zero-padding convention handled by
 * the caller, and it needs two scratch buffers. Rather than allocate, both
 * calls take a caller-supplied work buffer - the core allocates nothing
 * after startup, which is what keeps it viable on the phone. */
#ifndef WH_BOX_H
#define WH_BOX_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_NONCE_LEN 24
#define WH_TAG_LEN 16
/* Work buffer needed to seal or open a message with `n` bytes of plaintext. */
#define WH_BOX_WORK(n) (2ul * ((n) + 32ul))
/* Wire size of a sealed message with `n` bytes of plaintext. */
#define WH_BOX_WIRE(n) ((n) + WH_NONCE_LEN + WH_TAG_LEN)

/* Seal with an explicit nonce. `out` receives nonce || ciphertext.
 * Returns 0, or -1 if a buffer is too small. */
int wh_box_seal(const unsigned char key[32], const unsigned char nonce[WH_NONCE_LEN],
                const unsigned char *pt, unsigned long ptlen,
                unsigned char *work, unsigned long work_len,
                unsigned char *out, unsigned long out_cap,
                unsigned long *out_len);

/* Open nonce || ciphertext. Returns 0, -1 on a buffer problem, -2 if
 * authentication fails. */
int wh_box_open(const unsigned char key[32],
                const unsigned char *wire, unsigned long wire_len,
                unsigned char *work, unsigned long work_len,
                unsigned char *out, unsigned long out_cap,
                unsigned long *out_len);

#ifdef __cplusplus
}
#endif
#endif /* WH_BOX_H */
