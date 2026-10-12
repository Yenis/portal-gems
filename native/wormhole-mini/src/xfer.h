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
 * A text message is a different, shorter exchange with no transit at all:
 *   them -> {"offer": {"message": "..."}}
 *   us   -> {"answer": {"message_ack": "ok"}}
 * which is why the offer has to be read before our transit message is sent -
 * a text sender never sends one, and never reads one either.
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

/* Longest message we will send. The whole offer has to fit one phase
 * message (WH_PHASE_MAX), and JSON escaping can expand a byte sixfold - a
 * message of nothing but newlines is the worst case - so the limit is on the
 * input and the encoder's own overflow check catches the rest. */
#define WH_TEXT_MAX 1000

typedef struct {
    char filename[256];
    /* Bytes that will arrive over the transit. For a directory offer that
     * is the size of the zip, not the size of its contents.
     *
     * On a 32-bit target this caps a transfer at 4 GiB, which is also the
     * FAT32 per-file limit on the phone's memory card, so it costs nothing
     * in practice. */
    unsigned long filesize;

    /* A text offer: `text` is the message and nothing else in here means
     * anything. The message lives in this layer's own static storage and is
     * valid until the next call - copying a kilobyte into every wh_offer
     * would put it on a caller's stack, which on Symbian is 8 KB. */
    int is_text;
    const char *text;

    int is_directory;
    char dirname[256];
    unsigned long num_files;   /* what the sender says the folder holds */
    unsigned long num_bytes;   /* unpacked total, before compression */

    /* A loose bundle: several files and folders sent as one. It is a
     * directory offer in every other respect - the archive arrives and is
     * unpacked the same way - but its contents belong directly in the
     * receive folder, each under its own name, and `dirname` is only what a
     * client without this extension would call the folder it saves instead.
     *
     * The two counts are the files and folders at the top level: what will
     * appear in the receive folder, as opposed to `num_files`, which counts
     * every file inside. They word a sentence and are not enforced.
     * See docs/MULTI-FILE-DESIGN.md. */
    int is_loose;
    unsigned long loose_files;
    unsigned long loose_folders;

    /* Where the peer says it can be reached directly. */
    wh_direct_hints peer;
} wh_offer;

/* Read the offer out of the phase message that carries it:
 * {"offer":{"file":{...}}} or {"offer":{"directory":{...}}}. Fills the
 * file and directory members of `offer` and leaves the rest alone. A text
 * offer is not handled here - wh_xfer_await_offer acknowledges those itself.
 *
 * Unknown members are ignored, and so is a `portalgems` member that is
 * malformed: an offer never fails to parse over the extension, it is merely
 * not loose. Returns 0, or -1 if this is not a file or directory offer.
 *
 * Exposed so the parsing can be tested without a mailbox. */
int wh_xfer_parse_offer(const char *msg, unsigned long len, wh_offer *offer);

/* Candidate number `n` for a name that must not collide in the receive
 * folder: `name` itself for 0, then "name (1).ext", "name (2).ext"... - or
 * "name (1)" for a folder, whose dots are not an extension. A leading dot is
 * not an extension either. The same shapes the other clients produce, so a
 * clash reads the same wherever it is resolved. Returns 0, or -1 if the
 * result does not fit `cap`. */
int wh_numbered_name(const char *name, int is_dir, unsigned long n,
                     char *out, unsigned long cap);

/* "7 files and 2 folders", "5 files", "1 folder" - what a loose bundle
 * holds, for a screen. A kind there is none of is left out. Returns 0, or
 * -1 if it does not fit. */
int wh_items_text(unsigned long files, unsigned long folders,
                  char *out, unsigned long cap);

/* How many unpacked bytes to tolerate for a folder claiming `num_bytes`:
 * the claim, a quarter again, and a floor for small offers. Past that an
 * archive is hostile rather than merely imprecise. Mirrors
 * `unpack_cap` in native/wormhole-core. */
unsigned long wh_unpack_cap(unsigned long num_bytes);

/* How many archive entries to tolerate for a folder claiming `num_files`:
 * twice the claim and a floor of ten thousand. The byte cap cannot see an
 * archive of empty files, which unpacks to nothing and still fills a memory
 * card with entries. Mirrors `entry_cap` in native/wormhole-core. */
unsigned long wh_entry_cap(unsigned long num_files);

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

/* Send a text message: offer it, and wait for the peer's acknowledgement.
 *
 * No transit is negotiated, because the reference sender does not negotiate
 * one either - it builds a transit sender only when there is a file, so a
 * peer that receives transit hints for a text offer dereferences something
 * it never created. The message travels inside the offer.
 *
 * Returns 0 on success, -2 if the peer refused, -4 if the message is longer
 * than one phase message can carry. */
int wh_xfer_send_text(wh_mailbox *m, const char *text);

/* Exchange transit messages and read the peer's offer. Returns 0.
 *
 * A text offer is complete when this returns: it has been acknowledged, and
 * there is nothing to accept. Check `is_text` before anything else. */
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
