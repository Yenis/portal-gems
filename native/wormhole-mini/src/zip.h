/* A zip reader, enough of the format to unpack what PortalGems sends.
 *
 * Folder transfers arrive as a zip. The archive is staged to a file first
 * and read through a pread-style callback, because a zip's authoritative
 * index is the central directory at the very end - streaming would mean
 * trusting local headers, which are allowed to omit sizes entirely.
 *
 * Entries may be stored or deflated; both appear in practice, and a sender
 * that cannot compress may legitimately store everything. */
#ifndef WH_ZIP_H
#define WH_ZIP_H

#include "inflate.h"

#ifdef __cplusplus
extern "C" {
#endif

#define WH_ZIP_NAME_MAX 256

/* Read exactly `len` bytes at absolute `offset`. Return the count read, or
 * -1. Short reads are treated as errors by the caller. */
typedef long (*wh_zip_read)(void *ctx, unsigned long offset,
                            unsigned char *buf, unsigned long len);

typedef struct {
    wh_zip_read read;
    void *ctx;
    unsigned long size;        /* of the whole archive */
    unsigned long cd_offset;   /* start of the central directory */
    unsigned long entries;     /* how many it claims */
} wh_zip;

typedef struct {
    char name[WH_ZIP_NAME_MAX];
    unsigned long comp_size;
    unsigned long uncomp_size;
    unsigned long crc;
    unsigned long local_offset;
    int method;                /* 0 stored, 8 deflated */
    int is_dir;
} wh_zip_entry;

typedef struct {
    unsigned long pos;         /* cursor into the central directory */
    unsigned long left;        /* entries not yet returned */
} wh_zip_iter;

#define WH_ZIP_OK        0
#define WH_ZIP_EIO      -1
#define WH_ZIP_EFORMAT  -2
#define WH_ZIP_EUNSAFE  -3   /* an entry name that would escape the target */
#define WH_ZIP_ETOOBIG  -4   /* past the caller's unpacked-size cap */
#define WH_ZIP_ECRC     -5
#define WH_ZIP_EOUTPUT  -6

int wh_zip_open(wh_zip *z, wh_zip_read read, void *ctx, unsigned long size);

/* Iterate the central directory. Returns WH_ZIP_OK with `out` filled, or 1
 * when there are no more entries, or a negative error. */
int wh_zip_first(wh_zip *z, wh_zip_iter *it, wh_zip_entry *out);
int wh_zip_next(wh_zip *z, wh_zip_iter *it, wh_zip_entry *out);

/* Whether an entry name is safe to join onto a destination directory:
 * relative, no `..` component, no drive letter, no leading separator. */
int wh_zip_name_is_safe(const char *name);

/* Extract one entry through `out`. `state` is the caller's inflate state,
 * reused across entries. The entry's CRC is checked. */
int wh_zip_extract(wh_zip *z, const wh_zip_entry *entry,
                   wh_inflate_state *state,
                   wh_inflate_out out, void *out_ctx);

#ifdef __cplusplus
}
#endif
#endif /* WH_ZIP_H */
