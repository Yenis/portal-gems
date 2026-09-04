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

#ifdef __cplusplus
}
#endif
#endif /* WH_BASE64_H */
