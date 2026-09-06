#include "zipw.h"
#include "crc32.h"

#define SIG_LOCAL  0x04034b50UL
#define SIG_DESC   0x08074b50UL
#define SIG_CD     0x02014b50UL
#define SIG_EOCD   0x06054b50UL

/* Bit 3: sizes and CRC follow the data in a descriptor. */
#define FLAG_DESCRIPTOR 0x0008

/* 1980-01-01. A zero date is not valid DOS and upsets some tools; the
 * transfer carries no timestamps anyway, so a fixed one is honest. */
#define DOS_DATE 0x0021
#define DOS_TIME 0x0000

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

static void put16(unsigned char *p, unsigned long v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
}

static void put32(unsigned char *p, unsigned long v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
    p[2] = (unsigned char)((v >> 16) & 0xff);
    p[3] = (unsigned char)((v >> 24) & 0xff);
}

static int emit(wh_zipw *w, const unsigned char *buf, unsigned long len)
{
    if (w->error) return w->error;
    if (w->out(w->ctx, buf, len) != 0) {
        w->error = WH_ZIPW_EOUTPUT;
        return w->error;
    }
    w->offset += len;
    return WH_ZIPW_OK;
}

/* Append one central-directory record for an entry just finished. */
static int record(wh_zipw *w, const char *name, unsigned long crc,
                  unsigned long size, unsigned long local_offset,
                  int is_dir)
{
    unsigned long namelen = wh_strlen(name);
    unsigned char *p;
    unsigned long i;

    if (w->cd_len + 46 + namelen > w->cd_cap) {
        w->error = WH_ZIPW_EFULL;
        return w->error;
    }

    p = w->cd + w->cd_len;
    put32(p, SIG_CD);
    put16(p + 4, 20);            /* made by */
    put16(p + 6, 20);            /* needed to extract */
    put16(p + 8, FLAG_DESCRIPTOR);
    put16(p + 10, 0);            /* stored */
    put16(p + 12, DOS_TIME);
    put16(p + 14, DOS_DATE);
    put32(p + 16, crc);
    put32(p + 20, size);         /* compressed == uncompressed */
    put32(p + 24, size);
    put16(p + 28, namelen);
    put16(p + 30, 0);            /* extra */
    put16(p + 32, 0);            /* comment */
    put16(p + 34, 0);            /* disk */
    put16(p + 36, 0);            /* internal attrs */
    /* External attributes: mark directories, so a reader that only looks
     * here still gets it right. */
    put32(p + 38, is_dir ? 0x10UL : 0UL);
    put32(p + 42, local_offset);
    for (i = 0; i < namelen; i++) p[46 + i] = (unsigned char)name[i];

    w->cd_len += 46 + namelen;
    w->count++;
    return WH_ZIPW_OK;
}

static int local_header(wh_zipw *w, const char *name)
{
    unsigned char hdr[30];
    unsigned long namelen = wh_strlen(name);

    put32(hdr, SIG_LOCAL);
    put16(hdr + 4, 20);
    put16(hdr + 6, FLAG_DESCRIPTOR);
    put16(hdr + 8, 0);           /* stored */
    put16(hdr + 10, DOS_TIME);
    put16(hdr + 12, DOS_DATE);
    put32(hdr + 14, 0);          /* crc, in the descriptor */
    put32(hdr + 18, 0);          /* sizes, in the descriptor */
    put32(hdr + 22, 0);
    put16(hdr + 26, namelen);
    put16(hdr + 28, 0);

    if (emit(w, hdr, sizeof(hdr)) != WH_ZIPW_OK) return w->error;
    return emit(w, (const unsigned char *)name, namelen);
}

static int descriptor(wh_zipw *w, unsigned long crc, unsigned long size)
{
    unsigned char d[16];
    put32(d, SIG_DESC);
    put32(d + 4, crc);
    put32(d + 8, size);
    put32(d + 12, size);
    return emit(w, d, sizeof(d));
}

void wh_zipw_init(wh_zipw *w, wh_zipw_out out, void *ctx,
                  unsigned char *cd_buf, unsigned long cd_cap)
{
    w->out = out;
    w->ctx = ctx;
    w->offset = 0;
    w->cd = cd_buf;
    w->cd_cap = cd_cap;
    w->cd_len = 0;
    w->count = 0;
    w->in_entry = 0;
    w->entry_offset = 0;
    w->entry_crc = 0;
    w->entry_size = 0;
    w->error = WH_ZIPW_OK;
}

int wh_zipw_add_dir(wh_zipw *w, const char *name)
{
    unsigned long at;

    if (w->error) return w->error;
    if (w->in_entry) return WH_ZIPW_ESTATE;

    at = w->offset;
    if (local_header(w, name) != WH_ZIPW_OK) return w->error;
    if (descriptor(w, 0, 0) != WH_ZIPW_OK) return w->error;
    return record(w, name, 0, 0, at, 1);
}

int wh_zipw_begin_file(wh_zipw *w, const char *name)
{
    if (w->error) return w->error;
    if (w->in_entry) return WH_ZIPW_ESTATE;

    {
        unsigned long namelen = wh_strlen(name);
        unsigned long i;
        if (namelen >= sizeof(w->entry_name)) {
            w->error = WH_ZIPW_EFULL;
            return w->error;
        }
        for (i = 0; i <= namelen; i++) w->entry_name[i] = name[i];
    }

    w->entry_offset = w->offset;
    w->entry_crc = 0;
    w->entry_size = 0;
    w->in_entry = 1;

    return local_header(w, name);
}

int wh_zipw_write(wh_zipw *w, const unsigned char *data, unsigned long len)
{
    if (w->error) return w->error;
    if (!w->in_entry) return WH_ZIPW_ESTATE;

    w->entry_crc = wh_crc32(w->entry_crc, data, len);
    w->entry_size += len;
    return emit(w, data, len);
}

int wh_zipw_end_file(wh_zipw *w)
{
    if (w->error) return w->error;
    if (!w->in_entry) return WH_ZIPW_ESTATE;

    if (descriptor(w, w->entry_crc, w->entry_size) != WH_ZIPW_OK) return w->error;

    w->in_entry = 0;
    return record(w, w->entry_name, w->entry_crc, w->entry_size,
                  w->entry_offset, 0);
}

int wh_zipw_finish(wh_zipw *w)
{
    unsigned char eocd[22];
    unsigned long cd_at;

    if (w->error) return w->error;
    if (w->in_entry) return WH_ZIPW_ESTATE;

    /* The end record holds the entry count in sixteen bits. Refuse rather
     * than wrap: a truncated count produces an archive that opens and is
     * quietly missing files. */
    if (w->count > 65535UL) {
        w->error = WH_ZIPW_EFULL;
        return w->error;
    }

    cd_at = w->offset;
    if (emit(w, w->cd, w->cd_len) != WH_ZIPW_OK) return w->error;

    put32(eocd, SIG_EOCD);
    put16(eocd + 4, 0);
    put16(eocd + 6, 0);
    put16(eocd + 8, w->count);
    put16(eocd + 10, w->count);
    put32(eocd + 12, w->cd_len);
    put32(eocd + 16, cd_at);
    put16(eocd + 20, 0);
    return emit(w, eocd, sizeof(eocd));
}
