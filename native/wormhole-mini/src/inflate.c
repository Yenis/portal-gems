#include "inflate.h"

/* Length codes 257..285: base length and extra bits. */
static const short LEN_BASE[29] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
};
static const short LEN_EXTRA[29] = {
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
};
/* Distance codes 0..29. */
static const short DIST_BASE[30] = {
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
    12289, 16385, 24577
};
static const short DIST_EXTRA[30] = {
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
};
/* The order dynamic blocks store code-length code lengths in. */
static const short CLEN_ORDER[19] = {
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
};

static int refill(wh_inflate_state *s)
{
    long got;
    if (s->in_eof) return 0;
    got = s->in(s->in_ctx, s->inbuf, sizeof(s->inbuf));
    if (got < 0) return -1;
    if (got == 0) {
        s->in_eof = 1;
        return 0;
    }
    s->in_len = (unsigned long)got;
    s->in_pos = 0;
    return 1;
}

/* Read `need` bits, least significant first. Returns -1 if input runs out. */
static long bits(wh_inflate_state *s, int need)
{
    long value = (long)s->bitbuf;

    while (s->bitcnt < need) {
        if (s->in_pos >= s->in_len) {
            int r = refill(s);
            if (r < 0) return -1;
            if (r == 0) return -1;
        }
        value |= (long)s->inbuf[s->in_pos++] << s->bitcnt;
        s->bitcnt += 8;
    }

    s->bitbuf = (unsigned long)(value >> need);
    s->bitcnt -= need;
    return value & ((1L << need) - 1);
}

static int emit(wh_inflate_state *s, unsigned char b)
{
    s->window[s->wpos++] = b;
    s->written++;
    if (s->wpos == WH_INFLATE_WINDOW) {
        if (s->out(s->out_ctx, s->window, WH_INFLATE_WINDOW) != 0) return -1;
        s->wpos = 0;
    }
    return 0;
}

static int flush_tail(wh_inflate_state *s)
{
    if (s->wpos == 0) return 0;
    if (s->out(s->out_ctx, s->window, s->wpos) != 0) return -1;
    s->wpos = 0;
    return 0;
}

/* Canonical Huffman decode: walk the code lengths shortest first. */
static int decode(wh_inflate_state *s, const short *count, const short *symbol)
{
    int len, code = 0, first = 0, index = 0;

    for (len = 1; len <= 15; len++) {
        long b = bits(s, 1);
        if (b < 0) return -1;
        code |= (int)b;
        {
            int cnt = count[len];
            if (code - cnt < first) return symbol[index + (code - first)];
            index += cnt;
            first += cnt;
            first <<= 1;
            code <<= 1;
        }
    }
    return -1;
}

/* Build the count/symbol pair a canonical decoder needs. */
static int construct(short *count, short *symbol, const short *length, int n)
{
    int i, len, left;
    short offs[16];

    for (len = 0; len <= 15; len++) count[len] = 0;
    for (i = 0; i < n; i++) count[length[i]]++;
    if (count[0] == n) return 0;   /* an empty code is legal (unused table) */

    left = 1;
    for (len = 1; len <= 15; len++) {
        left <<= 1;
        left -= count[len];
        if (left < 0) return left;  /* over-subscribed */
    }

    offs[1] = 0;
    for (len = 1; len < 15; len++) offs[len + 1] = (short)(offs[len] + count[len]);
    for (i = 0; i < n; i++) {
        if (length[i] != 0) symbol[offs[length[i]]++] = (short)i;
    }
    return left;
}

static int stored_block(wh_inflate_state *s)
{
    long len, nlen;
    long i;

    /* Stored blocks start on a byte boundary. */
    s->bitbuf = 0;
    s->bitcnt = 0;

    len = bits(s, 16);
    if (len < 0) return WH_INFLATE_EINPUT;
    nlen = bits(s, 16);
    if (nlen < 0) return WH_INFLATE_EINPUT;
    if ((len ^ 0xffff) != nlen) return WH_INFLATE_EFORMAT;

    for (i = 0; i < len; i++) {
        long b = bits(s, 8);
        if (b < 0) return WH_INFLATE_EINPUT;
        if (emit(s, (unsigned char)b) != 0) return WH_INFLATE_EOUTPUT;
    }
    return WH_INFLATE_OK;
}

static void fixed_tables(wh_inflate_state *s)
{
    int i;
    for (i = 0; i < 144; i++) s->lengths[i] = 8;
    for (; i < 256; i++) s->lengths[i] = 9;
    for (; i < 280; i++) s->lengths[i] = 7;
    for (; i < 288; i++) s->lengths[i] = 8;
    construct(s->lit_count, s->lit_symbol, s->lengths, 288);

    for (i = 0; i < 30; i++) s->lengths[i] = 5;
    construct(s->dist_count, s->dist_symbol, s->lengths, 30);
}

