/* Known-answer tests for the wormhole-mini crypto core.
 *
 * Every expected value in vectors.h was produced by the same crates the
 * PortalGems engine uses (native/wormhole-mini/tools/genvectors), so passing
 * this file means the C code agrees with the engine the phone has to
 * interoperate with. */
#include <stdio.h>
#include <string.h>

#include "../src/sha256.h"
#include "../src/kdf.h"
#include "../src/box.h"
#include "vectors/vectors.h"

static int failures = 0;
static int checks = 0;

static void check_hex(const char *what, const unsigned char *got,
                      unsigned long len, const char *expect)
{
    char hex[129];
    checks++;
    wh_hex(got, len, hex);
    if (strcmp(hex, expect) != 0) {
        printf("FAIL %s\n  got      %s\n  expected %s\n", what, hex, expect);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void check_eq(const char *what, unsigned long got, unsigned long expect)
{
    checks++;
    if (got != expect) {
        printf("FAIL %s: got %lu, expected %lu\n", what, got, expect);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void check_bytes(const char *what, const unsigned char *got,
                        const unsigned char *expect, unsigned long len)
{
    checks++;
    if (memcmp(got, expect, (size_t)len) != 0) {
        printf("FAIL %s: %lu bytes differ\n", what, len);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

int main(void)
{
    unsigned char out[32];
    unsigned char transit_key[32];

    /* --- SHA-256 ------------------------------------------------------ */
    wh_sha256((const unsigned char *)"", 0, out);
    check_hex("sha256(\"\")", out, 32, WH_V_SHA256_EMPTY);
    wh_sha256((const unsigned char *)"abc", 3, out);
    check_hex("sha256(\"abc\")", out, 32, WH_V_SHA256_ABC);

    /* A message spanning several blocks, to exercise buffering and the
     * length encoding rather than just the compression function. */
    {
        wh_sha256_ctx s;
        unsigned char big[1000];
        unsigned char once[32];
        int i;
        for (i = 0; i < 1000; i++) big[i] = (unsigned char)(i & 0xff);
        wh_sha256(big, 1000, once);

        /* same input, fed in awkward chunks */
        wh_sha256_init(&s);
        wh_sha256_update(&s, big, 1);
        wh_sha256_update(&s, big + 1, 63);
        wh_sha256_update(&s, big + 64, 500);
        wh_sha256_update(&s, big + 564, 436);
        wh_sha256_final(&s, out);
        check_bytes("sha256 streaming matches one-shot", out, once, 32);
    }

    /* --- derive_key --------------------------------------------------- */
    wh_derive_key_str(WH_V_MAIN_KEY, "purpose1", out);
    check_hex("derive_key(main, \"purpose1\")", out, 32, WH_V_DERIVE_PURPOSE1);

    wh_derive_verifier(WH_V_MAIN_KEY, out);
    check_hex("derive_verifier(main)", out, 32, WH_V_VERIFIER);

    /* --- phase keys --------------------------------------------------- */
    wh_derive_phase_key(WH_V_SIDE, WH_V_MAIN_KEY, "pake", out);
    check_hex("derive_phase_key(side, main, \"pake\")", out, 32, WH_V_PHASE_KEY_PAKE);
    wh_derive_phase_key(WH_V_SIDE, WH_V_MAIN_KEY, "version", out);
    check_hex("derive_phase_key(side, main, \"version\")", out, 32, WH_V_PHASE_KEY_VERSION);
    wh_derive_phase_key(WH_V_SIDE, WH_V_MAIN_KEY, "0", out);
    check_hex("derive_phase_key(side, main, \"0\")", out, 32, WH_V_PHASE_KEY_0);

    /* --- transit ------------------------------------------------------ */
    check_eq("derive_transit_key fits its buffer",
             (unsigned long)wh_derive_transit_key(WH_V_MAIN_KEY, WH_V_APPID, transit_key), 0);
    check_hex("transit key", transit_key, 32, WH_V_TRANSIT_KEY);

    wh_derive_key_str(transit_key, "transit_relay_token", out);
    check_hex("transit_relay_token", out, 32, WH_V_TRANSIT_RELAY_TOKEN);
    wh_derive_key_str(transit_key, "transit_sender", out);
    check_hex("transit_sender", out, 32, WH_V_TRANSIT_SENDER);
    wh_derive_key_str(transit_key, "transit_receiver", out);
    check_hex("transit_receiver", out, 32, WH_V_TRANSIT_RECEIVER);
    wh_derive_key_str(transit_key, "transit_record_sender_key", out);
    check_hex("transit_record_sender_key", out, 32, WH_V_TRANSIT_RECORD_SENDER_KEY);
    wh_derive_key_str(transit_key, "transit_record_receiver_key", out);
    check_hex("transit_record_receiver_key", out, 32, WH_V_TRANSIT_RECORD_RECEIVER_KEY);

    /* The handshake lines are different lengths and the engine asserts both.
     * Pinning them here so the constants in transit.c cannot drift. */
    check_eq("sender handshake line is 87 bytes",
             (unsigned long)strlen(WH_V_TRANSIT_SENDER_LINE), 87);
    check_eq("receiver handshake line is 89 bytes",
             (unsigned long)strlen(WH_V_TRANSIT_RECEIVER_LINE), 89);

    /* --- secretbox ---------------------------------------------------- */
    {
        unsigned char work[2 * (64 + 32)];
        unsigned char wire[64 + 24 + 16];
        unsigned char plain[64];
        unsigned long n = 0;
        unsigned long ptlen = sizeof(WH_V_SB_PLAINTEXT);
        int rc;

        rc = wh_box_seal(WH_V_SB_KEY, WH_V_SB_NONCE, WH_V_SB_PLAINTEXT, ptlen,
                         work, sizeof(work), wire, sizeof(wire), &n);
        check_eq("wh_box_seal returns 0", (unsigned long)rc, 0);
        check_eq("sealed length", n, sizeof(WH_V_SB_WIRE));
        check_bytes("sealed bytes match the engine", wire, WH_V_SB_WIRE,
                    (unsigned long)sizeof(WH_V_SB_WIRE));

        rc = wh_box_open(WH_V_SB_KEY, WH_V_SB_WIRE, sizeof(WH_V_SB_WIRE),
                         work, sizeof(work), plain, sizeof(plain), &n);
        check_eq("wh_box_open returns 0", (unsigned long)rc, 0);
        check_eq("opened length", n, ptlen);
        check_bytes("opened plaintext", plain, WH_V_SB_PLAINTEXT, ptlen);

        /* A flipped bit anywhere must fail authentication, not decrypt. */
        {
            unsigned char tampered[64 + 24 + 16];
            memcpy(tampered, WH_V_SB_WIRE, sizeof(WH_V_SB_WIRE));
            tampered[30] ^= 0x01;
            rc = wh_box_open(WH_V_SB_KEY, tampered, sizeof(WH_V_SB_WIRE),
                             work, sizeof(work), plain, sizeof(plain), &n);
            check_eq("tampered ciphertext is rejected", (unsigned long)(rc == -2), 1);
        }
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
