/* Host platform layer: development and tests on Linux.
 * The Symbian equivalent lands in port/symbian.cpp at phase S5.
 *
 * The project builds with -std=c89, which hides the POSIX networking
 * declarations, so this file - and only this file, being the platform
 * layer - asks for them explicitly. */
#define _POSIX_C_SOURCE 200112L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/select.h>
#include <fcntl.h>

#include "../src/net.h"

/* No malloc after startup, so connections come from a small fixed pool.
 * Two is enough for the whole protocol - one mailbox, one transit. */
#define WH_MAX_CONN 4

struct wh_conn {
    int fd;
    int used;
};

static struct wh_conn g_conns[WH_MAX_CONN];

void wh_net_random(unsigned char *buf, unsigned long len)
{
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) {
        fprintf(stderr, "wormhole-mini: cannot open /dev/urandom\n");
        exit(1);
    }
    if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
        fprintf(stderr, "wormhole-mini: short read from /dev/urandom\n");
        fclose(f);
        exit(1);
    }
    fclose(f);
}

/* TweetNaCl declares this and expects the platform to supply it. */
void randombytes(unsigned char *buf, unsigned long long n)
{
    wh_net_random(buf, (unsigned long)n);
}

/* Non-blocking connect plus select, which is the portable way to bound a
 * connect: SO_SNDTIMEO does not apply to it on every system. */
static int connect_bounded(int fd, const struct sockaddr *addr,
                           socklen_t addrlen, unsigned long ms)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fd_set wset;
    struct timeval tv;
    int err = 0;
    socklen_t elen = sizeof(err);
    int rc;

    if (flags < 0) return -1;
    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return -1;

    rc = connect(fd, addr, addrlen);
    if (rc != 0 && errno != EINPROGRESS) return -1;

    if (rc != 0) {
        FD_ZERO(&wset);
        FD_SET(fd, &wset);
        tv.tv_sec = (long)(ms / 1000);
        tv.tv_usec = (long)((ms % 1000) * 1000);
        rc = select(fd + 1, NULL, &wset, NULL, &tv);
        if (rc <= 0) return -1;                       /* timed out or failed */
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen) != 0) return -1;
        if (err != 0) return -1;
    }

    /* Back to blocking: everything above this layer is written that way. */
    if (fcntl(fd, F_SETFL, flags) < 0) return -1;
    return 0;
}

int wh_net_connect_timeout(wh_conn **out, const char *host, unsigned int port,
                           unsigned long timeout_ms)
{
    struct addrinfo hints, *res = NULL, *ai;
    char portstr[16];
    int fd = -1;
    int i, slot = -1;
    struct timeval tv;

    for (i = 0; i < WH_MAX_CONN; i++) {
        if (!g_conns[i].used) { slot = i; break; }
    }
    if (slot < 0) return -1;

    sprintf(portstr, "%u", port);
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, portstr, &hints, &res) != 0) return -1;

    for (ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connect_bounded(fd, ai->ai_addr, (socklen_t)ai->ai_addrlen,
                            timeout_ms) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) return -1;

    /* A stalled peer must not hang the phone's UI thread forever. */
    tv.tv_sec = 30;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    g_conns[slot].fd = fd;
    g_conns[slot].used = 1;
    *out = &g_conns[slot];
    return 0;
}

int wh_net_connect(wh_conn **out, const char *host, unsigned int port)
{
    return wh_net_connect_timeout(out, host, port, 30000);
}

int wh_net_write(wh_conn *c, const unsigned char *buf, unsigned long len)
{
    unsigned long sent = 0;
    while (sent < len) {
        ssize_t n = send(c->fd, buf + sent, (size_t)(len - sent), 0);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            return -1;
        }
        sent += (unsigned long)n;
    }
    return 0;
}

long wh_net_read(wh_conn *c, unsigned char *buf, unsigned long cap)
{
    ssize_t n;
    do {
        n = recv(c->fd, buf, (size_t)cap, 0);
    } while (n < 0 && errno == EINTR);
    if (n < 0) return -1;
    return (long)n;
}

int wh_net_have_connection(void)
{
    return 1;
}

void wh_net_cancel_arm(void)
{
    /* The host harness runs one transfer to completion; nothing cancels it. */
}

int wh_net_cancelled(void)
{
    return 0;
}

int wh_net_last_stage(void)
{
    return WH_NET_STAGE_NONE;
}

long wh_net_last_error(void)
{
    return 0;
}

void wh_net_shutdown(void)
{
    /* Nothing to release: sockets here are plain file descriptors and each
     * is closed by wh_net_close. */
}

void wh_net_close(wh_conn *c)
{
    if (c && c->used) {
        close(c->fd);
        c->used = 0;
        c->fd = -1;
    }
}
