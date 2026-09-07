/* Host harness for wormhole-mini.
 *
 * Not the product - the product is the Symbian app. This exists so every
 * layer can be driven and debugged on a laptop, against a real mailbox
 * server, before any of it runs on a phone with no debugger.
 *
 * Usage:
 *   wh-mini [--host H] [--port P] [--path /v1] allocate
 *     Connect, bind, allocate a nameplate, print it, release it.
 *   wh-mini [...] verify --code N-word-word
 *     Run the full handshake on an existing code and print the verifier.
 *     Compare it with `wormhole send --verify` on the other side: matching
 *     verifiers mean both ends derived the same key.
 *   wh-mini [...] receive --code N-word-word [--relay-host H] [--relay-port P]
 *                         [--out DIR]
 *     The whole thing: handshake, offer, and the file itself.
 *   wh-mini [...] send --file PATH [--relay-host H] [--relay-port P]
 *     Allocate a code, print it, and send the file once a peer arrives.
 *
 * --code may be given more than once, in which case receive runs each
 * transfer in turn WITHOUT restarting. That is what the phone does - the
 * application stays open between transfers - and it is the only way to
 * catch state that wrongly survives from one transfer to the next. */
/* Host harness: -std=c89 hides the POSIX declarations this needs. */
#define _POSIX_C_SOURCE 200112L

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>

#include "../src/net.h"
#include "../src/ws.h"
#include "../src/json.h"
#include "../src/kdf.h"
#include "../src/mailbox.h"
#include "../src/xfer.h"
#include "../src/wordlist.h"
#include "../src/zip.h"
#include "../src/zipw.h"

#define APPID "lothar.com/wormhole/text-or-file-xfer"
#define RXCAP 65536
#define MSGCAP 65536

static unsigned char g_rx[RXCAP];
static char g_msg[MSGCAP];
static char g_out[4096];
static wh_xfer_bufs g_xfer;
static wh_inflate_state g_inflate;
static unsigned char g_cd[256UL * 1024UL];
static wh_mailbox_bufs g_mbufs;
static FILE *g_file;
static unsigned long g_last_pct = 999;

/* A wormhole side is five random bytes, hex encoded (core.rs::MySide). */
static void make_side(char side[11])
{
    unsigned char b[5];
    wh_net_random(b, sizeof(b));
    wh_hex(b, sizeof(b), side);
}

/* Read messages until one arrives whose "type" matches, printing everything
 * seen along the way. Returns 0 on success. */
static int wait_for(wh_ws *ws, const char *want)
{
    for (;;) {
        wh_json_val v;
        long n = wh_ws_recv_text(ws, g_msg, sizeof(g_msg));
        if (n == WH_WS_CLOSED) {
            fprintf(stderr, "server closed the connection\n");
            return -1;
        }
        if (n < 0) {
            fprintf(stderr, "websocket error\n");
            return -1;
        }
        printf("  <- %s\n", g_msg);

        if (wh_json_get(g_msg, (unsigned long)n, "type", &v) != 0) continue;
        if (wh_json_streq(&v, "error")) {
            fprintf(stderr, "server reported an error\n");
            return -1;
        }
        if (wh_json_streq(&v, want)) return 0;
    }
}

static int send_msg(wh_ws *ws, const char *json)
{
    printf("  -> %s\n", json);
    return wh_ws_send_text(ws, json, strlen(json));
}

