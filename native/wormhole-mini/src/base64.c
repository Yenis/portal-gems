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
