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

/* Addresses a peer says it is listening on. Most will be unreachable from
 * here - another network's private range, an interface that is down - so
 * they are tried in turn with a short bound each, and the relay is always
 * there behind them. */
#define WH_MAX_DIRECT_HINTS 6
/* Per address, not in total. A peer advertises every interface it has -
 * virtual bridges, tunnels, an IPv6 address a phone may have no route to -
 * and most of them are dead ends from here. A local machine answers a SYN
 * in tens of milliseconds, so a second and a half is generous for the case
 * that can succeed while keeping six dead ends under ten seconds. The peer
 * waits sixty, so this is about not making someone watch a phone screen
 * rather than about correctness. */
#define WH_DIRECT_TIMEOUT_MS 1500

typedef struct {
    char host[64];
    unsigned int port;
} wh_direct_hint;

/* Which route the last transfer took. */
#define WH_ROUTE_UNKNOWN 0
#define WH_ROUTE_DIRECT  1
#define WH_ROUTE_RELAY   2
int wh_xfer_last_route(void);

/* Direct connections can be turned off, leaving every transfer on the
 * relay. Slower, but it is the path that works from anywhere, and having a
 * switch means a direct-connection problem in the field is a setting rather
 * than a new build. Enabled by default. */
void wh_xfer_enable_direct(int enabled);

typedef struct {
    wh_direct_hint hint[WH_MAX_DIRECT_HINTS];
    int count;
} wh_direct_hints;

typedef struct {
    char filename[256];
    /* Bytes that will arrive over the transit. For a directory offer that
     * is the size of the zip, not the size of its contents.
     *
     * On a 32-bit target this caps a transfer at 4 GiB, which is also the
     * FAT32 per-file limit on the phone's memory card, so it costs nothing
     * in practice. */
    unsigned long filesize;

    int is_directory;
    char dirname[256];
    unsigned long num_files;   /* what the sender says the folder holds */
    unsigned long num_bytes;   /* unpacked total, before compression */

    /* Where the peer says it can be reached directly. */
    wh_direct_hints peer;
} wh_offer;

/* How many unpacked bytes to tolerate for a folder claiming `num_bytes`:
 * the claim, a quarter again, and a floor for small offers. Past that an
 * archive is hostile rather than merely imprecise. Mirrors
 * `unpack_cap` in native/wormhole-core. */
unsigned long wh_unpack_cap(unsigned long num_bytes);

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

/* Offer an already-built zip as a folder. The caller zips the tree first -
 * walking a directory is platform work - and passes the counts the peer
 * shows before accepting.
 *
 * `mode` on the wire is always "zipfile/deflated" because it is the only
 * value the reference client accepts; it describes the container, and
 * stored entries inside are perfectly ordinary. */
int wh_xfer_send_folder(wh_mailbox *m, const char *appid,
                        const char *dirname, unsigned long zip_size,
                        unsigned long num_files, unsigned long num_bytes,
                        const char *relay_host, unsigned int relay_port,
                        wh_xfer_bufs *bufs,
                        wh_xfer_source source, void *source_ctx,
                        wh_xfer_progress progress, void *progress_ctx);

#ifdef __cplusplus
}
#endif
#endif /* WH_XFER_H */
