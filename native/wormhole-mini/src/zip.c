#include "zip.h"
#include "crc32.h"

#define SIG_EOCD   0x06054b50UL
#define SIG_CD     0x02014b50UL
#define SIG_LOCAL  0x04034b50UL

#define EOCD_MIN 22
/* The end record may be followed by a comment of up to 64 KB. */
#define EOCD_SCAN (EOCD_MIN + 65535UL)

static unsigned long rd16(const unsigned char *p)
{
    return (unsigned long)p[0] | ((unsigned long)p[1] << 8);
}

static unsigned long rd32(const unsigned char *p)
{
    return (unsigned long)p[0] | ((unsigned long)p[1] << 8) |
           ((unsigned long)p[2] << 16) | ((unsigned long)p[3] << 24);
}

static int read_at(wh_zip *z, unsigned long off, unsigned char *buf,
                   unsigned long len)
{
    long got;
    if (off > z->size || len > z->size - off) return WH_ZIP_EFORMAT;
    got = z->read(z->ctx, off, buf, len);
    if (got < 0 || (unsigned long)got != len) return WH_ZIP_EIO;
    return WH_ZIP_OK;
}

/* Locate the end-of-central-directory record. It sits at the very end
 * unless the archive has a comment, which may be up to 64 KB, so the search
 * runs backwards in overlapping windows rather than reading 64 KB at once -
 * a buffer that size is real memory on this device. */
static int find_eocd(wh_zip *z, unsigned long *out_offset)
{
    unsigned char win[512];
    unsigned long limit;      /* earliest offset the record could start at */
    unsigned long end;        /* scanning backwards from here */

    if (z->size < EOCD_MIN) return WH_ZIP_EFORMAT;

    limit = z->size > EOCD_SCAN ? z->size - EOCD_SCAN : 0;
    end = z->size;

    while (end > limit) {
        unsigned long chunk = sizeof(win);
        unsigned long from;
        unsigned long i;
        int rc;

        if (end - limit < chunk) chunk = end - limit;
        from = end - chunk;

        rc = read_at(z, from, win, chunk);
        if (rc != WH_ZIP_OK) return rc;

        /* Backwards, so the last record in the file wins. */
        for (i = chunk; i >= 4; i--) {
            if (rd32(win + i - 4) == SIG_EOCD) {
                *out_offset = from + i - 4;
                return WH_ZIP_OK;
            }
        }

        if (from == limit) break;
        /* Overlap by three bytes so a signature straddling the boundary is
         * not missed. */
        end = from + 3;
    }
    return WH_ZIP_EFORMAT;
}

int wh_zip_open(wh_zip *z, wh_zip_read read, void *ctx, unsigned long size)
{
    unsigned char eocd[EOCD_MIN];
    unsigned long offset = 0;
    int rc;

    z->read = read;
    z->ctx = ctx;
    z->size = size;
    z->cd_offset = 0;
    z->entries = 0;

    rc = find_eocd(z, &offset);
    if (rc != WH_ZIP_OK) return rc;
    if (size - offset < EOCD_MIN) return WH_ZIP_EFORMAT;

    rc = read_at(z, offset, eocd, EOCD_MIN);
    if (rc != WH_ZIP_OK) return rc;

    z->entries = rd16(eocd + 10);
    z->cd_offset = rd32(eocd + 16);
    if (z->cd_offset >= size) return WH_ZIP_EFORMAT;
    return WH_ZIP_OK;
}

static int read_entry(wh_zip *z, wh_zip_iter *it, wh_zip_entry *out)
{
    unsigned char hdr[46];
    unsigned long namelen, extralen, commentlen;
    int rc;

    if (it->left == 0) return 1;

    rc = read_at(z, it->pos, hdr, sizeof(hdr));
    if (rc != WH_ZIP_OK) return rc;
    if (rd32(hdr) != SIG_CD) return WH_ZIP_EFORMAT;

    out->method = (int)rd16(hdr + 10);
    out->crc = rd32(hdr + 16);
    out->comp_size = rd32(hdr + 20);
    out->uncomp_size = rd32(hdr + 24);
    namelen = rd16(hdr + 28);
    extralen = rd16(hdr + 30);
    commentlen = rd16(hdr + 32);
    out->local_offset = rd32(hdr + 42);

    if (namelen >= WH_ZIP_NAME_MAX) return WH_ZIP_EFORMAT;
    rc = read_at(z, it->pos + sizeof(hdr), (unsigned char *)out->name, namelen);
    if (rc != WH_ZIP_OK) return rc;
    out->name[namelen] = '\0';

    /* Zip stores directories as zero-length entries ending in '/'. */
    out->is_dir = (namelen > 0 && out->name[namelen - 1] == '/') ? 1 : 0;

    it->pos += sizeof(hdr) + namelen + extralen + commentlen;
    it->left--;
    return WH_ZIP_OK;
}

