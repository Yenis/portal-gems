/* A minimal RFC 6455 WebSocket client - only what the mailbox protocol
 * needs: an opening handshake, masked text frames out, text frames in, and
 * correct handling of ping, pong, close and fragmentation.
 *
 * No TLS. The Symbian side cannot do modern TLS at all, so the phone talks
 * to a cleartext ws:// listener on the PortalGems server; see docs/SYMBIAN.md
 * for why that is safe for a PAKE. */
#ifndef WH_WS_H
#define WH_WS_H

#include "net.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    wh_conn *conn;
    unsigned char *rx;     /* caller-owned receive buffer */
    unsigned long rx_cap;
    unsigned long rx_len;  /* bytes currently buffered */
} wh_ws;

#define WH_WS_ERROR (-1)
#define WH_WS_CLOSED (-2)

/* Connect and perform the opening handshake. Returns 0 or WH_WS_ERROR. */
int wh_ws_connect(wh_ws *ws, const char *host, unsigned int port,
                  const char *path, unsigned char *rxbuf, unsigned long rxcap);

/* Send one masked text frame. Returns 0 or WH_WS_ERROR. */
int wh_ws_send_text(wh_ws *ws, const char *text, unsigned long len);

/* Receive one complete text message, reassembling fragments and answering
 * pings along the way. Returns the byte length written to `out`, or
 * WH_WS_ERROR / WH_WS_CLOSED. */
long wh_ws_recv_text(wh_ws *ws, char *out, unsigned long cap);

void wh_ws_close(wh_ws *ws);

#ifdef __cplusplus
}
#endif
#endif /* WH_WS_H */
