/* Transfer protocol v1, receive side.
 *
 * The exchange, from native/magic-wormhole/src/transfer/v1.rs:
 *   us   -> {"transit": {abilities, hints}}
 *   them -> {"transit": {...}}
 *   them -> {"offer": {"file": {"filename", "filesize"}}}
 *   us   -> {"answer": {"file_ack": "ok"}}
 *   then the bytes arrive as transit records, and we reply over transit with
 *   {"ack": "ok", "sha256": "<hex>"}.
 *
 * File bytes leave through a caller-supplied sink, so this layer never
 * touches a filesystem API - which is what lets the same code serve stdio on
 * the host and RFile on Symbian. */
#ifndef WH_XFER_H
#define WH_XFER_H

#include "mailbox.h"
#include "transit.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char filename[256];
    /* On a 32-bit target this caps a transfer at 4 GiB, which is also the
     * FAT32 per-file limit on the phone's memory card, so it costs nothing
     * in practice. */
    unsigned long filesize;
    int is_directory;
    char dirname[256];
} wh_offer;

/* Scratch for one record in flight. About 64 KB; declare one statically. */
typedef struct {
    unsigned char record[WH_RECORD_MAX];
    unsigned char wire[WH_RECORD_WIRE_MAX];
    unsigned char work[2 * (WH_RECORD_MAX + 32)];
} wh_xfer_bufs;

/* Called with each decrypted chunk. Return 0 to continue, non-zero to abort. */
typedef int (*wh_xfer_sink)(void *ctx, const unsigned char *data, unsigned long len);
/* Fills `buf` with up to `cap` more bytes of the file being sent. Returns
 * the count, 0 at end of file, or -1 on error. */
typedef long (*wh_xfer_source)(void *ctx, unsigned char *buf, unsigned long cap);
/* Called as bytes arrive; `done` and `total` are byte counts. */
typedef void (*wh_xfer_progress)(void *ctx, unsigned long done, unsigned long total);

/* Exchange transit messages and read the peer's offer. Returns 0. */
int wh_xfer_await_offer(wh_mailbox *m, const char *relay_host,
                        unsigned int relay_port, wh_offer *offer);

/* Accept the offer, connect the transit, and stream the file into `sink`.
 * Returns 0 on success, -3 if the sender's checksum disagrees with ours. */
int wh_xfer_accept(wh_mailbox *m, const char *appid, const wh_offer *offer,
                   const char *relay_host, unsigned int relay_port,
                   wh_xfer_bufs *bufs,
                   wh_xfer_sink sink, void *sink_ctx,
                   wh_xfer_progress progress, void *progress_ctx);

/* Decline the offer with a reason the peer will display. */
int wh_xfer_reject(wh_mailbox *m, const char *reason);

/* Offer a file and, if the peer accepts, send it. We take the leader role in
 * the transit handshake, which is what the sending side always does.
 *
 * Returns 0 on success, -2 if the peer declined the offer, -3 if the peer's
 * checksum disagrees with ours. */
int wh_xfer_send_file(wh_mailbox *m, const char *appid,
                      const char *filename, unsigned long filesize,
                      const char *relay_host, unsigned int relay_port,
                      wh_xfer_bufs *bufs,
                      wh_xfer_source source, void *source_ctx,
                      wh_xfer_progress progress, void *progress_ctx);

#ifdef __cplusplus
}
#endif
#endif /* WH_XFER_H */
