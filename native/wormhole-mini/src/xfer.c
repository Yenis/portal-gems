#include "xfer.h"
#include "json.h"
#include "kdf.h"
#include "sha256.h"

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

/* Our transit message. Relay only: we advertise no direct hints and never
 * listen, so the peer has nothing to connect to except the relay we name.
 *
 * hints-v1 is a flat array mixing direct and relay hints (transit.rs's
 * Serialize for Hints); a relay hint nests its endpoints under "hints". */
/* Collect the peer's direct addresses out of a transit message.
 *
 * hints-v1 is a flat array mixing direct hints with relay hints; only the
 * direct ones are ours to dial. Anything unrecognised is ignored rather
 * than treated as an error, because the format is explicitly extensible. */
static void parse_direct_hints(const char *json, unsigned long len,
                               wh_direct_hints *out)
{
    wh_json_val transit, hints, el, field;
    wh_json_iter it;
    int rc;

    out->count = 0;

    if (wh_json_get(json, len, "transit", &transit) != 0) return;
    if (wh_json_get(transit.p, transit.len, "hints-v1", &hints) != 0) return;
    if (hints.type != WH_JSON_ARRAY) return;

    rc = wh_json_array_first(&hints, &it, &el);
    while (rc == 0 && out->count < WH_MAX_DIRECT_HINTS) {
        if (wh_json_get(el.p, el.len, "type", &field) == 0 &&
            wh_json_streq(&field, "direct-tcp-v1")) {
            wh_direct_hint *h = &out->hint[out->count];
            unsigned long port = 0;

            if (wh_json_get(el.p, el.len, "hostname", &field) == 0 &&
                wh_json_str(&field, h->host, sizeof(h->host)) > 0 &&
                wh_json_get(el.p, el.len, "port", &field) == 0 &&
                wh_json_u32(&field, &port) == 0 &&
                port > 0 && port < 65536) {
                h->port = (unsigned int)port;
                out->count++;
            }
        }
        rc = wh_json_array_next(&hints, &it, &el);
    }
}

/* Try the peer's addresses, then the relay. The relay always works and is
 * always slower, so it earns its place as the fallback rather than the
 * first choice. */
static int connect_transit(wh_transit *t, const wh_direct_hints *peer,
                           const char *relay_host, unsigned int relay_port,
                           const unsigned char transit_key[32], int role)
{
    int i;

    for (i = 0; i < peer->count; i++) {
        if (wh_transit_connect_direct(t, peer->hint[i].host, peer->hint[i].port,
                                      transit_key, role,
                                      WH_DIRECT_TIMEOUT_MS) == 0) {
            return 0;
        }
    }
    return wh_transit_connect_relay(t, relay_host, relay_port, transit_key, role);
}

static int build_transit_msg(char *out, unsigned long cap,
                             const char *relay_host, unsigned int relay_port)
{
    char endpoint[256];
    char relay[512];
    char hints[600];
    wh_jw w;

    wh_jw_init(&w, endpoint, sizeof(endpoint));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "direct-tcp-v1");
    wh_jw_str(&w, "hostname", relay_host);
    wh_jw_u32(&w, "port", relay_port);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    wh_jw_init(&w, relay, sizeof(relay));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "relay-v1");
    wh_jw_raw(&w, "name", "null");
    wh_jw_key(&w, "hints");
    {
        unsigned long i, n = wh_strlen(endpoint);
        if (w.len + n + 2 >= w.cap) return -1;
        w.buf[w.len++] = '[';
        for (i = 0; i < n; i++) w.buf[w.len++] = endpoint[i];
        w.buf[w.len++] = ']';
    }
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    {
        unsigned long n = wh_strlen(relay);
        if (n + 3 > sizeof(hints)) return -1;
        hints[0] = '[';
        {
            unsigned long i;
            for (i = 0; i < n; i++) hints[1 + i] = relay[i];
        }
        hints[n + 1] = ']';
        hints[n + 2] = '\0';
    }

    wh_jw_init(&w, out, cap);
    wh_jw_obj_open(&w);
    wh_jw_key(&w, "transit");
    wh_jw_obj_open(&w);
    /* Advertising the direct ability is what makes a peer publish its own
     * addresses. We offer none of our own: this side dials out and never
     * listens. */
    wh_jw_raw(&w, "abilities-v1",
              "[{\"type\":\"direct-tcp-v1\"},{\"type\":\"relay-v1\"}]");
    wh_jw_raw(&w, "hints-v1", hints);
    wh_jw_obj_close(&w);
    wh_jw_obj_close(&w);
    return wh_jw_done(&w);
}