int wh_zip_first(wh_zip *z, wh_zip_iter *it, wh_zip_entry *out)
{
    it->pos = z->cd_offset;
    it->left = z->entries;
    return read_entry(z, it, out);
}

int wh_zip_next(wh_zip *z, wh_zip_iter *it, wh_zip_entry *out)
{
    return read_entry(z, it, out);
}

int wh_zip_name_is_safe(const char *name)
{
    int i = 0;
    int seg_start = 1;

    if (name[0] == '\0') return 0;
    if (name[0] == '/' || name[0] == '\\') return 0;          /* absolute */
    if (name[0] && name[1] == ':') return 0;                  /* drive letter */

    for (i = 0; name[i]; i++) {
        char c = name[i];
        if (c == '\\') return 0;   /* zip uses '/'; a backslash is suspicious */
        if (seg_start) {
            /* Reject a "." or ".." path component outright rather than
             * trying to normalise it away. */
            if (c == '.') {
                if (name[i + 1] == '\0' || name[i + 1] == '/') return 0;
                if (name[i + 1] == '.' &&
                    (name[i + 2] == '\0' || name[i + 2] == '/')) {
                    return 0;
                }
            }
            seg_start = 0;
        }
        if (c == '/') seg_start = 1;
        /* Control characters have no business in a file name. */
        if ((unsigned char)c < 0x20) return 0;
    }
    return 1;
}

/* Feeds an entry's compressed bytes to inflate. */
typedef struct {
    wh_zip *zip;
    unsigned long offset;
    unsigned long left;
    int error;
} TEntrySource;

static long entry_read(void *ctx, unsigned char *buf, unsigned long cap)
{
    TEntrySource *s = (TEntrySource *)ctx;
    unsigned long n = s->left;
    long got;

    if (n == 0) return 0;
    if (n > cap) n = cap;
    got = s->zip->read(s->zip->ctx, s->offset, buf, n);
    if (got <= 0) {
        s->error = 1;
        return -1;
    }
    s->offset += (unsigned long)got;
    s->left -= (unsigned long)got;
    return got;
}

/* Wraps the caller's sink to run a CRC over what comes out. */
typedef struct {
    wh_inflate_out out;
    void *ctx;
    unsigned long crc;
    unsigned long len;
} TCrcSink;

static int crc_sink(void *ctx, const unsigned char *buf, unsigned long len)
{
    TCrcSink *k = (TCrcSink *)ctx;
    k->crc = wh_crc32(k->crc, buf, len);
    k->len += len;
    return k->out(k->ctx, buf, len);
}

int wh_zip_extract(wh_zip *z, const wh_zip_entry *entry,
                   wh_inflate_state *state,
                   wh_inflate_out out, void *out_ctx)
{
    unsigned char local[30];
    unsigned long data_off;
    TEntrySource src;
    TCrcSink sink;
    int rc;

    rc = read_at(z, entry->local_offset, local, sizeof(local));
    if (rc != WH_ZIP_OK) return rc;
    if (rd32(local) != SIG_LOCAL) return WH_ZIP_EFORMAT;

    /* The local header repeats the name and extra fields, and its lengths
     * are the ones that locate the data - they are allowed to differ from
     * the central directory's. */
    data_off = entry->local_offset + sizeof(local) + rd16(local + 26) +
               rd16(local + 28);
    if (data_off > z->size || entry->comp_size > z->size - data_off) {
        return WH_ZIP_EFORMAT;
    }

    src.zip = z;
    src.offset = data_off;
    src.left = entry->comp_size;
    src.error = 0;

    sink.out = out;
    sink.ctx = out_ctx;
    sink.crc = 0;
    sink.len = 0;

    if (entry->method == 0) {
        /* Stored: copy through, still checking the CRC. */
        unsigned char buf[1024];
        while (src.left > 0) {
            long got = entry_read(&src, buf, sizeof(buf));
            if (got <= 0) return WH_ZIP_EIO;
            if (crc_sink(&sink, buf, (unsigned long)got) != 0) return WH_ZIP_EOUTPUT;
        }
    } else if (entry->method == 8) {
        int ir = wh_inflate(state, entry_read, &src, crc_sink, &sink);
        if (ir == WH_INFLATE_EOUTPUT) return WH_ZIP_EOUTPUT;
        if (ir != WH_INFLATE_OK) return src.error ? WH_ZIP_EIO : WH_ZIP_EFORMAT;
    } else {
        return WH_ZIP_EFORMAT;
    }

    if (sink.len != entry->uncomp_size) return WH_ZIP_EFORMAT;
    if (sink.crc != entry->crc) return WH_ZIP_ECRC;
    return WH_ZIP_OK;
}
