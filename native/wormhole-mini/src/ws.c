#include "ws.h"
#include "sha1.h"
#include "base64.h"

#define OP_CONT  0x0
#define OP_TEXT  0x1
#define OP_BIN   0x2
#define OP_CLOSE 0x8
#define OP_PING  0x9
#define OP_PONG  0xa

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

static void wh_memmove(unsigned char *d, const unsigned char *s, unsigned long n)
{
    unsigned long i;
    if (d < s) {
        for (i = 0; i < n; i++) d[i] = s[i];
    } else {
        for (i = n; i > 0; i--) d[i - 1] = s[i - 1];
    }
}

static char lower(char c)
{
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

/* Ensure at least `n` bytes are buffered. */
static long ws_need(wh_ws *ws, unsigned long n)
{
    if (n > ws->rx_cap) return WH_WS_ERROR;
    while (ws->rx_len < n) {
        long got = wh_net_read(ws->conn, ws->rx + ws->rx_len,
                               ws->rx_cap - ws->rx_len);
        if (got == 0) return WH_WS_CLOSED;
        if (got < 0) return WH_WS_ERROR;
        ws->rx_len += (unsigned long)got;
    }
    return 0;
}

static void ws_consume(wh_ws *ws, unsigned long n)
{
    if (n >= ws->rx_len) {
        ws->rx_len = 0;
        return;
    }
    wh_memmove(ws->rx, ws->rx + n, ws->rx_len - n);
    ws->rx_len -= n;
}

/* Write one frame with the given opcode. Client frames are always masked;
 * the payload is masked in small chunks so no large transmit buffer is
 * needed. */
static int ws_send_frame(wh_ws *ws, int opcode, const unsigned char *payload,
                         unsigned long len)
{
    unsigned char hdr[14];
    unsigned char mask[4];
    unsigned char chunk[256];
    unsigned long hn = 0, off = 0;
    unsigned long i;

    wh_net_random(mask, 4);

    hdr[hn++] = (unsigned char)(0x80 | opcode); /* FIN */
    if (len < 126) {
        hdr[hn++] = (unsigned char)(0x80 | len);
    } else if (len < 0x10000) {
        hdr[hn++] = (unsigned char)(0x80 | 126);
        hdr[hn++] = (unsigned char)((len >> 8) & 0xff);
        hdr[hn++] = (unsigned char)(len & 0xff);
    } else {
        hdr[hn++] = (unsigned char)(0x80 | 127);
        hdr[hn++] = 0; hdr[hn++] = 0; hdr[hn++] = 0; hdr[hn++] = 0;
        hdr[hn++] = (unsigned char)((len >> 24) & 0xff);
        hdr[hn++] = (unsigned char)((len >> 16) & 0xff);
        hdr[hn++] = (unsigned char)((len >> 8) & 0xff);
        hdr[hn++] = (unsigned char)(len & 0xff);
    }
    for (i = 0; i < 4; i++) hdr[hn++] = mask[i];

    if (wh_net_write(ws->conn, hdr, hn) != 0) return WH_WS_ERROR;

    while (off < len) {
        unsigned long n = len - off;
        if (n > sizeof(chunk)) n = sizeof(chunk);
        for (i = 0; i < n; i++) {
            chunk[i] = (unsigned char)(payload[off + i] ^ mask[(off + i) & 3]);
        }
        if (wh_net_write(ws->conn, chunk, n) != 0) return WH_WS_ERROR;
        off += n;
    }
    return 0;
}

int wh_ws_send_text(wh_ws *ws, const char *text, unsigned long len)
{
    return ws_send_frame(ws, OP_TEXT, (const unsigned char *)text, len);
}

int wh_ws_connect(wh_ws *ws, const char *host, unsigned int port,
                  const char *path, unsigned char *rxbuf, unsigned long rxcap)
{
    static const char GUID[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    unsigned char nonce[16];
    unsigned char accept_src[64];
    unsigned char digest[WH_SHA1_LEN];
    char key_b64[32];
    char expect_b64[32];
    char req[512];
    unsigned long n = 0, i, hdr_end = 0;
    long rc;

    ws->conn = 0;
    ws->rx = rxbuf;
    ws->rx_cap = rxcap;
    ws->rx_len = 0;

    if (wh_net_connect(&ws->conn, host, port) != 0) return WH_WS_ERROR;

    wh_net_random(nonce, sizeof(nonce));
    if (wh_base64_encode(nonce, sizeof(nonce), key_b64, sizeof(key_b64)) < 0) {
        wh_ws_close(ws);
        return WH_WS_ERROR;
    }

    /* Hand-built so there is no printf dependency in the core. */
    {
        const char *parts[9];
        char portbuf[16];
        unsigned long p = port, d = 0;
        char tmp[16];

        if (p == 0) { portbuf[0] = '0'; portbuf[1] = '\0'; }
        else {
            while (p > 0) { tmp[d++] = (char)('0' + (p % 10)); p /= 10; }
            for (i = 0; i < d; i++) portbuf[i] = tmp[d - 1 - i];
            portbuf[d] = '\0';
        }

        parts[0] = "GET "; parts[1] = path;
        parts[2] = " HTTP/1.1\r\nHost: "; parts[3] = host;
        parts[4] = ":"; parts[5] = portbuf;
        parts[6] = "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Key: ";
        parts[7] = key_b64;
        parts[8] = "\r\nSec-WebSocket-Version: 13\r\n\r\n";

        for (i = 0; i < 9; i++) {
            unsigned long k, m = wh_strlen(parts[i]);
            if (n + m >= sizeof(req)) { wh_ws_close(ws); return WH_WS_ERROR; }
            for (k = 0; k < m; k++) req[n++] = parts[i][k];
        }
    }

    if (wh_net_write(ws->conn, (const unsigned char *)req, n) != 0) {
        wh_ws_close(ws);
        return WH_WS_ERROR;
    }

    /* Read until the header terminator. Anything after it is the start of
     * the frame stream and must be kept - the server may pipeline its
     * welcome message immediately behind the handshake. */
    for (;;) {
        long got;
        if (ws->rx_len >= 4) {
            for (i = 0; i + 3 < ws->rx_len; i++) {
                if (ws->rx[i] == '\r' && ws->rx[i + 1] == '\n' &&
                    ws->rx[i + 2] == '\r' && ws->rx[i + 3] == '\n') {
                    hdr_end = i + 4;
                    break;
                }
            }
            if (hdr_end) break;
        }
        if (ws->rx_len >= ws->rx_cap) { wh_ws_close(ws); return WH_WS_ERROR; }
        got = wh_net_read(ws->conn, ws->rx + ws->rx_len, ws->rx_cap - ws->rx_len);
        if (got <= 0) { wh_ws_close(ws); return WH_WS_ERROR; }
        ws->rx_len += (unsigned long)got;
    }

    /* Status must be 101. */
    if (hdr_end < 12 || ws->rx[9] != '1' || ws->rx[10] != '0' || ws->rx[11] != '1') {
        wh_ws_close(ws);
        return WH_WS_ERROR;
    }

    /* Sec-WebSocket-Accept must be base64(sha1(key + GUID)). */
    {
        unsigned long klen = wh_strlen(key_b64);
        unsigned long glen = wh_strlen(GUID);
        unsigned long found = 0;
        static const char NAME[] = "sec-websocket-accept:";
        unsigned long nlen = sizeof(NAME) - 1;

        if (klen + glen > sizeof(accept_src)) { wh_ws_close(ws); return WH_WS_ERROR; }
        for (i = 0; i < klen; i++) accept_src[i] = (unsigned char)key_b64[i];
        for (i = 0; i < glen; i++) accept_src[klen + i] = (unsigned char)GUID[i];
        wh_sha1(accept_src, klen + glen, digest);
        if (wh_base64_encode(digest, WH_SHA1_LEN, expect_b64, sizeof(expect_b64)) < 0) {
            wh_ws_close(ws);
            return WH_WS_ERROR;
        }

        for (i = 0; i + nlen < hdr_end; i++) {
            unsigned long k;
            int match = 1;
            for (k = 0; k < nlen; k++) {
                if (lower((char)ws->rx[i + k]) != NAME[k]) { match = 0; break; }
            }
            if (!match) continue;
            k = i + nlen;
            while (k < hdr_end && (ws->rx[k] == ' ' || ws->rx[k] == '\t')) k++;
            {
                unsigned long e = wh_strlen(expect_b64);
                unsigned long j;
                if (k + e > hdr_end) break;
                found = 1;
                for (j = 0; j < e; j++) {
                    if (ws->rx[k + j] != (unsigned char)expect_b64[j]) { found = 0; break; }
                }
            }
            break;
        }
        if (!found) { wh_ws_close(ws); return WH_WS_ERROR; }
    }

    ws_consume(ws, hdr_end);
    rc = 0;
    return (int)rc;
}

long wh_ws_recv_text(wh_ws *ws, char *out, unsigned long cap)
{
    unsigned long total = 0;

    for (;;) {
        unsigned long need, plen, hdr;
        int opcode, fin, masked;
        long rc;

        rc = ws_need(ws, 2);
        if (rc < 0) return rc;

        fin = (ws->rx[0] & 0x80) ? 1 : 0;
        opcode = ws->rx[0] & 0x0f;
        masked = (ws->rx[1] & 0x80) ? 1 : 0;
        plen = (unsigned long)(ws->rx[1] & 0x7f);
        hdr = 2;

        /* A server must never mask. */
        if (masked) return WH_WS_ERROR;

        if (plen == 126) {
            rc = ws_need(ws, 4);
            if (rc < 0) return rc;
            plen = ((unsigned long)ws->rx[2] << 8) | (unsigned long)ws->rx[3];
            hdr = 4;
        } else if (plen == 127) {
            rc = ws_need(ws, 10);
            if (rc < 0) return rc;
            /* The mailbox never sends anything remotely this large; reject
             * rather than pretend to support 64-bit lengths on a phone. */
            if (ws->rx[2] || ws->rx[3] || ws->rx[4] || ws->rx[5]) return WH_WS_ERROR;
            plen = ((unsigned long)ws->rx[6] << 24) | ((unsigned long)ws->rx[7] << 16) |
                   ((unsigned long)ws->rx[8] << 8) | (unsigned long)ws->rx[9];
            hdr = 10;
        }

        need = hdr + plen;
        rc = ws_need(ws, need);
        if (rc < 0) return rc;

        switch (opcode) {
        case OP_PING:
            if (ws_send_frame(ws, OP_PONG, ws->rx + hdr, plen) != 0) return WH_WS_ERROR;
            ws_consume(ws, need);
            continue;
        case OP_PONG:
            ws_consume(ws, need);
            continue;
        case OP_CLOSE:
            ws_consume(ws, need);
            return WH_WS_CLOSED;
        case OP_BIN:
            /* Not part of this protocol. Skip it rather than fail. */
            ws_consume(ws, need);
            continue;
        case OP_TEXT:
        case OP_CONT: {
            unsigned long i;
            if (total + plen >= cap) return WH_WS_ERROR;
            for (i = 0; i < plen; i++) out[total + i] = (char)ws->rx[hdr + i];
            total += plen;
            ws_consume(ws, need);
            if (fin) {
                out[total] = '\0';
                return (long)total;
            }
            continue;
        }
        default:
            return WH_WS_ERROR;
        }
    }
}

void wh_ws_close(wh_ws *ws)
{
    if (ws->conn) {
        wh_net_close(ws->conn);
        ws->conn = 0;
    }
}
