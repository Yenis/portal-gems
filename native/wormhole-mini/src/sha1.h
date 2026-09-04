/* SHA-1, needed only to validate the WebSocket opening handshake
 * (RFC 6455 Sec-WebSocket-Accept). It is not used for anything
 * security-relevant and must not be - every key in this project comes from
 * SHA-256 via src/sha256.c. */
#ifndef WH_SHA1_H
#define WH_SHA1_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_SHA1_LEN 20

void wh_sha1(const unsigned char *data, unsigned long len,
             unsigned char out[WH_SHA1_LEN]);

#ifdef __cplusplus
}
#endif
#endif /* WH_SHA1_H */
