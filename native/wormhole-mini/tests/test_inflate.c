/* DEFLATE decompression, checked against streams produced by zlib.
 *
 * Each payload is fed in through the callback in deliberately awkward chunk
 * sizes, because the bit reader refilling mid-code is exactly where a
 * hand-written inflate goes wrong. */
#include <stdio.h>
#include <string.h>

#include "../src/inflate.h"
#include "../src/crc32.h"
#include "vectors/inflate_vectors.h"

static int failures = 0;
static int checks = 0;

static void check(const char *what, int ok)
{
    checks++;
    if (!ok) {
        printf("FAIL %s\n", what);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

/* Feeds the compressed stream `chunk` bytes at a time. */
typedef struct {
    const unsigned char *data;
    unsigned long size;
    unsigned long pos;
    unsigned long chunk;
} TSource;

static long source_read(void *ctx, unsigned char *buf, unsigned long cap)
{
    TSource *s = (TSource *)ctx;
    unsigned long n = s->size - s->pos;
    if (n > cap) n = cap;
    if (n > s->chunk) n = s->chunk;
    memcpy(buf, s->data + s->pos, (size_t)n);
    s->pos += n;
    return (long)n;
}

typedef struct {
    unsigned long len;
    unsigned long crc;
} TSink;

static int sink_write(void *ctx, const unsigned char *buf, unsigned long len)
{
    TSink *k = (TSink *)ctx;
    k->crc = wh_crc32(k->crc, buf, len);
    k->len += len;
    return 0;
}

/* Refuses everything, to prove the abort path is honoured. */
static int sink_refuse(void *ctx, const unsigned char *buf, unsigned long len)
{
    (void)ctx; (void)buf; (void)len;
    return -1;
}

static wh_inflate_state g_state;

int main(void)
{
    unsigned long chunks[4];
    int ci, i;

    /* CRC-32 first: everything below is checked with it, so it has to be
     * right before it can be trusted as an oracle. */
    check("crc32(\"\")", wh_crc32(0, (const unsigned char *)"", 0) == 0UL);
    check("crc32(\"123456789\") == 0xcbf43926",
          wh_crc32(0, (const unsigned char *)"123456789", 9) == 0xcbf43926UL);
    check("crc32(\"a\") == 0xe8b7be43",
          wh_crc32(0, (const unsigned char *)"a", 1) == 0xe8b7be43UL);

    chunks[0] = 1;       /* one byte at a time: refill inside every code */
    chunks[1] = 7;       /* prime, so boundaries never line up */
    chunks[2] = 1024;
    chunks[3] = 100000;  /* effectively all at once */

    for (ci = 0; ci < 4; ci++) {
        for (i = 0; i < (int)(sizeof(WH_IV_CASES) / sizeof(WH_IV_CASES[0])); i++) {
            const wh_iv_case *c = &WH_IV_CASES[i];
            TSource src;
            TSink sink;
            char what[128];
            int rc;

            src.data = c->data;
            src.size = c->size;
            src.pos = 0;
            src.chunk = chunks[ci];
            sink.len = 0;
            sink.crc = 0;

            rc = wh_inflate(&g_state, source_read, &src, sink_write, &sink);

            sprintf(what, "%s (chunk %lu)", c->name, chunks[ci]);
            if (rc != WH_INFLATE_OK) {
                checks++;
                failures++;
                printf("FAIL %s: rc=%d\n", what, rc);
            } else if (sink.len != c->expect_len) {
                checks++;
                failures++;
                printf("FAIL %s: length %lu, expected %lu\n",
                       what, sink.len, c->expect_len);
            } else if (sink.crc != c->expect_crc) {
                checks++;
                failures++;
                printf("FAIL %s: crc %08lx, expected %08lx\n",
                       what, sink.crc, c->expect_crc);
            } else {
                checks++;
                printf("ok   %s -> %lu bytes\n", what, sink.len);
            }
        }
    }

    /* Rejection paths: garbage must fail, not run away or crash. */
    {
        TSource src;
        TSink sink;
        int rc;

        src.data = WH_IV_CORRUPT;
        src.size = sizeof(WH_IV_CORRUPT);
        src.pos = 0;
        src.chunk = 4096;
        sink.len = 0;
        sink.crc = 0;
        rc = wh_inflate(&g_state, source_read, &src, sink_write, &sink);
        check("a corrupt stream is rejected", rc != WH_INFLATE_OK);

        /* Truncated input: valid prefix, no end. */
        src.data = WH_IV_TEXT_DEFLATED;
        src.size = sizeof(WH_IV_TEXT_DEFLATED) / 2;
        src.pos = 0;
        src.chunk = 4096;
        sink.len = 0;
        sink.crc = 0;
        rc = wh_inflate(&g_state, source_read, &src, sink_write, &sink);
        check("a truncated stream is rejected", rc == WH_INFLATE_EINPUT);

        /* A sink that refuses must stop the whole thing. */
        src.data = WH_IV_TEXT_DEFLATED;
        src.size = sizeof(WH_IV_TEXT_DEFLATED);
        src.pos = 0;
        src.chunk = 4096;
        rc = wh_inflate(&g_state, source_read, &src, sink_refuse, 0);
        check("an aborting sink stops decompression", rc == WH_INFLATE_EOUTPUT);
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