static int dynamic_tables(wh_inflate_state *s)
{
    long nlen, ndist, ncode;
    int i, err;
    short clen_count[16];
    short clen_symbol[19];

    nlen = bits(s, 5);
    ndist = bits(s, 5);
    ncode = bits(s, 4);
    if (nlen < 0 || ndist < 0 || ncode < 0) return WH_INFLATE_EINPUT;
    nlen += 257;
    ndist += 1;
    ncode += 4;
    if (nlen > 286 || ndist > 30) return WH_INFLATE_EFORMAT;

    for (i = 0; i < 19; i++) s->lengths[i] = 0;
    for (i = 0; i < ncode; i++) {
        long b = bits(s, 3);
        if (b < 0) return WH_INFLATE_EINPUT;
        s->lengths[CLEN_ORDER[i]] = (short)b;
    }
    err = construct(clen_count, clen_symbol, s->lengths, 19);
    if (err != 0) return WH_INFLATE_EFORMAT;

    i = 0;
    while (i < nlen + ndist) {
        int sym = decode(s, clen_count, clen_symbol);
        if (sym < 0) return WH_INFLATE_EINPUT;

        if (sym < 16) {
            s->lengths[i++] = (short)sym;
        } else {
            short value = 0;
            long repeat;
            if (sym == 16) {
                if (i == 0) return WH_INFLATE_EFORMAT;
                value = s->lengths[i - 1];
                repeat = bits(s, 2);
                if (repeat < 0) return WH_INFLATE_EINPUT;
                repeat += 3;
            } else if (sym == 17) {
                repeat = bits(s, 3);
                if (repeat < 0) return WH_INFLATE_EINPUT;
                repeat += 3;
            } else {
                repeat = bits(s, 7);
                if (repeat < 0) return WH_INFLATE_EINPUT;
                repeat += 11;
            }
            if (i + repeat > nlen + ndist) return WH_INFLATE_EFORMAT;
            while (repeat--) s->lengths[i++] = value;
        }
    }
    if (s->lengths[256] == 0) return WH_INFLATE_EFORMAT;  /* no end-of-block */

    err = construct(s->lit_count, s->lit_symbol, s->lengths, (int)nlen);
    if (err && (err < 0 || nlen != s->lit_count[0] + s->lit_count[1])) {
        return WH_INFLATE_EFORMAT;
    }
    err = construct(s->dist_count, s->dist_symbol, s->lengths + nlen, (int)ndist);
    if (err && (err < 0 || ndist != s->dist_count[0] + s->dist_count[1])) {
        return WH_INFLATE_EFORMAT;
    }
    return WH_INFLATE_OK;
}

static int coded_block(wh_inflate_state *s)
{
    for (;;) {
        int sym = decode(s, s->lit_count, s->lit_symbol);
        if (sym < 0) return WH_INFLATE_EINPUT;

        if (sym < 256) {
            if (emit(s, (unsigned char)sym) != 0) return WH_INFLATE_EOUTPUT;
        } else if (sym == 256) {
            return WH_INFLATE_OK;
        } else {
            long len, dist, extra;
            unsigned long i;

            sym -= 257;
            if (sym >= 29) return WH_INFLATE_EFORMAT;
            extra = bits(s, LEN_EXTRA[sym]);
            if (extra < 0) return WH_INFLATE_EINPUT;
            len = LEN_BASE[sym] + extra;

            sym = decode(s, s->dist_count, s->dist_symbol);
            if (sym < 0) return WH_INFLATE_EINPUT;
            if (sym >= 30) return WH_INFLATE_EFORMAT;
            extra = bits(s, DIST_EXTRA[sym]);
            if (extra < 0) return WH_INFLATE_EINPUT;
            dist = DIST_BASE[sym] + extra;

            if ((unsigned long)dist > WH_INFLATE_WINDOW) return WH_INFLATE_EFORMAT;
            /* A reference reaching further back than we have produced would
             * read window bytes that were never written. */
            if ((unsigned long)dist > s->written) return WH_INFLATE_EFORMAT;

            for (i = 0; i < (unsigned long)len; i++) {
                unsigned long src =
                    (s->wpos + WH_INFLATE_WINDOW - (unsigned long)dist)
                    & (WH_INFLATE_WINDOW - 1);
                if (emit(s, s->window[src]) != 0) return WH_INFLATE_EOUTPUT;
            }
        }
    }
}

int wh_inflate(wh_inflate_state *s, wh_inflate_in in, void *in_ctx,
               wh_inflate_out out, void *out_ctx)
{
    int last = 0;

    s->in = in;
    s->in_ctx = in_ctx;
    s->out = out;
    s->out_ctx = out_ctx;
    s->in_len = 0;
    s->in_pos = 0;
    s->in_eof = 0;
    s->bitbuf = 0;
    s->bitcnt = 0;
    s->wpos = 0;
    s->written = 0;

    while (!last) {
        long final, type;
        int rc;

        final = bits(s, 1);
        if (final < 0) return WH_INFLATE_EINPUT;
        type = bits(s, 2);
        if (type < 0) return WH_INFLATE_EINPUT;
        last = (int)final;

        if (type == 0) {
            rc = stored_block(s);
        } else if (type == 1) {
            fixed_tables(s);
            rc = coded_block(s);
        } else if (type == 2) {
            rc = dynamic_tables(s);
            if (rc == WH_INFLATE_OK) rc = coded_block(s);
        } else {
            rc = WH_INFLATE_EFORMAT;
        }
        if (rc != WH_INFLATE_OK) return rc;
    }

    if (flush_tail(s) != 0) return WH_INFLATE_EOUTPUT;
    return WH_INFLATE_OK;
}
