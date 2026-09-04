#include "mailbox.h"
#include "json.h"
#include "kdf.h"
#include "box.h"
#include "net.h"
#include "wordlist.h"

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

void wh_mailbox_init(wh_mailbox *m, wh_mailbox_bufs *bufs)
{
    m->b = bufs;
    m->side[0] = '\0';
    m->their_side[0] = '\0';
    m->nameplate[0] = '\0';
    m->mailbox[0] = '\0';
    m->have_key = 0;
    m->have_their_side = 0;
    m->tx_phase = 0;
    m->server_error = 0;
}

static int send_out(wh_mailbox *m)
{
    return wh_ws_send_text(&m->ws, m->b->out, wh_strlen(m->b->out));
}

/* Read until a message of the wanted type arrives. `ack` and anything else
 * uninteresting is skipped. A server `error` aborts. */
static long wait_type(wh_mailbox *m, const char *want)
{
    for (;;) {
        wh_json_val v;
        long n = wh_ws_recv_text(&m->ws, m->b->msg, sizeof(m->b->msg));
        if (n < 0) return -1;
        if (wh_json_get(m->b->msg, (unsigned long)n, "type", &v) != 0) continue;
        if (wh_json_streq(&v, "error")) {
            m->server_error = 1;
            return -1;
        }
        if (wh_json_streq(&v, want)) return n;
    }
}

