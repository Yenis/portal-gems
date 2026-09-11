#include "pair.h"
#include "base64.h"
#include "json.h"
#include "kdf.h"
#include "sha256.h"

static const char PREFIX[] = "PGPAIR1:";
#define PREFIX_LEN (sizeof(PREFIX) - 1)

static unsigned long pair_strlen(const char *s)
{
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}

/* Decimal, most significant digit first. Returns the digit count. */
static int put_decimal(unsigned long v, char *out)
{
    char tmp[24];
    int n = 0, i;
    do {
        tmp[n++] = (char)('0' + (v % 10));
        v /= 10;
    } while (v > 0 && n < (int)sizeof(tmp));
    for (i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    return n;
}

unsigned long wh_pair_bucket(unsigned long unix_seconds)
{
    return unix_seconds / WH_PAIR_BUCKET_SECONDS;
}

void wh_pair_derive_code(const unsigned char secret[WH_PAIR_SECRET_LEN],
                         unsigned long bucket, char out[WH_PAIR_CODE_MAX])
{
    static const char LABEL[] = "portalgems-code-v1:";
    char msg[sizeof(LABEL) + 24];
    unsigned char mac[WH_SHA256_LEN];
    char hex[21];
    unsigned long n = sizeof(LABEL) - 1;
    unsigned long u32;
    int i, o;

    for (i = 0; i < (int)(sizeof(LABEL) - 1); i++) msg[i] = LABEL[i];
    n += (unsigned long)put_decimal(bucket, msg + n);

    wh_hmac_sha256(secret, WH_PAIR_SECRET_LEN, (const unsigned char *)msg, n, mac);

    /* Big-endian, then into the 8-digit range 10000000..99999999 - a
     * nameplate that can never collide with the short ones a server hands
     * out, and whose length never varies. */
    u32 = ((unsigned long)mac[0] << 24) | ((unsigned long)mac[1] << 16) |
          ((unsigned long)mac[2] << 8) | (unsigned long)mac[3];
    u32 &= 0xffffffffUL;
    o = put_decimal(10000000UL + (u32 % 90000000UL), out);

    wh_hex(mac + 4, 10, hex);
    out[o++] = '-';
    for (i = 0; i < 10; i++) out[o++] = hex[i];
    out[o++] = '-';
    for (i = 10; i < 20; i++) out[o++] = hex[i];
    out[o] = '\0';
}

long wh_pair_encode(const wh_pair_payload *p, char *out, unsigned long cap)
{
    char json[WH_PAIR_PAYLOAD_MAX];
    char secret_b64[48];
    wh_jw w;
    long n;

    if (wh_base64url_encode(p->secret, WH_PAIR_SECRET_LEN,
                            secret_b64, sizeof(secret_b64)) < 0) return -1;

    /* Key order and the absence of whitespace match JSON.stringify, so the
     * same payload encodes to the same string on every platform. */
    wh_jw_init(&w, json, sizeof(json));
    wh_jw_obj_open(&w);
    wh_jw_u32(&w, "v", 1);
    wh_jw_str(&w, "name", p->name);
    wh_jw_str(&w, "secret", secret_b64);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;

    if (cap < PREFIX_LEN + 1) return -1;
    {
        unsigned long i;
        for (i = 0; i < PREFIX_LEN; i++) out[i] = PREFIX[i];
    }
    n = wh_base64url_encode((const unsigned char *)json, pair_strlen(json),
                            out + PREFIX_LEN, cap - PREFIX_LEN);
    if (n < 0) return -1;
    return (long)PREFIX_LEN + n;
}

static int is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static void copy_str(char *dst, unsigned long cap, const char *src)
{
    unsigned long i = 0;
    while (src[i] && i + 1 < cap) { dst[i] = src[i]; i++; }
    dst[i] = '\0';
}

int wh_pair_decode(const char *text, unsigned long len, wh_pair_payload *out)
{
    char json[WH_PAIR_PAYLOAD_MAX];
    char secret_b64[64];
    unsigned char secret[WH_PAIR_SECRET_LEN + 8];
    wh_json_val v;
    unsigned long start = 0, end = len, i;
    unsigned long version = 0;
    long n;

    while (start < end && is_space(text[start])) start++;
    while (end > start && is_space(text[end - 1])) end--;

    if (end - start < PREFIX_LEN) return -1;
    for (i = 0; i < PREFIX_LEN; i++) {
        if (text[start + i] != PREFIX[i]) return -1;
    }
    start += PREFIX_LEN;

    n = wh_base64url_decode(text + start, end - start,
                            (unsigned char *)json, sizeof(json) - 1);
    if (n <= 0) return -1;
    json[n] = '\0';

    if (wh_json_get(json, (unsigned long)n, "v", &v) != 0) return -1;
    if (wh_json_u32(&v, &version) != 0 || version != 1) return -1;

    if (wh_json_get(json, (unsigned long)n, "secret", &v) != 0) return -1;
    if (wh_json_str(&v, secret_b64, sizeof(secret_b64)) < 0) return -1;
    if (wh_base64url_decode(secret_b64, pair_strlen(secret_b64),
                            secret, sizeof(secret)) != WH_PAIR_SECRET_LEN) return -1;

    if (wh_json_get(json, (unsigned long)n, "name", &v) != 0) return -1;
    if (v.type != WH_JSON_STRING) return -1;
    if (wh_json_str(&v, out->name, sizeof(out->name)) < 0) {
        copy_str(out->name, sizeof(out->name), "PortalGems device");
    }

    for (i = 0; i < WH_PAIR_SECRET_LEN; i++) out->secret[i] = secret[i];
    return 0;
}

long wh_pair_handshake_encode(const char *name, char *out, unsigned long cap)
{
    wh_jw w;
    wh_jw_init(&w, out, cap);
    wh_jw_obj_open(&w);
    wh_jw_u32(&w, "v", 1);
    wh_jw_str(&w, "name", name);
    wh_jw_obj_close(&w);
    if (wh_jw_done(&w) != 0) return -1;
    return (long)pair_strlen(out);
}

int wh_pair_handshake_decode(const char *json, unsigned long len,
                             char *name, unsigned long cap)
{
    wh_json_val v;
    unsigned long version = 0;

    if (wh_json_get(json, len, "v", &v) != 0) return -1;
    if (wh_json_u32(&v, &version) != 0 || version != 1) return -1;
    if (wh_json_get(json, len, "name", &v) != 0) return -1;
    if (v.type != WH_JSON_STRING) return -1;
    if (wh_json_str(&v, name, cap) < 0) {
        copy_str(name, cap, "PortalGems device");
    }
    return 0;
}
