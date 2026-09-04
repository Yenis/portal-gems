/* Host platform layer: development and tests on Linux.
 * The Symbian equivalent lands in port/symbian.cpp at phase S5. */
#include <stdio.h>
#include <stdlib.h>

/* TweetNaCl declares this and expects the platform to supply it. */
void randombytes(unsigned char *buf, unsigned long long n)
{
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) {
        fprintf(stderr, "wormhole-mini: cannot open /dev/urandom\n");
        exit(1);
    }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) {
        fprintf(stderr, "wormhole-mini: short read from /dev/urandom\n");
        fclose(f);
        exit(1);
    }
    fclose(f);
}