int wh_xfer_await_offer(wh_mailbox *m, const char *relay_host,
                        unsigned int relay_port, wh_offer *offer)
{
    char buf[2048];
    wh_json_val v, inner, field;
    long n;

    offer->filename[0] = '\0';
    offer->dirname[0] = '\0';
    offer->filesize = 0;
    offer->is_directory = 0;
    offer->num_files = 0;
    offer->num_bytes = 0;
    offer->peer.count = 0;

    if (build_transit_msg(buf, sizeof(buf), relay_host, relay_port) != 0) return -1;
    if (wh_mailbox_send_phase(m, buf, wh_strlen(buf)) != 0) return -1;

    /* Their transit message, which carries the addresses we may be able to
     * reach them on directly. */
    n = wh_mailbox_recv_phase(m, buf, sizeof(buf));
    if (n < 0) return -1;
    if (wh_json_get(buf, (unsigned long)n, "transit", &v) != 0) return -1;
    parse_direct_hints(buf, (unsigned long)n, &offer->peer);

    /* Their offer. */
    n = wh_mailbox_recv_phase(m, buf, sizeof(buf));
    if (n < 0) return -1;
    if (wh_json_get(buf, (unsigned long)n, "offer", &v) != 0) return -1;

    if (wh_json_get(v.p, v.len, "file", &inner) == 0) {
        unsigned long size = 0;
        if (wh_json_get(inner.p, inner.len, "filename", &field) != 0) return -1;
        if (wh_json_str(&field, offer->filename, sizeof(offer->filename)) < 0) return -1;
        if (wh_json_get(inner.p, inner.len, "filesize", &field) != 0) return -1;
        if (wh_json_u32(&field, &size) != 0) return -1;
        offer->filesize = size;
        return 0;
    }

    if (wh_json_get(v.p, v.len, "directory", &inner) == 0) {
        unsigned long n = 0;
        offer->is_directory = 1;
        if (wh_json_get(inner.p, inner.len, "dirname", &field) != 0) return -1;
        if (wh_json_str(&field, offer->dirname, sizeof(offer->dirname)) < 0) return -1;

        /* zipsize is what arrives over the transit; numbytes is what it
         * becomes once unpacked. Confusing the two would either truncate
         * the transfer or wait forever for bytes that are not coming. */
        if (wh_json_get(inner.p, inner.len, "zipsize", &field) != 0) return -1;
        if (wh_json_u32(&field, &n) != 0) return -1;
        offer->filesize = n;

        if (wh_json_get(inner.p, inner.len, "numbytes", &field) == 0) {
            if (wh_json_u32(&field, &n) == 0) offer->num_bytes = n;
        }
        if (wh_json_get(inner.p, inner.len, "numfiles", &field) == 0) {
            if (wh_json_u32(&field, &n) == 0) offer->num_files = n;
        }
        return 0;
    }

    return -1;
}

int wh_xfer_reject(wh_mailbox *m, const char *reason)
{
    char buf[512];
    wh_jw w;
    wh_jw_init(&w, buf, sizeof(buf));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "error", reason);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;
    return wh_mailbox_send_phase(m, buf, wh_strlen(buf));
}

