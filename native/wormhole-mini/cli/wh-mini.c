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
 *     verifiers mean both ends derived the same key. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "../src/net.h"
#include "../src/ws.h"
#include "../src/json.h"
#include "../src/kdf.h"
#include "../src/mailbox.h"

#define APPID "lothar.com/wormhole/text-or-file-xfer"
#define RXCAP 65536
#define MSGCAP 65536

static unsigned char g_rx[RXCAP];
static char g_msg[MSGCAP];
static char g_out[4096];
static unsigned char g_work[8192];

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

    wh_mailbox_init(&m, g_rx, sizeof(g_rx), g_msg, sizeof(g_msg),
                    g_out, sizeof(g_out), g_work, sizeof(g_work));

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

int main(int argc, char **argv)
{
    const char *host = "127.0.0.1";
    const char *path = "/v1";
    const char *code = 0;
    const char *cmd = "allocate";
    unsigned int port = 4000;
    char side[11];
    wh_ws ws;
    wh_jw w;
    wh_json_val v;
    char nameplate[64];
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) host = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = (unsigned int)atoi(argv[++i]);
        else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) path = argv[++i];
        else if (strcmp(argv[i], "--code") == 0 && i + 1 < argc) code = argv[++i];
        else if (argv[i][0] != '-') cmd = argv[i];
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
