#include "base64.h"

static const char TBL[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

long wh_base64_encode(const unsigned char *in, unsigned long len,
                      char *out, unsigned long cap)
{
    unsigned long i = 0, o = 0;
    unsigned long need = ((len + 2) / 3) * 4;

    if (cap < need + 1) return -1;

    while (i + 2 < len) {
        unsigned long v = ((unsigned long)in[i] << 16) |
                          ((unsigned long)in[i + 1] << 8) |
                          (unsigned long)in[i + 2];
        out[o++] = TBL[(v >> 18) & 0x3f];
        out[o++] = TBL[(v >> 12) & 0x3f];
        out[o++] = TBL[(v >> 6) & 0x3f];
        out[o++] = TBL[v & 0x3f];
        i += 3;
    }
    if (len - i == 1) {
        unsigned long v = (unsigned long)in[i] << 16;
        out[o++] = TBL[(v >> 18) & 0x3f];
        out[o++] = TBL[(v >> 12) & 0x3f];
        out[o++] = '=';
        out[o++] = '=';
    } else if (len - i == 2) {
        unsigned long v = ((unsigned long)in[i] << 16) |
                          ((unsigned long)in[i + 1] << 8);
        out[o++] = TBL[(v >> 18) & 0x3f];
        out[o++] = TBL[(v >> 12) & 0x3f];
        out[o++] = TBL[(v >> 6) & 0x3f];
        out[o++] = '=';
    }
    out[o] = '\0';
    return (long)o;
}

/* base64url (RFC 4648 section 5) without padding - the form PortalGems
 * pairing payloads and secrets use, matching toBase64Url/fromBase64Url in
 * packages/core/src/pairing.ts. */
static const char URL_TBL[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

long wh_base64url_encode(const unsigned char *in, unsigned long len,
                         char *out, unsigned long cap)
{
    unsigned long i = 0, o = 0;
    unsigned long need = (len / 3) * 4 + (len % 3 ? len % 3 + 1 : 0);

    if (cap < need + 1) return -1;

    while (i + 2 < len) {
        unsigned long v = ((unsigned long)in[i] << 16) |
                          ((unsigned long)in[i + 1] << 8) |
                          (unsigned long)in[i + 2];
        out[o++] = URL_TBL[(v >> 18) & 0x3f];
        out[o++] = URL_TBL[(v >> 12) & 0x3f];
        out[o++] = URL_TBL[(v >> 6) & 0x3f];
        out[o++] = URL_TBL[v & 0x3f];
        i += 3;
    }
    if (len - i == 1) {
        unsigned long v = (unsigned long)in[i] << 16;
        out[o++] = URL_TBL[(v >> 18) & 0x3f];
        out[o++] = URL_TBL[(v >> 12) & 0x3f];
    } else if (len - i == 2) {
        unsigned long v = ((unsigned long)in[i] << 16) |
                          ((unsigned long)in[i + 1] << 8);
        out[o++] = URL_TBL[(v >> 18) & 0x3f];
        out[o++] = URL_TBL[(v >> 12) & 0x3f];
        out[o++] = URL_TBL[(v >> 6) & 0x3f];
    }
    out[o] = '\0';
    return (long)o;
}

static int url_val(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}

long wh_base64url_decode(const char *in, unsigned long len,
                         unsigned char *out, unsigned long cap)
{
    unsigned long i, o = 0;
    unsigned long buffer = 0;
    int bits = 0;

    /* Trailing '=' is tolerated, as the JS decoder tolerates it. */
    while (len > 0 && in[len - 1] == '=') len--;
    /* A single leftover character carries fewer than 8 bits and cannot be
     * valid output of any encoder. */
    if (len % 4 == 1) return -1;

    for (i = 0; i < len; i++) {
        int v = url_val(in[i]);
        if (v < 0) return -1;
        buffer = ((buffer << 6) | (unsigned long)v) & 0xffffffUL;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (o >= cap) return -1;
            out[o++] = (unsigned char)((buffer >> bits) & 0xff);
        }
    }
    return (long)o;
}
