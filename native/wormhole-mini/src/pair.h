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
/* The JSON inside a payload, before base64url. Kept well below the payload
 * limit because these buffers are locals, and the phone's worker thread can
 * be given as little as 8 KB of stack: a name of 128 bytes plus a 43-byte
 * secret needs about 200, so 512 is room to spare without spending the
 * stack the protocol itself needs. */
#define WH_PAIR_JSON_MAX       512
#define WH_PAIR_BUCKET_SECONDS 300
/* How many codes each bucket holds: PAIRED_CODE_ATTEMPTS in core. A sender
 * that stopped without finishing still holds its claim on the code it used,
 * so a retry inside the same bucket moves on to the next one, and a receiver
 * looks for all of them. */
#define WH_PAIR_CODE_ATTEMPTS  3

/* What a pairing invitation carries: the displaying device's name and the
 * long-term secret both sides will derive codes from. */
typedef struct {
    char name[WH_PAIR_NAME_MAX];
    unsigned char secret[WH_PAIR_SECRET_LEN];
    /* Non-zero when the device that made this payload can be handed the
     * handshake as a text message ("hs":"msg"), which needs no transit at
     * all; zero means it only knows the original file form, which does.
     * Every sender must honour it - that is what lets this client pair with
     * a PortalGems that predates the message form, and the other way round.
     * Always set it explicitly: encode writes the key only when it is set,
     * so a payload without it is byte-for-byte what every earlier version
     * produced. */
    int wants_message;
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

/* The same for one of the later codes a bucket holds: attempt 0 is
 * wh_pair_derive_code to the byte, and attempt n > 0 hashes
 * "portalgems-code-v1:<bucket>:<n>", as core's deriveCode does. */
void wh_pair_derive_attempt(const unsigned char secret[WH_PAIR_SECRET_LEN],
                            unsigned long bucket, unsigned int attempt,
                            char out[WH_PAIR_CODE_MAX]);

/* A paired send that was started and never seen through: the code it used
 * must be assumed to hold a claim until its bucket is over. Whoever stores
 * pairings keeps one of these beside each; `pending` zero means none. */
typedef struct {
    int pending;
    unsigned long bucket;
    unsigned int attempt;
} wh_pair_send_marker;

/* Which attempt the next send should use, as core's nextSendAttempt: the one
 * after whatever was left in flight in this bucket, 0 when nothing was or
 * the marker is from another bucket, and the last one again once they are
 * all used. */
unsigned int wh_pair_next_attempt(const wh_pair_send_marker *marker,
                                  unsigned long bucket);

/* "PGPAIR1:" + base64url(JSON {"v":1,"name":...,"secret":...}), plus
 * "hs":"msg" when `wants_message` is set. Returns the length, or -1 if `cap`
 * is too small. */
long wh_pair_encode(const wh_pair_payload *p, char *out, unsigned long cap);

/* Parse an invitation, tolerating surrounding whitespace. Returns 0, or -1 for
 * anything that is not a v1 payload with a 32-byte secret - the same things
 * parsePairingPayload rejects. A name too long for WH_PAIR_NAME_MAX is not a
 * reason to refuse a pairing; it is replaced rather than truncated mid-way
 * through a character. */
int wh_pair_decode(const char *text, unsigned long len, wh_pair_payload *out);

/* The handshake the joining side sends back over the derived code:
 * {"v":1,"name":"..."}. Sent as a text message when the invitation asked for
 * one (`wants_message`), otherwise as the contents of a small file. Returns
 * the length, or -1. */
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
