#include "wordlist.h"
#include "net.h"

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

int wh_make_code(const char *nameplate, char *out, unsigned long cap)
{
    unsigned char pick[2];
    const char *parts[5];
    unsigned long len = 0, i;
    int p;

    /* One random byte per word indexes the 256-entry list directly, so the
     * choice is uniform without any modulo bias to reason about. */
    wh_net_random(pick, sizeof(pick));

    parts[0] = nameplate;
    parts[1] = "-";
    parts[2] = wh_even_words[pick[0]];
    parts[3] = "-";
    parts[4] = wh_odd_words[pick[1]];

    for (p = 0; p < 5; p++) len += wh_strlen(parts[p]);
    if (len + 1 > cap) return -1;

    len = 0;
    for (p = 0; p < 5; p++) {
        unsigned long n = wh_strlen(parts[p]);
        for (i = 0; i < n; i++) out[len + i] = parts[p][i];
        len += n;
    }
    out[len] = '\0';
    return 0;
}
