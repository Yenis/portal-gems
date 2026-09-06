/* Raw DEFLATE decompression (RFC 1951), streaming.
 *
 * Input arrives through a callback and output leaves through one, so a
 * folder of any size decompresses in a fixed 34 KB of state - the 32 KB
 * sliding window the format requires, plus tables. Nothing is allocated;
 * the caller owns the state, which is far too large for an 8 KB Symbian
 * thread stack and belongs in static storage. */
#ifndef WH_INFLATE_H
#define WH_INFLATE_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_INFLATE_WINDOW 32768

/* Fill `buf` with up to `cap` more compressed bytes. Return the count, 0 at
 * end of input, or -1 on error. */
typedef long (*wh_inflate_in)(void *ctx, unsigned char *buf, unsigned long cap);
/* Consume decompressed bytes. Return 0 to continue, non-zero to abort. */
typedef int (*wh_inflate_out)(void *ctx, const unsigned char *buf,
                              unsigned long len);

typedef struct {
    wh_inflate_in in;
    void *in_ctx;
    wh_inflate_out out;
    void *out_ctx;

    unsigned char inbuf[1024];
    unsigned long in_len;
    unsigned long in_pos;
    int in_eof;

    unsigned long bitbuf;
    int bitcnt;

    unsigned char window[WH_INFLATE_WINDOW];
    unsigned long wpos;

    short lit_count[16];
    short lit_symbol[288];
    short dist_count[16];
    short dist_symbol[30];
    short lengths[320];   /* scratch for dynamic block code lengths */

    unsigned long written;  /* total bytes produced */
} wh_inflate_state;

#define WH_INFLATE_OK        0
#define WH_INFLATE_EINPUT   -1   /* ran out of input, or the reader failed */
#define WH_INFLATE_EFORMAT  -2   /* not a valid deflate stream */
#define WH_INFLATE_EOUTPUT  -3   /* the sink asked to stop */

/* Decompress one complete raw deflate stream. */
int wh_inflate(wh_inflate_state *s, wh_inflate_in in, void *in_ctx,
               wh_inflate_out out, void *out_ctx);

#ifdef __cplusplus
}
#endif
#endif /* WH_INFLATE_H */
