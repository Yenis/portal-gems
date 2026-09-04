#include "sha256.h"

/* --- SHA-256 ---------------------------------------------------------- */

#define M32 0xffffffffu
#define ROTR(x, n) ((((x) >> (n)) | ((x) << (32 - (n)))) & M32)
#define SHR(x, n)  (((x) >> (n)) & M32)
#define CH(x,y,z)  (((x) & (y)) ^ ((~(x)) & (z)))
#define MAJ(x,y,z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BSIG0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define BSIG1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SSIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ SHR(x, 3))
#define SSIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ SHR(x, 10))

static const unsigned int K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static void wh_sha256_block(wh_sha256_ctx *s, const unsigned char *p)
{
    unsigned int w[64];
    unsigned int a, b, c, d, e, f, g, h, t1, t2;
    int i;

    for (i = 0; i < 16; i++) {
        w[i] = ((unsigned int)p[i * 4] << 24) |
               ((unsigned int)p[i * 4 + 1] << 16) |
               ((unsigned int)p[i * 4 + 2] << 8) |
               ((unsigned int)p[i * 4 + 3]);
    }
    for (i = 16; i < 64; i++) {
        w[i] = (SSIG1(w[i - 2]) + w[i - 7] + SSIG0(w[i - 15]) + w[i - 16]) & M32;
    }

    a = s->state[0]; b = s->state[1]; c = s->state[2]; d = s->state[3];
    e = s->state[4]; f = s->state[5]; g = s->state[6]; h = s->state[7];

    for (i = 0; i < 64; i++) {
        t1 = (h + BSIG1(e) + CH(e, f, g) + K[i] + w[i]) & M32;
        t2 = (BSIG0(a) + MAJ(a, b, c)) & M32;
        h = g; g = f; f = e;
        e = (d + t1) & M32;
        d = c; c = b; b = a;
        a = (t1 + t2) & M32;
    }

    s->state[0] = (s->state[0] + a) & M32;
    s->state[1] = (s->state[1] + b) & M32;
    s->state[2] = (s->state[2] + c) & M32;
    s->state[3] = (s->state[3] + d) & M32;
    s->state[4] = (s->state[4] + e) & M32;
    s->state[5] = (s->state[5] + f) & M32;
    s->state[6] = (s->state[6] + g) & M32;
    s->state[7] = (s->state[7] + h) & M32;
}

void wh_sha256_init(wh_sha256_ctx *s)
{
    s->state[0] = 0x6a09e667u; s->state[1] = 0xbb67ae85u;
    s->state[2] = 0x3c6ef372u; s->state[3] = 0xa54ff53au;
    s->state[4] = 0x510e527fu; s->state[5] = 0x9b05688cu;
    s->state[6] = 0x1f83d9abu; s->state[7] = 0x5be0cd19u;
    s->buflen = 0;
    s->nbits_lo = 0;
    s->nbits_hi = 0;
}

void wh_sha256_update(wh_sha256_ctx *s, const unsigned char *data, unsigned long len)
{
    unsigned long i;
    unsigned int add;

    for (i = 0; i < len; i++) {
        s->buf[s->buflen++] = data[i];
        if (s->buflen == WH_SHA256_BLOCK) {
            wh_sha256_block(s, s->buf);
            s->buflen = 0;
        }
    }

    /* length in bits, carried by hand so we never need a 64-bit type */
    add = (unsigned int)((len << 3) & M32);
    s->nbits_hi = (s->nbits_hi + (unsigned int)(len >> 29)) & M32;
    if ((s->nbits_lo + add) > M32 || (s->nbits_lo + add) < s->nbits_lo) {
        s->nbits_hi = (s->nbits_hi + 1) & M32;
    }
    s->nbits_lo = (s->nbits_lo + add) & M32;
}

void wh_sha256_final(wh_sha256_ctx *s, unsigned char out[WH_SHA256_LEN])
{
    unsigned char pad[WH_SHA256_BLOCK * 2];
    unsigned int padlen;
    unsigned int hi = s->nbits_hi, lo = s->nbits_lo;
    int i;

    for (i = 0; i < WH_SHA256_BLOCK * 2; i++) pad[i] = 0;
    pad[0] = 0x80;
    /* pad so that (buflen + padlen) % 64 == 56, then 8 bytes of length */
    padlen = (s->buflen < 56) ? (56 - s->buflen) : (120 - s->buflen);
    pad[padlen + 0] = (unsigned char)((hi >> 24) & 0xff);
    pad[padlen + 1] = (unsigned char)((hi >> 16) & 0xff);
    pad[padlen + 2] = (unsigned char)((hi >> 8) & 0xff);
    pad[padlen + 3] = (unsigned char)(hi & 0xff);
    pad[padlen + 4] = (unsigned char)((lo >> 24) & 0xff);
    pad[padlen + 5] = (unsigned char)((lo >> 16) & 0xff);
    pad[padlen + 6] = (unsigned char)((lo >> 8) & 0xff);
    pad[padlen + 7] = (unsigned char)(lo & 0xff);

    /* update() would fold the padding into the bit count; harmless because
     * we read hi/lo above and never use them again. */
    wh_sha256_update(s, pad, (unsigned long)(padlen + 8));

    for (i = 0; i < 8; i++) {
        out[i * 4 + 0] = (unsigned char)((s->state[i] >> 24) & 0xff);
        out[i * 4 + 1] = (unsigned char)((s->state[i] >> 16) & 0xff);
        out[i * 4 + 2] = (unsigned char)((s->state[i] >> 8) & 0xff);
        out[i * 4 + 3] = (unsigned char)(s->state[i] & 0xff);
    }
}

