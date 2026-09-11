/* Base64, for the WebSocket handshake headers. */
#ifndef WH_BASE64_H
#define WH_BASE64_H

#ifdef __cplusplus
extern "C" {
#endif

/* Writes 4*ceil(len/3) characters plus a NUL. Returns the length written,
 * or -1 if `cap` is too small. */
long wh_base64_encode(const unsigned char *in, unsigned long len,
                      char *out, unsigned long cap);

/* base64url without padding. Encode returns the length written (excluding
 * the NUL) or -1 if `cap` is too small; decode returns the byte count, or -1
 * on a character outside the alphabet, an impossible length, or a buffer
 * that is too small. */
long wh_base64url_encode(const unsigned char *in, unsigned long len,
                         char *out, unsigned long cap);
long wh_base64url_decode(const char *in, unsigned long len,
                         unsigned char *out, unsigned long cap);

#ifdef __cplusplus
}
#endif
#endif /* WH_BASE64_H */