int wh_mailbox_connect(wh_mailbox *m, const char *host, unsigned int port,
                       const char *path, const char *appid)
{
    unsigned char b[5];
    wh_jw w;

    wh_net_random(b, sizeof(b));
    wh_hex(b, sizeof(b), m->side);

    if (wh_ws_connect(&m->ws, host, port, path, m->b->rx, sizeof(m->b->rx)) != 0) return -1;
    if (wait_type(m, "welcome") < 0) return -1;

    wh_jw_init(&w, m->b->out, sizeof(m->b->out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "bind");
    wh_jw_str(&w, "appid", appid);
    wh_jw_str(&w, "side", m->side);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;
    return send_out(m);
}

/* Claim m->nameplate and open the mailbox the server names for it. */
static int claim_and_open(wh_mailbox *m)
{
    wh_jw w;
    wh_json_val v;

    wh_jw_init(&w, m->b->out, sizeof(m->b->out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "claim");
    wh_jw_str(&w, "nameplate", m->nameplate);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0 || send_out(m) != 0) return -1;

    if (wait_type(m, "claimed") < 0) return -1;
    if (wh_json_get(m->b->msg, wh_strlen(m->b->msg), "mailbox", &v) != 0) return -1;
    if (wh_json_str(&v, m->mailbox, sizeof(m->mailbox)) < 0) return -1;

    wh_jw_init(&w, m->b->out, sizeof(m->b->out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "open");
    wh_jw_str(&w, "mailbox", m->mailbox);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;
    return send_out(m);
}

int wh_mailbox_claim(wh_mailbox *m, const char *code)
{
    unsigned long i = 0;

    /* The nameplate is everything before the first '-'. */
    while (code[i] && code[i] != '-' && i + 1 < sizeof(m->nameplate)) {
        m->nameplate[i] = code[i];
        i++;
    }
    m->nameplate[i] = '\0';
    if (i == 0) return -1;

    return claim_and_open(m);
}

int wh_mailbox_allocate(wh_mailbox *m, char *code_out, unsigned long cap)
{
    wh_jw w;
    wh_json_val v;

    wh_jw_init(&w, m->b->out, sizeof(m->b->out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "allocate");
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0 || send_out(m) != 0) return -1;

    if (wait_type(m, "allocated") < 0) return -1;
    if (wh_json_get(m->b->msg, wh_strlen(m->b->msg), "nameplate", &v) != 0) return -1;
    if (wh_json_str(&v, m->nameplate, sizeof(m->nameplate)) < 0) return -1;

    if (wh_make_code(m->nameplate, code_out, cap) != 0) return -1;
    return claim_and_open(m);
}

/* Post one phase body, already hex-encoded. */
static int add_phase(wh_mailbox *m, const char *phase, const char *body_hex)
{
    wh_jw w;
    wh_jw_init(&w, m->b->out, sizeof(m->b->out));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "type", "add");
    wh_jw_str(&w, "phase", phase);
    wh_jw_str(&w, "body", body_hex);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;
    return send_out(m);
}

/* Wait for a peer message in `phase`, returning its body as raw bytes.
 * Messages echoed back from our own side are ignored. */
static long recv_phase_body(wh_mailbox *m, const char *phase,
                            unsigned char *out, unsigned long cap)
{
    for (;;) {
        wh_json_val v;
        long n = wait_type(m, "message");
        if (n < 0) return -1;

        if (wh_json_get(m->b->msg, (unsigned long)n, "side", &v) != 0) continue;
        if (wh_json_streq(&v, m->side)) continue;  /* our own, echoed back */
        if (!m->have_their_side) {
            if (wh_json_str(&v, m->their_side, sizeof(m->their_side)) < 0) return -1;
            m->have_their_side = 1;
        }

        if (wh_json_get(m->b->msg, (unsigned long)n, "phase", &v) != 0) continue;
        if (!wh_json_streq(&v, phase)) continue;

        if (wh_json_get(m->b->msg, (unsigned long)n, "body", &v) != 0) return -1;
        return wh_unhex(v.p, v.len, out, cap);
    }
}

int wh_mailbox_pake(wh_mailbox *m, const char *appid, const char *code)
{
    unsigned char entropy[64];
    unsigned char msg1[WH_SPAKE2_MSG_LEN];
    unsigned char theirs[WH_SPAKE2_MSG_LEN];
    unsigned char body[256];
    char hex1[WH_SPAKE2_MSG_LEN * 2 + 1];
    char body_hex[512];
    wh_jw w;
    long n;

    wh_net_random(entropy, sizeof(entropy));
    wh_spake2_start(&m->pake, code, appid, entropy, msg1);
    wh_hex(msg1, sizeof(msg1), hex1);

    /* The pake body is plaintext JSON: {"pake_v1": "<hex>"} */
    wh_jw_init(&w, (char *)body, sizeof(body));
    wh_jw_obj_open(&w);
    wh_jw_str(&w, "pake_v1", hex1);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    wh_hex(body, wh_strlen((const char *)body), body_hex);
    if (add_phase(m, "pake", body_hex) != 0) return -1;

    n = recv_phase_body(m, "pake", body, sizeof(body) - 1);
    if (n <= 0) return -1;
    body[n] = '\0';

    {
        wh_json_val v;
        char hex2[WH_SPAKE2_MSG_LEN * 2 + 1];
        if (wh_json_get((const char *)body, (unsigned long)n, "pake_v1", &v) != 0) return -1;
        if (v.len >= sizeof(hex2)) return -1;
        if (wh_json_str(&v, hex2, sizeof(hex2)) < 0) return -1;
        if (wh_unhex(hex2, wh_strlen(hex2), theirs, sizeof(theirs)) != WH_SPAKE2_MSG_LEN) {
            return -1;
        }
    }

    if (wh_spake2_finish(&m->pake, theirs, m->key) != 0) return -1;
    m->have_key = 1;
    return 0;
}

/* Encrypt `plaintext` under the phase key for our side and post it. */
static int send_encrypted(wh_mailbox *m, const char *phase,
                          const char *plaintext, unsigned long len)
{
    unsigned char pkey[32];
    unsigned char nonce[WH_NONCE_LEN];
    unsigned long wire_len = 0;

    if (!m->have_key) return -1;
    if (len > WH_PHASE_MAX) return -1;

    wh_derive_phase_key(m->side, m->key, phase, pkey);
    wh_net_random(nonce, sizeof(nonce));
    if (wh_box_seal(pkey, nonce, (const unsigned char *)plaintext, len,
                    m->b->work, sizeof(m->b->work),
                    m->b->wire, sizeof(m->b->wire), &wire_len) != 0) {
        return -1;
    }
    wh_hex(m->b->wire, wire_len, m->b->hex);
    return add_phase(m, phase, m->b->hex);
}

/* Receive and decrypt a phase message from the peer. */
static long recv_encrypted(wh_mailbox *m, const char *phase,
                           char *out, unsigned long cap)
{
    unsigned char pkey[32];
    unsigned long plen = 0;
    long n;
    int rc;

    n = recv_phase_body(m, phase, m->b->wire, sizeof(m->b->wire));
    if (n < 0) return -1;

    wh_derive_phase_key(m->their_side, m->key, phase, pkey);
    rc = wh_box_open(pkey, m->b->wire, (unsigned long)n,
                     m->b->work, sizeof(m->b->work),
                     (unsigned char *)out, cap, &plen);
    if (rc == -2) return -2;   /* authentication failed: wrong code */
    if (rc != 0) return -1;
    return (long)plen;
}

int wh_mailbox_version(wh_mailbox *m)
{
    /* What the engine advertises (transfer.rs::AppVersion::new): protocol
     * v1 only, no transfer-v2. */
    static const char VERSIONS[] =
        "{\"abilities\":[],\"app_versions\":{\"abilities\":[\"transfer-v1\"]}}";
    char plain[512];
    long n;

    if (send_encrypted(m, "version", VERSIONS, sizeof(VERSIONS) - 1) != 0) return -1;

    n = recv_encrypted(m, "version", plain, sizeof(plain));
    if (n == -2) return -2;
    if (n < 0) return -1;
    return 0;
}

int wh_mailbox_send_phase(wh_mailbox *m, const char *plaintext,
                          unsigned long len)
{
    char phase[24];
    unsigned long v = m->tx_phase;
    char tmp[24];
    int d = 0, i;

    if (v == 0) {
        phase[0] = '0';
        phase[1] = '\0';
    } else {
        while (v > 0 && d < (int)sizeof(tmp)) { tmp[d++] = (char)('0' + (v % 10)); v /= 10; }
        for (i = 0; i < d; i++) phase[i] = tmp[d - 1 - i];
        phase[d] = '\0';
    }
    m->tx_phase++;
    return send_encrypted(m, phase, plaintext, len);
}

long wh_mailbox_recv_phase(wh_mailbox *m, char *out, unsigned long cap)
{
    /* Numeric phases arrive in order from a given peer; the engine tracks
     * them by counting. We do the same, using a separate counter from the
     * send side because the two directions are independent. */
    static unsigned long rx_phase;  /* one connection at a time in this client */
    char phase[24];
    unsigned long v = rx_phase;
    char tmp[24];
    int d = 0, i;

    if (v == 0) {
        phase[0] = '0';
        phase[1] = '\0';
    } else {
        while (v > 0 && d < (int)sizeof(tmp)) { tmp[d++] = (char)('0' + (v % 10)); v /= 10; }
        for (i = 0; i < d; i++) phase[i] = tmp[d - 1 - i];
        phase[d] = '\0';
    }
    rx_phase++;
    return recv_encrypted(m, phase, out, cap);
}

void wh_mailbox_close(wh_mailbox *m, const char *mood)
{
    wh_jw w;
    if (m->mailbox[0]) {
        wh_jw_init(&w, m->b->out, sizeof(m->b->out));
        wh_jw_obj_open(&w);
        wh_jw_str(&w, "type", "close");
        wh_jw_str(&w, "mailbox", m->mailbox);
        wh_jw_str(&w, "mood", mood);
        wh_jw_obj_close(&w);
        if (wh_jw_done(&w) == 0) send_out(m);
    }
    wh_ws_close(&m->ws);
}
