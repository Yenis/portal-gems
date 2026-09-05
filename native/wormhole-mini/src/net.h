/* The platform layer. Everything above this line is portable; everything
 * below it is per-platform (port/posix.c today, port/symbian.cpp at S5).
 *
 * The shape is deliberately blocking. On Symbian this becomes RSocket driven
 * by a nested active scheduler wait, which presents the same synchronous
 * face to the protocol code. */
#ifndef WH_NET_H
#define WH_NET_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct wh_conn wh_conn;

/* Connect to host:port. Returns 0, or -1. */
int wh_net_connect(wh_conn **out, const char *host, unsigned int port);

/* Write everything or fail. Returns 0, or -1. */
int wh_net_write(wh_conn *c, const unsigned char *buf, unsigned long len);

/* Read up to `cap` bytes. Returns the count, 0 on a clean close, -1 on
 * error or timeout. */
long wh_net_read(wh_conn *c, unsigned char *buf, unsigned long cap);

void wh_net_close(wh_conn *c);

/* Release whatever the platform set up on first use. A no-op on the host;
 * on Symbian it closes the socket server session and the RConnection, which
 * are opened once and shared by the mailbox and transit sockets. Call it
 * when the program is done with the network, not between transfers. */
void wh_net_shutdown(void);

/* Cryptographically strong bytes. Also what TweetNaCl's randombytes uses. */
void wh_net_random(unsigned char *buf, unsigned long len);

/* Where a connection attempt failed, and what the platform said about it.
 * "Could not connect" on a phone is six different problems wearing the same
 * coat - no access point, capability refused, DNS, firewall, wrong port -
 * and on a device with no debugger the only way to tell them apart is to
 * carry the reason back up. */
#define WH_NET_STAGE_NONE       0
#define WH_NET_STAGE_SOCKETSERV 1  /* RSocketServ::Connect */
#define WH_NET_STAGE_CONNOPEN   2  /* RConnection::Open */
#define WH_NET_STAGE_CONNSTART  3  /* RConnection::Start - the access point */
#define WH_NET_STAGE_RESOLVE    4  /* name resolution */
#define WH_NET_STAGE_SOCKOPEN   5  /* RSocket::Open */
#define WH_NET_STAGE_CONNECT    6  /* RSocket::Connect - the TCP handshake */
#define WH_NET_STAGE_NOSLOT     7  /* connection pool exhausted */

int wh_net_last_stage(void);
long wh_net_last_error(void);

/* Non-zero when sockets are going through an access point the platform
 * explicitly started, zero when they fall back to the system's implicit
 * connection. Diagnostic only. */
int wh_net_have_connection(void);

#ifdef __cplusplus
}
#endif
#endif /* WH_NET_H */
