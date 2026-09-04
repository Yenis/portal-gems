#include "sha1.h"

#define M32 0xffffffffu
#define ROTL(x, n) ((((x) << (n)) | (((x) & M32) >> (32 - (n)))) & M32)

static void wh_sha1_block(unsigned int h[5], const unsigned char *p)
{
    unsigned int w[80];
    unsigned int a, b, c, d, e, f, k, t;
    int i;

    for (i = 0; i < 16; i++) {
        w[i] = ((unsigned int)p[i * 4] << 24) |
               ((unsigned int)p[i * 4 + 1] << 16) |
               ((unsigned int)p[i * 4 + 2] << 8) |
               ((unsigned int)p[i * 4 + 3]);
    }
    for (i = 16; i < 80; i++) {
        w[i] = ROTL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4];
    for (i = 0; i < 80; i++) {
        if (i < 20)      { f = (b & c) | ((~b) & d);          k = 0x5a827999u; }
        else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ed9eba1u; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8f1bbcdcu; }
        else             { f = b ^ c ^ d;                     k = 0xca62c1d6u; }
        t = (ROTL(a, 5) + (f & M32) + e + k + w[i]) & M32;
        e = d; d = c; c = ROTL(b, 30); b = a; a = t;
    }
    h[0] = (h[0] + a) & M32; h[1] = (h[1] + b) & M32; h[2] = (h[2] + c) & M32;
    h[3] = (h[3] + d) & M32; h[4] = (h[4] + e) & M32;
}

void wh_sha1(const unsigned char *data, unsigned long len,
             unsigned char out[WH_SHA1_LEN])
{
    unsigned int h[5];
    unsigned char block[64];
    unsigned long i, nblocks, rest;
    unsigned long bits_lo = (len << 3) & M32;
    unsigned long bits_hi = (len >> 29) & M32;
    int j;

    h[0] = 0x67452301u; h[1] = 0xefcdab89u; h[2] = 0x98badcfeu;
    h[3] = 0x10325476u; h[4] = 0xc3d2e1f0u;

    nblocks = len / 64;
    for (i = 0; i < nblocks; i++) wh_sha1_block(h, data + i * 64);

    rest = len - nblocks * 64;
    for (i = 0; i < rest; i++) block[i] = data[nblocks * 64 + i];
    block[rest] = 0x80;
    for (i = rest + 1; i < 64; i++) block[i] = 0;

    if (rest >= 56) {
        wh_sha1_block(h, block);
        for (i = 0; i < 64; i++) block[i] = 0;
    }
    block[56] = (unsigned char)((bits_hi >> 24) & 0xff);
    block[57] = (unsigned char)((bits_hi >> 16) & 0xff);
    block[58] = (unsigned char)((bits_hi >> 8) & 0xff);
    block[59] = (unsigned char)(bits_hi & 0xff);
    block[60] = (unsigned char)((bits_lo >> 24) & 0xff);
    block[61] = (unsigned char)((bits_lo >> 16) & 0xff);
    block[62] = (unsigned char)((bits_lo >> 8) & 0xff);
    block[63] = (unsigned char)(bits_lo & 0xff);
    wh_sha1_block(h, block);

    for (j = 0; j < 5; j++) {
        out[j * 4 + 0] = (unsigned char)((h[j] >> 24) & 0xff);
        out[j * 4 + 1] = (unsigned char)((h[j] >> 16) & 0xff);
        out[j * 4 + 2] = (unsigned char)((h[j] >> 8) & 0xff);
        out[j * 4 + 3] = (unsigned char)(h[j] & 0xff);
    }
}
