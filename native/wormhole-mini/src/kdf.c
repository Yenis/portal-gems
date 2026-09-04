#include "kdf.h"
#include "sha256.h"

void wh_derive_key(const unsigned char key[WH_KEY_LEN],
                   const unsigned char *purpose, unsigned long purpose_len,
                   unsigned char out[WH_KEY_LEN])
{
    wh_hkdf_sha256(key, WH_KEY_LEN, purpose, purpose_len, out, WH_KEY_LEN);
}

static unsigned long wh_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

void wh_derive_key_str(const unsigned char key[WH_KEY_LEN],
                       const char *purpose, unsigned char out[WH_KEY_LEN])
{
    wh_derive_key(key, (const unsigned char *)purpose, wh_strlen(purpose), out);
}

void wh_derive_phase_key(const char *side, const unsigned char key[WH_KEY_LEN],
                         const char *phase, unsigned char out[WH_KEY_LEN])
{
    static const char prefix[] = "wormhole:phase:";
    unsigned char purpose[15 + WH_SHA256_LEN + WH_SHA256_LEN];
    int i;

    for (i = 0; i < 15; i++) purpose[i] = (unsigned char)prefix[i];
    wh_sha256((const unsigned char *)side, wh_strlen(side), purpose + 15);
    wh_sha256((const unsigned char *)phase, wh_strlen(phase),
              purpose + 15 + WH_SHA256_LEN);

    wh_derive_key(key, purpose, sizeof(purpose), out);
}

void wh_derive_verifier(const unsigned char key[WH_KEY_LEN],
                        unsigned char out[WH_KEY_LEN])
{
    wh_derive_key_str(key, "wormhole:verifier", out);
}

int wh_derive_transit_key(const unsigned char key[WH_KEY_LEN], const char *appid,
                          unsigned char out[WH_KEY_LEN])
{
    static const char suffix[] = "/transit-key";
    char purpose[WH_PURPOSE_MAX];
    unsigned long n = wh_strlen(appid);
    unsigned long i;

    if (n + sizeof(suffix) > WH_PURPOSE_MAX) return -1;
    for (i = 0; i < n; i++) purpose[i] = appid[i];
    for (i = 0; i < sizeof(suffix); i++) purpose[n + i] = suffix[i];

    wh_derive_key_str(key, purpose, out);
    return 0;
}

void wh_hex(const unsigned char *in, unsigned long len, char *out)
{
    static const char digits[] = "0123456789abcdef";
    unsigned long i;
    for (i = 0; i < len; i++) {
        out[i * 2] = digits[(in[i] >> 4) & 0xf];
        out[i * 2 + 1] = digits[in[i] & 0xf];
    }
    out[len * 2] = '\0';
}
