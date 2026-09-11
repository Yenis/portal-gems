/* PortalGems device pairing, the C side.
 *
 * A byte-for-byte counterpart of packages/core/src/pairing.ts, which is the
 * single source of truth: the same payload, the same code derivation, the
 * same handshake. Two paired devices must derive identical codes from the
 * same secret and time, so every function here is pinned by tests/test_pair.c
 * against the literals core's own tests pin, and those were cross-checked
 * against an independent Python implementation.
 *
 * Getting the payload across is not this layer's business - it arrives as a
 * text message over an ordinary wormhole code, or as a pasted string - and
 * neither is storage. */
#ifndef WH_PAIR_H
#define WH_PAIR_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_PAIR_SECRET_LEN     32
#define WH_PAIR_NAME_MAX       128   /* bytes of UTF-8, with the NUL */
/* "NNNNNNNN-xxxxxxxxxx-xxxxxxxxxx" and its NUL. */
#define WH_PAIR_CODE_MAX       32
#define WH_PAIR_PAYLOAD_MAX    1024
#define WH_PAIR_BUCKET_SECONDS 300

/* What a pairing invitation carries: the displaying device's name and the
 * long-term secret both sides will derive codes from. */
typedef struct {
    char name[WH_PAIR_NAME_MAX];
    unsigned char secret[WH_PAIR_SECRET_LEN];
} wh_pair_payload;

/* The five-minute window a moment falls in. Codes are derived per window, and
 * a receiver tries the one before and after as well, so two clocks may
 * disagree by a few minutes and still meet - but not by much more. */
unsigned long wh_pair_bucket(unsigned long unix_seconds);

/* The one-time wormhole code for a bucket: HMAC-SHA256(secret,
 * "portalgems-code-v1:<bucket>"), the first four bytes as an 8-digit
 * nameplate, the next ten as two groups of hex. */
void wh_pair_derive_code(const unsigned char secret[WH_PAIR_SECRET_LEN],
                         unsigned long bucket, char out[WH_PAIR_CODE_MAX]);

/* "PGPAIR1:" + base64url(JSON {"v":1,"name":...,"secret":...}). Returns the
 * length, or -1 if `cap` is too small. */
long wh_pair_encode(const wh_pair_payload *p, char *out, unsigned long cap);

/* Parse an invitation, tolerating surrounding whitespace. Returns 0, or -1 for
 * anything that is not a v1 payload with a 32-byte secret - the same things
 * parsePairingPayload rejects. A name too long for WH_PAIR_NAME_MAX is not a
 * reason to refuse a pairing; it is replaced rather than truncated mid-way
 * through a character. */
int wh_pair_decode(const char *text, unsigned long len, wh_pair_payload *out);

/* The handshake the joining side sends back over the derived code, as the
 * contents of a small file: {"v":1,"name":"..."}. Returns the length, or -1. */
long wh_pair_handshake_encode(const char *name, char *out, unsigned long cap);

/* Read a handshake. Returns 0 with the sender's name in `name`, or -1. */
int wh_pair_handshake_decode(const char *json, unsigned long len,
                             char *name, unsigned long cap);

/* The file name the handshake travels under; PAIRING_HANDSHAKE_FILE in core. */
#define WH_PAIR_HANDSHAKE_FILE "pg-pair-handshake.json"

#ifdef __cplusplus
}
#endif
#endif /* WH_PAIR_H */
