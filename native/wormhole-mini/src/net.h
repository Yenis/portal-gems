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

/* Cryptographically strong bytes. Also what TweetNaCl's randombytes uses. */
void wh_net_random(unsigned char *buf, unsigned long len);

#ifdef __cplusplus
}
#endif
#endif /* WH_NET_H */
