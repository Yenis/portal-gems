/* A zip writer, for sending a folder.
 *
 * Entries are STORED, never deflated. The offer still declares
 * `zipfile/deflated` because that is the only mode the reference client
 * accepts, but that names the container, not the entries - a zip may mix
 * both, and every reader handles stored ones. Which means sending a folder
 * needs no compressor at all: a few hundred lines instead of a few
 * thousand, on a phone that would rather spend its cycles on the network.
 *
 * Output is purely sequential - no seeking back to patch headers - so sizes
 * and CRCs that are unknown when a header is written go in a trailing data
 * descriptor, exactly as the format provides for. */
#ifndef WH_ZIPW_H
#define WH_ZIPW_H

#ifdef __cplusplus
extern "C" {
#endif

/* Consume archive bytes. Return 0 to continue, non-zero to abort. */
typedef int (*wh_zipw_out)(void *ctx, const unsigned char *buf,
                           unsigned long len);

typedef struct {
    wh_zipw_out out;
    void *ctx;
    unsigned long offset;        /* bytes emitted so far */

    /* The central directory is accumulated and written last. It is held in
     * a caller-supplied buffer, so the entry limit is explicit and visible
     * rather than a surprise at 3 a.m. */
    unsigned char *cd;
    unsigned long cd_cap;
    unsigned long cd_len;
    unsigned long count;

    /* Current entry. The name is kept here between begin and end: the
     * central directory record cannot be written until the size and CRC are
     * known, and holding a pointer into the caller's buffer would be a trap
     * the day someone reuses it. */
    char entry_name[256];
    int in_entry;
    unsigned long entry_offset;
    unsigned long entry_crc;
    unsigned long entry_size;

    int error;
} wh_zipw;

#define WH_ZIPW_OK        0
#define WH_ZIPW_EOUTPUT  -1
#define WH_ZIPW_EFULL    -2   /* too many entries for the directory buffer */
#define WH_ZIPW_ESTATE   -3   /* calls made out of order */

void wh_zipw_init(wh_zipw *w, wh_zipw_out out, void *ctx,
                  unsigned char *cd_buf, unsigned long cd_cap);

/* `name` must end in '/'. Empty directories are recorded so they survive
 * the round trip, which is what the engine does. */
int wh_zipw_add_dir(wh_zipw *w, const char *name);

int wh_zipw_begin_file(wh_zipw *w, const char *name);
int wh_zipw_write(wh_zipw *w, const unsigned char *data, unsigned long len);
int wh_zipw_end_file(wh_zipw *w);

/* Writes the central directory and the end record. */
int wh_zipw_finish(wh_zipw *w);

#ifdef __cplusplus
}
#endif
#endif /* WH_ZIPW_H */
