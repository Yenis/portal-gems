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
#include "../src/ed25519.h"
#include "../src/spake2.h"
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

    /* The message length is counted in bits across two 32-bit halves,
     * because C89 has no 64-bit integer we can rely on. The carry between
     * them only happens past 512 MiB of input - well within reach for a
     * video off the phone's memory card, and far too slow to reach by
     * actually hashing that much here. So drive the counter to the boundary
     * directly and check it crosses correctly. */
    {
        wh_sha256_ctx s;
        unsigned char one = 'x';
        wh_sha256_init(&s);
        s.nbits_lo = 0xfffffff8u;   /* eight bits short of 2^32 */
        s.nbits_hi = 0;
        wh_sha256_update(&s, &one, 1);
        check_eq("bit counter wraps its low half", (unsigned long)s.nbits_lo, 0);
        check_eq("bit counter carries into its high half",
                 (unsigned long)s.nbits_hi, 1);
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

    /* --- ed25519 group ------------------------------------------------ */
    {
        wh_ed_point p;
        unsigned char round[32];
        unsigned char sc[32];

        check_eq("decompress(S) succeeds",
                 (unsigned long)wh_ed_decompress(&p, WH_V_SPAKE2_S), 0);
        wh_ed_compress(round, &p);
        check_bytes("compress(decompress(S)) round-trips", round, WH_V_SPAKE2_S, 32);

        check_eq("decompress rejects a non-curve point",
                 (unsigned long)(wh_ed_decompress(&p, WH_V_ED_INVALID_POINT) == -1), 1);

        wh_sc_reduce_wide(sc, WH_V_SPAKE2_X_RNG);
        check_bytes("reduce_wide matches Scalar::from_bytes_mod_order_wide",
                    sc, WH_V_SPAKE2_X_SCALAR, 32);

        /* -(-s) == s, and s + (-s) == 0 mod L. */
        {
            unsigned char neg[32], negneg[32], sum[64], zero[32];
            int i, carry = 0;
            wh_sc_neg(neg, WH_V_SPAKE2_X_SCALAR);
            wh_sc_neg(negneg, neg);
            check_bytes("scalar negation is an involution",
                        negneg, WH_V_SPAKE2_X_SCALAR, 32);

            for (i = 0; i < 64; i++) sum[i] = 0;
            for (i = 0; i < 32; i++) {
                int v = (int)WH_V_SPAKE2_X_SCALAR[i] + (int)neg[i] + carry;
                sum[i] = (unsigned char)(v & 0xff);
                carry = v >> 8;
            }
            sum[32] = (unsigned char)carry;
            wh_sc_reduce_wide(sum, sum);
            for (i = 0; i < 32; i++) zero[i] = 0;
            check_bytes("s + (-s) == 0 mod L", sum, zero, 32);
        }
    }

    /* --- SPAKE2 -------------------------------------------------------- */
    {
        wh_spake2 a, b;
        unsigned char msg_a[WH_SPAKE2_MSG_LEN];
        unsigned char msg_b[WH_SPAKE2_MSG_LEN];
        unsigned char key_a[32], key_b[32];
        unsigned char bad[WH_SPAKE2_MSG_LEN];
        int i;

        wh_spake2_start(&a, WH_V_SPAKE2_PASSWORD, WH_V_APPID, WH_V_SPAKE2_X_RNG, msg_a);
        wh_spake2_start(&b, WH_V_SPAKE2_PASSWORD, WH_V_APPID, WH_V_SPAKE2_Y_RNG, msg_b);

        check_bytes("password maps to the same scalar as the crate",
                    a.pw_scalar, WH_V_SPAKE2_PW_SCALAR, 32);
        check_bytes("msg1 matches the crate", msg_a, WH_V_SPAKE2_MSG1,
                    WH_SPAKE2_MSG_LEN);
        check_bytes("msg2 matches the crate", msg_b, WH_V_SPAKE2_MSG2,
                    WH_SPAKE2_MSG_LEN);

        check_eq("finish(a, msg2) returns 0",
                 (unsigned long)wh_spake2_finish(&a, WH_V_SPAKE2_MSG2, key_a), 0);
        check_bytes("shared key matches the crate", key_a, WH_V_SPAKE2_KEY, 32);

        check_eq("finish(b, msg1) returns 0",
                 (unsigned long)wh_spake2_finish(&b, WH_V_SPAKE2_MSG1, key_b), 0);
        check_bytes("both sides agree on the key", key_b, WH_V_SPAKE2_KEY, 32);

        /* Wrong side byte, and a message that is not a curve point. */
        for (i = 0; i < WH_SPAKE2_MSG_LEN; i++) bad[i] = WH_V_SPAKE2_MSG2[i];
        bad[0] = 0x41; /* 'A' - the asymmetric role, which we never speak */
        check_eq("a non-symmetric side byte is rejected",
                 (unsigned long)(wh_spake2_finish(&a, bad, key_b) == -1), 1);

        bad[0] = 0x53;
        for (i = 0; i < 32; i++) bad[1 + i] = WH_V_ED_INVALID_POINT[i];
        check_eq("a malformed element is rejected",
                 (unsigned long)(wh_spake2_finish(&a, bad, key_b) == -1), 1);

        /* A different code must produce a different key. The protocol never
         * reports this as an error here - it surfaces when the version phase
         * fails to decrypt. */
        {
            wh_spake2 c;
            unsigned char msg_c[WH_SPAKE2_MSG_LEN];
            unsigned char key_c[32];
            wh_spake2_start(&c, "7-wrong-code", WH_V_APPID, WH_V_SPAKE2_X_RNG, msg_c);
            wh_spake2_finish(&c, WH_V_SPAKE2_MSG2, key_c);
            check_eq("a wrong code yields a different key",
                     (unsigned long)(memcmp(key_c, WH_V_SPAKE2_KEY, 32) != 0), 1);
        }
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