void wh_sha256(const unsigned char *data, unsigned long len,
               unsigned char out[WH_SHA256_LEN])
{
    wh_sha256_ctx s;
    wh_sha256_init(&s);
    wh_sha256_update(&s, data, len);
    wh_sha256_final(&s, out);
}

/* --- HMAC-SHA256 ------------------------------------------------------ */

void wh_hmac_sha256(const unsigned char *key, unsigned long keylen,
                    const unsigned char *msg, unsigned long msglen,
                    unsigned char out[WH_SHA256_LEN])
{
    unsigned char k[WH_SHA256_BLOCK];
    unsigned char pad[WH_SHA256_BLOCK];
    unsigned char inner[WH_SHA256_LEN];
    wh_sha256_ctx s;
    int i;

    for (i = 0; i < WH_SHA256_BLOCK; i++) k[i] = 0;
    if (keylen > WH_SHA256_BLOCK) {
        wh_sha256(key, keylen, k);
    } else {
        unsigned long j;
        for (j = 0; j < keylen; j++) k[j] = key[j];
    }

    for (i = 0; i < WH_SHA256_BLOCK; i++) pad[i] = (unsigned char)(k[i] ^ 0x36);
    wh_sha256_init(&s);
    wh_sha256_update(&s, pad, WH_SHA256_BLOCK);
    wh_sha256_update(&s, msg, msglen);
    wh_sha256_final(&s, inner);

    for (i = 0; i < WH_SHA256_BLOCK; i++) pad[i] = (unsigned char)(k[i] ^ 0x5c);
    wh_sha256_init(&s);
    wh_sha256_update(&s, pad, WH_SHA256_BLOCK);
    wh_sha256_update(&s, inner, WH_SHA256_LEN);
    wh_sha256_final(&s, out);
}

/* --- HKDF-SHA256 ------------------------------------------------------ */

int wh_hkdf_sha256(const unsigned char *ikm, unsigned long ikm_len,
                   const unsigned char *info, unsigned long info_len,
                   unsigned char *out, unsigned long out_len)
{
    unsigned char salt[WH_SHA256_LEN];
    unsigned char prk[WH_SHA256_LEN];
    unsigned char t[WH_SHA256_LEN];
    unsigned char block[WH_SHA256_BLOCK];
    unsigned long done = 0;
    unsigned int counter = 1;
    unsigned int tlen = 0;
    int i;

    if (out_len > 255ul * WH_SHA256_LEN) return -1;

    /* Hkdf::new(None, ikm): a None salt is a block of zeros. */
    for (i = 0; i < WH_SHA256_LEN; i++) salt[i] = 0;
    wh_hmac_sha256(salt, WH_SHA256_LEN, ikm, ikm_len, prk);

    while (done < out_len) {
        wh_sha256_ctx s;
        unsigned char pad[WH_SHA256_BLOCK];
        unsigned char inner[WH_SHA256_LEN];
        unsigned char c = (unsigned char)counter;
        unsigned long n;

        /* T(i) = HMAC(prk, T(i-1) || info || i), streamed so `info` never
         * has to be copied into a fixed buffer. */
        for (i = 0; i < WH_SHA256_BLOCK; i++) pad[i] = 0;
        for (i = 0; i < WH_SHA256_LEN; i++) pad[i] = prk[i];
        for (i = 0; i < WH_SHA256_BLOCK; i++) block[i] = (unsigned char)(pad[i] ^ 0x36);
        wh_sha256_init(&s);
        wh_sha256_update(&s, block, WH_SHA256_BLOCK);
        if (tlen) wh_sha256_update(&s, t, tlen);
        wh_sha256_update(&s, info, info_len);
        wh_sha256_update(&s, &c, 1);
        wh_sha256_final(&s, inner);

        for (i = 0; i < WH_SHA256_BLOCK; i++) block[i] = (unsigned char)(pad[i] ^ 0x5c);
        wh_sha256_init(&s);
        wh_sha256_update(&s, block, WH_SHA256_BLOCK);
        wh_sha256_update(&s, inner, WH_SHA256_LEN);
        wh_sha256_final(&s, t);
        tlen = WH_SHA256_LEN;

        n = out_len - done;
        if (n > WH_SHA256_LEN) n = WH_SHA256_LEN;
        for (i = 0; i < (int)n; i++) out[done + i] = t[i];
        done += n;
        counter++;
    }
    return 0;
}