/* Full handshake on an existing code, printing the verifier. */
static int cmd_verify(const char *host, unsigned int port, const char *path,
                      const char *code)
{
    wh_mailbox m;
    unsigned char verifier[32];
    char hex[65];
    int rc;

    wh_mailbox_init(&m, &g_mbufs);

    printf("connecting to ws://%s:%u%s\n", host, port, path);
    if (wh_mailbox_connect(&m, host, port, path, APPID) != 0) {
        fprintf(stderr, "connect/bind failed\n");
        return 1;
    }
    printf("bound as side %s\n", m.side);

    if (wh_mailbox_claim(&m, code) != 0) {
        fprintf(stderr, "claim failed (nameplate taken, or no such code)\n");
        return 1;
    }
    printf("claimed nameplate %s, mailbox %s\n", m.nameplate, m.mailbox);

    printf("waiting for the peer's pake message...\n");
    if (wh_mailbox_pake(&m, APPID, code) != 0) {
        fprintf(stderr, "pake exchange failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }
    wh_hex(m.key, sizeof(m.key), hex);
    printf("shared key derived\n");

    rc = wh_mailbox_version(&m);
    if (rc == -2) {
        fprintf(stderr, "\nWRONG CODE: their version phase did not decrypt\n");
        wh_mailbox_close(&m, "scary");
        return 1;
    }
    if (rc != 0) {
        fprintf(stderr, "version exchange failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    wh_derive_verifier(m.key, verifier);
    wh_hex(verifier, sizeof(verifier), hex);
    printf("\nverifier: %s\n", hex);

    wh_mailbox_close(&m, "happy");
    return 0;
}

static int file_sink(void *ctx, const unsigned char *data, unsigned long len)
{
    FILE *f = (FILE *)ctx;
    return fwrite(data, 1, (size_t)len, f) == (size_t)len ? 0 : -1;
}

static void show_progress(void *ctx, unsigned long done, unsigned long total)
{
    unsigned long pct = total ? (done * 100 / total) : 100;
    (void)ctx;
    if (pct != g_last_pct) {
        printf("\r  %lu%% (%lu / %lu bytes)", pct, done, total);
        fflush(stdout);
        g_last_pct = pct;
    }
}

typedef struct {
    FILE *f;
} TZipOut;

static int zip_out(void *ctx, const unsigned char *buf, unsigned long len)
{
    TZipOut *z = (TZipOut *)ctx;
    return fwrite(buf, 1, (size_t)len, z->f) == (size_t)len ? 0 : -1;
}

/* Join into `dst`, refusing rather than truncating. Checking the result is
 * both the honest way to bound a path and the only way to convince the
 * compiler, which cannot see a separate length guard. */
static int join(char *dst, unsigned long cap, const char *a, const char *sep,
                const char *b)
{
    int n = snprintf(dst, (size_t)cap, "%s%s%s", a, sep, b);
    return (n < 0 || (unsigned long)n >= cap) ? -1 : 0;
}

/* Walk `dir` and add everything under it to the archive.
 *
 * Entry paths are relative to the root with no top-level component, which
 * is what the engine produces and what the reference client expects.
 * Directories are recorded so empty ones survive; symlinks are skipped
 * because they cannot be represented portably and could point outside the
 * tree entirely. */
static int zip_tree(wh_zipw *w, const char *dir, const char *prefix,
                    unsigned long *files, unsigned long *bytes)
{
    DIR *d = opendir(dir);
    struct dirent *e;

    if (!d) return -1;

    while ((e = readdir(d)) != NULL) {
        /* Roomy enough that the guards below, not the buffer, decide when a
         * path is too long. */
        char path[1600];
        char rel[1600];
        struct stat st;

        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
        if (join(path, sizeof(path), dir, "/", e->d_name) != 0 ||
            join(rel, sizeof(rel), prefix, "", e->d_name) != 0) {
            closedir(d);
            return -1;
        }

        if (lstat(path, &st) != 0) { closedir(d); return -1; }
        if (S_ISLNK(st.st_mode)) continue;

        if (S_ISDIR(st.st_mode)) {
            char subprefix[1600];
            char dirent_name[1600];
            if (join(dirent_name, sizeof(dirent_name), rel, "/", "") != 0) {
                closedir(d);
                return -1;
            }
            if (wh_zipw_add_dir(w, dirent_name) != WH_ZIPW_OK) { closedir(d); return -1; }
            if (join(subprefix, sizeof(subprefix), rel, "/", "") != 0) {
                closedir(d);
                return -1;
            }
            if (zip_tree(w, path, subprefix, files, bytes) != 0) { closedir(d); return -1; }
        } else if (S_ISREG(st.st_mode)) {
            FILE *f = fopen(path, "rb");
            unsigned char buf[8192];
            size_t n;
            if (!f) { closedir(d); return -1; }
            if (wh_zipw_begin_file(w, rel) != WH_ZIPW_OK) { fclose(f); closedir(d); return -1; }
            while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
                if (wh_zipw_write(w, buf, (unsigned long)n) != WH_ZIPW_OK) {
                    fclose(f); closedir(d); return -1;
                }
                *bytes += (unsigned long)n;
            }
            fclose(f);
            if (wh_zipw_end_file(w) != WH_ZIPW_OK) { closedir(d); return -1; }
            (*files)++;
        }
    }
    closedir(d);
    return 0;
}

static long file_source(void *ctx, unsigned char *buf, unsigned long cap)
{
    FILE *f = (FILE *)ctx;
    size_t n = fread(buf, 1, (size_t)cap, f);
    if (n == 0 && ferror(f)) return -1;
    return (long)n;
}

/* Everything the mailbox and transfer layers need, shared by both
 * directions. Static rather than stack: see wh_mailbox_bufs. */
static int handshake(wh_mailbox *m, const char *host, unsigned int port,
                     const char *path, const char *code)
{
    int rc;
    if (wh_mailbox_pake(m, APPID, code) != 0) {
        fprintf(stderr, "pake failed\n");
        return -1;
    }
    rc = wh_mailbox_version(m);
    if (rc == -2) {
        fprintf(stderr, "WRONG CODE\n");
        return -1;
    }
    if (rc != 0) {
        fprintf(stderr, "version exchange failed\n");
        return -1;
    }
    (void)host; (void)port; (void)path;
    return 0;
}

static int cmd_send(const char *host, unsigned int port, const char *path,
                    const char *filepath, const char *relay_host,
                    unsigned int relay_port)
{
    wh_mailbox m;
    char code[WH_CODE_MAX];
    char zippath[1024];
    const char *base;
    unsigned long size;
    unsigned long num_files = 0, num_bytes = 0;
    struct stat st;
    int is_dir = 0;
    FILE *f;
    int rc;

    if (stat(filepath, &st) == 0 && S_ISDIR(st.st_mode)) is_dir = 1;

    if (is_dir) {
        /* Zip the tree to a staging file first. The engine does the same:
         * the offer has to state the archive's size before a byte of it
         * goes out. */
        wh_zipw w;
        TZipOut out;

        snprintf(zippath, sizeof(zippath), "%s.portalgems.zip", filepath);
        out.f = fopen(zippath, "wb");
        if (!out.f) {
            fprintf(stderr, "cannot stage the archive at %s\n", zippath);
            return 1;
        }
        wh_zipw_init(&w, zip_out, &out, g_cd, sizeof(g_cd));
        if (zip_tree(&w, filepath, "", &num_files, &num_bytes) != 0 ||
            wh_zipw_finish(&w) != WH_ZIPW_OK) {
            fclose(out.f);
            remove(zippath);
            fprintf(stderr, "could not build the archive\n");
            return 1;
        }
        fclose(out.f);
        printf("zipped %lu files, %lu bytes\n", num_files, num_bytes);
        filepath = zippath;
    }

    f = fopen(filepath, "rb");
    if (!f) {
        fprintf(stderr, "cannot open %s\n", filepath);
        return 1;
    }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 1; }
    size = (unsigned long)ftell(f);
    rewind(f);

    /* Offer the bare name, never the path we happened to read it from. */
    base = strrchr(filepath, '/');
    base = base ? base + 1 : filepath;
    if (is_dir) {
        /* For a folder the offer carries the folder's own name, not the
         * staging file's. */
        static char dirbase[256];
        const char *p = strrchr(zippath, '/');
        unsigned long n;
        p = p ? p + 1 : zippath;
        n = (unsigned long)(strstr(p, ".portalgems.zip") - p);
        if (n >= sizeof(dirbase)) n = sizeof(dirbase) - 1;
        memcpy(dirbase, p, n);
        dirbase[n] = '\0';
        base = dirbase;
    }

    wh_mailbox_init(&m, &g_mbufs);

    printf("connecting to ws://%s:%u%s\n", host, port, path);
    if (wh_mailbox_connect(&m, host, port, path, APPID) != 0) {
        fprintf(stderr, "connect/bind failed\n");
        fclose(f);
        return 1;
    }

    if (wh_mailbox_allocate(&m, code, sizeof(code)) != 0) {
        fprintf(stderr, "could not allocate a code\n");
        fclose(f);
        return 1;
    }

    printf("\nwormhole code: %s\n\n", code);
    printf("waiting for the other side...\n");

    if (handshake(&m, host, port, path, code) != 0) {
        wh_mailbox_close(&m, "errory");
        fclose(f);
        return 1;
    }
    if (is_dir) {
        printf("key confirmed, offering folder %s (%lu files, %lu bytes)\n",
               base, num_files, num_bytes);
    } else {
        printf("key confirmed, offering %s (%lu bytes)\n", base, size);
    }

    if (is_dir) {
        rc = wh_xfer_send_folder(&m, APPID, base, size, num_files, num_bytes,
                                 relay_host, relay_port, &g_xfer,
                                 file_source, f, show_progress, 0);
    } else {
        rc = wh_xfer_send_file(&m, APPID, base, size, relay_host, relay_port,
                               &g_xfer, file_source, f, show_progress, 0);
    }
    fclose(f);
    if (is_dir) remove(zippath);
    printf("\n");

    if (rc == -2) {
        fprintf(stderr, "the other side declined\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }
    if (rc == -3) {
        fprintf(stderr, "CHECKSUM MISMATCH: what they received is not what we sent\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }
    if (rc != 0) {
        fprintf(stderr, "transfer failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    printf("sent, and the other side confirmed the checksum\n");
    wh_mailbox_close(&m, "happy");
    return 0;
}

/* mkdir -p for the directory part of a path. */
static int make_parents(const char *path)
{
    char buf[1024];
    unsigned long i;

    if (strlen(path) >= sizeof(buf)) return -1;
    strcpy(buf, path);
    for (i = 1; buf[i]; i++) {
        if (buf[i] == '/') {
            buf[i] = '\0';
            if (mkdir(buf, 0755) != 0 && errno != EEXIST) return -1;
            buf[i] = '/';
        }
    }
    return 0;
}

typedef struct {
    FILE *f;
    unsigned long written;
    unsigned long cap;
} TUnpackSink;

static int unpack_sink(void *ctx, const unsigned char *data, unsigned long len)
{
    TUnpackSink *u = (TUnpackSink *)ctx;
    if (u->written + len > u->cap) return -1;   /* past the bomb cap */
    u->written += len;
    if (!u->f) return 0;
    return fwrite(data, 1, (size_t)len, u->f) == (size_t)len ? 0 : -1;
}

static long zipfile_read(void *ctx, unsigned long offset, unsigned char *buf,
                         unsigned long len)
{
    FILE *f = (FILE *)ctx;
    if (fseek(f, (long)offset, SEEK_SET) != 0) return -1;
    return (long)fread(buf, 1, (size_t)len, f);
}

/* Unpack a staged archive into `dest`, refusing unsafe names and stopping
 * at the caller's cap. */
static int unpack_zip(const char *zip_path, const char *dest,
                      unsigned long cap)
{
    FILE *zf = fopen(zip_path, "rb");
    wh_zip zip;
    wh_zip_iter it;
    wh_zip_entry entry;
    unsigned long total = 0;
    long size;
    int rc, count = 0;

    if (!zf) return -1;
    fseek(zf, 0, SEEK_END);
    size = ftell(zf);
    rewind(zf);

    if (wh_zip_open(&zip, zipfile_read, zf, (unsigned long)size) != WH_ZIP_OK) {
        fclose(zf);
        fprintf(stderr, "not a readable zip\n");
        return -1;
    }

    if (mkdir(dest, 0755) != 0 && errno != EEXIST) {
        fclose(zf);
        return -1;
    }

    rc = wh_zip_first(&zip, &it, &entry);
    while (rc == WH_ZIP_OK) {
        char path[1024];
        TUnpackSink sink;

        if (!wh_zip_name_is_safe(entry.name)) {
            fprintf(stderr, "refusing unsafe entry: %s\n", entry.name);
            fclose(zf);
            return -1;
        }
        if (join(path, sizeof(path), dest, "/", entry.name) != 0) {
            fclose(zf);
            return -1;
        }

        if (entry.is_dir) {
            make_parents(path);
            mkdir(path, 0755);
            rc = wh_zip_next(&zip, &it, &entry);
            continue;
        }

        if (make_parents(path) != 0) { fclose(zf); return -1; }
        sink.f = fopen(path, "wb");
        sink.written = 0;
        sink.cap = cap > total ? cap - total : 0;
        if (!sink.f) { fclose(zf); return -1; }

        if (wh_zip_extract(&zip, &entry, &g_inflate, unpack_sink, &sink) != WH_ZIP_OK) {
            fclose(sink.f);
            fclose(zf);
            fprintf(stderr, "entry failed: %s\n", entry.name);
            return -1;
        }
        fclose(sink.f);
        total += sink.written;
        count++;

        rc = wh_zip_next(&zip, &it, &entry);
    }
    fclose(zf);
    if (rc < 0) return -1;

    printf("unpacked %d files, %lu bytes\n", count, total);
    return 0;
}

static int cmd_receive(const char *host, unsigned int port, const char *path,
                       const char *code, const char *relay_host,
                       unsigned int relay_port, const char *outdir)
{
    wh_mailbox m;
    wh_offer offer;
    char destpath[512];
    int rc;

    wh_mailbox_init(&m, &g_mbufs);

    printf("connecting to ws://%s:%u%s\n", host, port, path);
    if (wh_mailbox_connect(&m, host, port, path, APPID) != 0) {
        fprintf(stderr, "connect/bind failed\n");
        return 1;
    }
    if (wh_mailbox_claim(&m, code) != 0) {
        fprintf(stderr, "claim failed\n");
        return 1;
    }
    printf("claimed nameplate %s\n", m.nameplate);

    if (wh_mailbox_pake(&m, APPID, code) != 0) {
        fprintf(stderr, "pake failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }
    rc = wh_mailbox_version(&m);
    if (rc == -2) {
        fprintf(stderr, "WRONG CODE\n");
        wh_mailbox_close(&m, "scary");
        return 1;
    }
    if (rc != 0) {
        fprintf(stderr, "version exchange failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }
    printf("key confirmed\n");

    if (wh_xfer_await_offer(&m, relay_host, relay_port, &offer) != 0) {
        fprintf(stderr, "no usable offer\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    if (offer.is_directory) {
        printf("offer: folder %s (%lu files, %lu bytes, %lu zipped)\n",
               offer.dirname, offer.num_files, offer.num_bytes, offer.filesize);
        strcpy(offer.filename, offer.dirname);
    } else {
        printf("offer: %s (%lu bytes)\n", offer.filename, offer.filesize);
    }

    /* The filename comes from the network. Anything with a path separator
     * is refused rather than sanitised, so nothing can be written outside
     * the destination directory. */
    if (strchr(offer.filename, '/') || strchr(offer.filename, '\\') ||
        offer.filename[0] == '\0' || strcmp(offer.filename, "..") == 0) {
        fprintf(stderr, "refusing suspicious filename\n");
        wh_xfer_reject(&m, "bad filename");
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    if (strlen(outdir) + strlen(offer.filename) + 8 > sizeof(destpath)) {
        fprintf(stderr, "destination path too long\n");
        return 1;
    }
    strcpy(destpath, outdir);
    strcat(destpath, "/");
    strcat(destpath, offer.filename);
    /* A folder arrives as a zip, staged next to where it will be unpacked. */
    if (offer.is_directory) strcat(destpath, ".zip");

    g_file = fopen(destpath, "wb");
    if (!g_file) {
        fprintf(stderr, "cannot open %s for writing\n", destpath);
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    printf("connecting to relay tcp://%s:%u\n", relay_host, relay_port);
    rc = wh_xfer_accept(&m, APPID, &offer, relay_host, relay_port, &g_xfer,
                        file_sink, g_file, show_progress, 0);
    fclose(g_file);
    printf("\n");

    if (rc != 0) {
        fprintf(stderr, "transfer failed\n");
        wh_mailbox_close(&m, "errory");
        return 1;
    }

    if (offer.is_directory) {
        char folder[512];
        strcpy(folder, outdir);
        strcat(folder, "/");
        strcat(folder, offer.dirname);
        if (unpack_zip(destpath, folder, wh_unpack_cap(offer.num_bytes)) != 0) {
            fprintf(stderr, "could not unpack the folder\n");
            wh_mailbox_close(&m, "errory");
            return 1;
        }
        remove(destpath);
        printf("received folder %s\n", folder);
    } else {
        printf("received %s\n", destpath);
    }
    wh_mailbox_close(&m, "happy");
    return 0;
}

int main(int argc, char **argv)
{
    const char *host = "127.0.0.1";
    const char *path = "/v1";
    const char *codes[8];
    int code_count = 0;
    const char *code = 0;
    const char *cmd = "allocate";
    const char *relay_host = "127.0.0.1";
    const char *outdir = ".";
    const char *filepath = 0;
    unsigned int relay_port = 4001;
    unsigned int port = 4000;
    char side[11];
    wh_ws ws;
    wh_jw w;
    wh_json_val v;
    char nameplate[64];
    int i;

    /* Line-buffered so progress and the code appear immediately even when
     * stdout is a pipe or a log file. */
    setvbuf(stdout, (char *)0, _IOLBF, 0);

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) host = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = (unsigned int)atoi(argv[++i]);
        else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) path = argv[++i];
        else if (strcmp(argv[i], "--code") == 0 && i + 1 < argc) {
            code = argv[++i];
            if (code_count < (int)(sizeof(codes) / sizeof(codes[0]))) {
                codes[code_count++] = code;
            }
        }
        else if (strcmp(argv[i], "--relay-host") == 0 && i + 1 < argc) relay_host = argv[++i];
        else if (strcmp(argv[i], "--relay-port") == 0 && i + 1 < argc) relay_port = (unsigned int)atoi(argv[++i]);
        else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) outdir = argv[++i];
        else if (strcmp(argv[i], "--file") == 0 && i + 1 < argc) filepath = argv[++i];
        else if (argv[i][0] != '-') cmd = argv[i];
    }

    if (strcmp(cmd, "send") == 0) {
        if (!filepath) {
            fprintf(stderr, "send needs --file PATH\n");
            return 2;
        }
        return cmd_send(host, port, path, filepath, relay_host, relay_port);
    }

    if (strcmp(cmd, "receive") == 0) {
        int n;
        if (code_count == 0) {
            fprintf(stderr, "receive needs --code N-word-word\n");
            return 2;
        }
        for (n = 0; n < code_count; n++) {
            int rc;
            if (code_count > 1) printf("\n=== transfer %d of %d ===\n", n + 1, code_count);
            rc = cmd_receive(host, port, path, codes[n], relay_host, relay_port, outdir);
            if (rc != 0) return rc;
        }
        return 0;
    }

    if (strcmp(cmd, "verify") == 0) {
        if (!code) {
            fprintf(stderr, "verify needs --code N-word-word\n");
            return 2;
        }
        return cmd_verify(host, port, path, code);
    }

    make_side(side);
    printf("connecting to ws://%s:%u%s as side %s\n", host, port, path, side);

    if (wh_ws_connect(&ws, host, port, path, g_rx, sizeof(g_rx)) != 0) {
        fprintf(stderr, "handshake failed\n");
        return 1;
    }
    printf("websocket handshake ok\n");

    /* The server greets us before we say anything. */
    if (wait_for(&ws, "welcome") != 0) return 1;

    wh_jw_init(&w, g_out, sizeof(g_out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "bind");
    wh_jw_str(&w, "appid", APPID);
    wh_jw_str(&w, "side", side);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0 || send_msg(&ws, g_out) != 0) return 1;

    wh_jw_init(&w, g_out, sizeof(g_out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "allocate");
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0 || send_msg(&ws, g_out) != 0) return 1;

    if (wait_for(&ws, "allocated") != 0) return 1;
    if (wh_json_get(g_msg, strlen(g_msg), "nameplate", &v) != 0) {
        fprintf(stderr, "allocated message had no nameplate\n");
        return 1;
    }
    if (wh_json_str(&v, nameplate, sizeof(nameplate)) < 0) return 1;

    printf("\nallocated nameplate: %s\n", nameplate);

    wh_jw_init(&w, g_out, sizeof(g_out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "release");
    wh_jw_str(&w, "nameplate", nameplate);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) == 0) send_msg(&ws, g_out);

    wh_ws_close(&ws);
    return 0;
}