int wh_xfer_accept(wh_mailbox *m, const char *appid, const wh_offer *offer,
                   const char *relay_host, unsigned int relay_port,
                   wh_xfer_bufs *bufs,
                   wh_xfer_sink sink, void *sink_ctx,
                   wh_xfer_progress progress, void *progress_ctx)
{
    static const char ANSWER[] = "{\"answer\":{\"file_ack\":\"ok\"}}";
    unsigned char transit_key[32];
    wh_transit t;
    wh_sha256_ctx hasher;
    unsigned char digest[32];
    char hex[65];
    char ack[128];
    unsigned long received = 0;
    wh_jw w;
    int rc = 0;

    /* A directory offer is accepted exactly like a file: the zip arrives
     * over the transit as a byte stream. Unpacking it afterwards is the
     * caller's business, because it needs a filesystem and this layer has
     * none. */
    if (wh_mailbox_send_phase(m, ANSWER, sizeof(ANSWER) - 1) != 0) return -1;

    if (wh_derive_transit_key(m->key, appid, transit_key) != 0) return -1;
    if (connect_transit(&t, &offer->peer, relay_host, relay_port, transit_key,
                        WH_TRANSIT_FOLLOWER) != 0) {
        return -1;
    }

    wh_sha256_init(&hasher);
    if (progress) progress(progress_ctx, 0, offer->filesize);

    while (received < offer->filesize) {
        long n = wh_transit_recv_record(&t, bufs->record, sizeof(bufs->record),
                                        bufs->work, sizeof(bufs->work),
                                        bufs->wire, sizeof(bufs->wire));
        if (n < 0) { rc = -1; goto done; }
        if ((unsigned long)n > offer->filesize - received) {
            /* The sender promised a size; more than that is a protocol
             * violation, not something to write to the card. */
            rc = -1;
            goto done;
        }
        wh_sha256_update(&hasher, bufs->record, (unsigned long)n);
        if (sink(sink_ctx, bufs->record, (unsigned long)n) != 0) { rc = -1; goto done; }
        received += (unsigned long)n;
        if (progress) progress(progress_ctx, received, offer->filesize);
    }

    /* The sender compares this against its own hash of what it sent. */
    wh_sha256_final(&hasher, digest);
    wh_hex(digest, sizeof(digest), hex);

    wh_jw_init(&w, ack, sizeof(ack));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "ack", "ok");
    wh_jw_str(&w, "sha256", hex);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) { rc = -1; goto done; }

    if (wh_transit_send_record(&t, (const unsigned char *)ack, wh_strlen(ack),
                               bufs->work, sizeof(bufs->work),
                               bufs->wire, sizeof(bufs->wire)) != 0) {
        rc = -1;
    }

done:
    wh_transit_close(&t);
    return rc;
}

unsigned long wh_unpack_cap(unsigned long num_bytes)
{
    unsigned long cap = num_bytes + num_bytes / 4;
    if (cap < num_bytes) return 0xffffffffUL;          /* overflowed */
    if (cap + 16UL * 1024UL * 1024UL < cap) return 0xffffffffUL;
    return cap + 16UL * 1024UL * 1024UL;
}

/* The two send paths differ only in the offer they publish; everything
 * after it - transit, answer, records, checksum - is identical, so it lives
 * in send_offer_and_stream below. */
static int send_offer_and_stream(wh_mailbox *m, const char *appid,
                                 const char *offer_json,
                                 unsigned long total,
                                 const char *relay_host,
                                 unsigned int relay_port,
                                 wh_xfer_bufs *bufs,
                                 wh_xfer_source source, void *source_ctx,
                                 wh_xfer_progress progress, void *progress_ctx);

/* Our transit hints go first: the engine sends them before the offer and
 * only afterwards waits for the peer (transfer/v1.rs::send). */
static int send_transit_hints(wh_mailbox *m, const char *relay_host,
                              unsigned int relay_port)
{
    char buf[1024];
    if (build_transit_msg(buf, sizeof(buf), relay_host, relay_port) != 0) return -1;
    return wh_mailbox_send_phase(m, buf, wh_strlen(buf));
}

int wh_xfer_send_file(wh_mailbox *m, const char *appid,
                      const char *filename, unsigned long filesize,
                      const char *relay_host, unsigned int relay_port,
                      wh_xfer_bufs *bufs,
                      wh_xfer_source source, void *source_ctx,
                      wh_xfer_progress progress, void *progress_ctx)
{
    char buf[1024];
    wh_jw w;

    if (send_transit_hints(m, relay_host, relay_port) != 0) return -1;

    wh_jw_init(&w, buf, sizeof(buf));
    wh_jw_obj_open(&w);
    wh_jw_key(&w, "offer");
    wh_jw_obj_open(&w);
    wh_jw_key(&w, "file");
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "filename", filename);
    wh_jw_u32(&w, "filesize", filesize);
    wh_jw_obj_close(&w);
    wh_jw_obj_close(&w);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    return send_offer_and_stream(m, appid, buf, filesize, relay_host,
                                 relay_port, bufs, source, source_ctx,
                                 progress, progress_ctx);
}

int wh_xfer_send_folder(wh_mailbox *m, const char *appid,
                        const char *dirname, unsigned long zip_size,
                        unsigned long num_files, unsigned long num_bytes,
                        const char *relay_host, unsigned int relay_port,
                        wh_xfer_bufs *bufs,
                        wh_xfer_source source, void *source_ctx,
                        wh_xfer_progress progress, void *progress_ctx)
{
    char buf[1024];
    wh_jw w;

    if (send_transit_hints(m, relay_host, relay_port) != 0) return -1;

    wh_jw_init(&w, buf, sizeof(buf));
    wh_jw_obj_open(&w);
    wh_jw_key(&w, "offer");
    wh_jw_obj_open(&w);
    wh_jw_key(&w, "directory");
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "dirname", dirname);
    /* The only mode the reference client accepts. It names the container,
     * not the entries, which may be stored. */
    wh_jw_str(&w, "mode", "zipfile/deflated");
    wh_jw_u32(&w, "zipsize", zip_size);
    wh_jw_u32(&w, "numbytes", num_bytes);
    wh_jw_u32(&w, "numfiles", num_files);
    wh_jw_obj_close(&w);
    wh_jw_obj_close(&w);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    return send_offer_and_stream(m, appid, buf, zip_size, relay_host,
                                 relay_port, bufs, source, source_ctx,
                                 progress, progress_ctx);
}

static int send_offer_and_stream(wh_mailbox *m, const char *appid,
                                 const char *offer_json,
                                 unsigned long total,
                                 const char *relay_host,
                                 unsigned int relay_port,
                                 wh_xfer_bufs *bufs,
                                 wh_xfer_source source, void *source_ctx,
                                 wh_xfer_progress progress, void *progress_ctx)
{
    unsigned char transit_key[32];
    wh_transit t;
    wh_sha256_ctx hasher;
    unsigned char digest[32];
    char hex[65];
    char buf[2048];
    wh_json_val v, inner;
    wh_direct_hints peer;
    unsigned long sent = 0;
    long n;
    int rc = 0;
    unsigned long filesize = total;

    if (wh_mailbox_send_phase(m, offer_json, wh_strlen(offer_json)) != 0) return -1;

    /* Their transit message, and the addresses in it. */
    n = wh_mailbox_recv_phase(m, buf, sizeof(buf));
    if (n < 0) return -1;
    if (wh_json_get(buf, (unsigned long)n, "transit", &v) != 0) return -1;
    parse_direct_hints(buf, (unsigned long)n, &peer);

    /* Their answer. A refusal arrives as {"error": "..."} instead. */
    n = wh_mailbox_recv_phase(m, buf, sizeof(buf));
    if (n < 0) return -1;
    if (wh_json_get(buf, (unsigned long)n, "error", &v) == 0) return -2;
    if (wh_json_get(buf, (unsigned long)n, "answer", &v) != 0) return -1;
    if (wh_json_get(v.p, v.len, "file_ack", &inner) != 0) return -2;
    if (!wh_json_streq(&inner, "ok")) return -2;

    if (wh_derive_transit_key(m->key, appid, transit_key) != 0) return -1;
    if (connect_transit(&t, &peer, relay_host, relay_port, transit_key,
                        WH_TRANSIT_LEADER) != 0) {
        return -1;
    }

    wh_sha256_init(&hasher);
    if (progress) progress(progress_ctx, 0, filesize);

    while (sent < filesize) {
        unsigned long want = filesize - sent;
        if (want > WH_RECORD_MAX) want = WH_RECORD_MAX;

        n = source(source_ctx, bufs->record, want);
        if (n <= 0) { rc = -1; goto done; }

        wh_sha256_update(&hasher, bufs->record, (unsigned long)n);
        if (wh_transit_send_record(&t, bufs->record, (unsigned long)n,
                                   bufs->work, sizeof(bufs->work),
                                   bufs->wire, sizeof(bufs->wire)) != 0) {
            rc = -1;
            goto done;
        }
        sent += (unsigned long)n;
        if (progress) progress(progress_ctx, sent, filesize);
    }

    /* They hash what they received and send it back; a mismatch means the
     * transfer was corrupted somewhere the encryption did not catch. */
    wh_sha256_final(&hasher, digest);
    wh_hex(digest, sizeof(digest), hex);

    n = wh_transit_recv_record(&t, bufs->record, sizeof(bufs->record),
                               bufs->work, sizeof(bufs->work),
                               bufs->wire, sizeof(bufs->wire));
    if (n <= 0) { rc = -1; goto done; }
    bufs->record[n] = '\0';

    if (wh_json_get((const char *)bufs->record, (unsigned long)n, "sha256", &v) != 0) {
        rc = -1;
        goto done;
    }
    if (!wh_json_streq(&v, hex)) rc = -3;

done:
    wh_transit_close(&t);
    return rc;
}
