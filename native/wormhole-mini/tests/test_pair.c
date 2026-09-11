/* Pairing: the C side must agree with packages/core/src/pairing.ts to the
 * byte, or a paired phone and laptop derive different codes and never meet.
 *
 * Every literal below is pinned in core's own tests too
 * (src/__tests__/pairing.test.ts), and was cross-checked against a third,
 * independent implementation in Python's hmac/hashlib before being frozen.
 * Change one here and the other two will disagree - which is the point. */
#include <stdio.h>
#include <string.h>

#include "../src/pair.h"
#include "../src/base64.h"

static int failures = 0;
static int checks = 0;

static void check(const char *what, int ok)
{
    checks++;
    if (!ok) failures++;
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
}

/* The secret core's vectors use: bytes 0x00..0x1f. */
static void vector_secret(unsigned char s[WH_PAIR_SECRET_LEN])
{
    int i;
    for (i = 0; i < WH_PAIR_SECRET_LEN; i++) s[i] = (unsigned char)i;
}

static const char VECTOR_PAYLOAD[] =
    "PGPAIR1:eyJ2IjoxLCJuYW1lIjoiTm9raWEgRTcyIMSNxIfFviIsInNlY3JldCI6IkFB"
    "RUNBd1FGQmdjSUNRb0xEQTBPRHhBUkVoTVVGUllYR0JrYUd4d2RIaDgifQ";

/* "Nokia E72 " followed by c-caron, c-acute, z-caron in UTF-8. */
static const char VECTOR_NAME[] = "Nokia E72 \304\215\304\207\305\276";

int main(void)
{
    unsigned char secret[WH_PAIR_SECRET_LEN];
    char code[WH_PAIR_CODE_MAX];
    char buf[WH_PAIR_PAYLOAD_MAX];
    wh_pair_payload p, back;
    long n;

    vector_secret(secret);

    /* base64url */
    n = wh_base64url_encode(secret, WH_PAIR_SECRET_LEN, buf, sizeof(buf));
    check("secret encodes to the pinned base64url",
          n == 43 && strcmp(buf, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8") == 0);
    {
        unsigned char out[40];
        check("and decodes back to 32 bytes",
              wh_base64url_decode(buf, (unsigned long)n, out, sizeof(out)) == 32 &&
              memcmp(out, secret, 32) == 0);
        check("padding is tolerated",
              wh_base64url_decode("AQID==", 6, out, sizeof(out)) == 3 &&
              out[0] == 1 && out[1] == 2 && out[2] == 3);
        check("a character outside the alphabet is refused",
              wh_base64url_decode("AB+C", 4, out, sizeof(out)) == -1);
        check("an impossible length is refused",
              wh_base64url_decode("ABCDE", 5, out, sizeof(out)) == -1);
    }

    /* Code derivation, pinned. */
    wh_pair_derive_code(secret, 5900000UL, code);
    check("bucket 5900000", strcmp(code, "78847104-4b2c920e11-127666f43e") == 0);
    wh_pair_derive_code(secret, 0UL, code);
    check("bucket 0", strcmp(code, "84198084-a64125dc4c-c6ce0273f7") == 0);
    wh_pair_derive_code(secret, 1UL, code);
    check("bucket 1", strcmp(code, "86751495-84d8487eb6-1858ba58a6") == 0);
    wh_pair_derive_code(secret, 42UL, code);
    check("bucket 42", strcmp(code, "93636662-ffcccbd531-9d38f615c1") == 0);
    wh_pair_derive_code(secret, 5866666UL, code);
    check("bucket 5866666", strcmp(code, "10150805-bcac0279fb-c1ae797f75") == 0);

    check("buckets are five minutes, as core's currentBucket",
          wh_pair_bucket(1760000000UL) == 5866666UL &&
          wh_pair_bucket(1760000299UL) == 5866667UL &&
          wh_pair_bucket(1760000100UL) == 5866667UL);

    /* Payload encoding, pinned - including a name that is not ASCII. */
    memcpy(p.secret, secret, WH_PAIR_SECRET_LEN);
    strcpy(p.name, VECTOR_NAME);
    n = wh_pair_encode(&p, buf, sizeof(buf));
    check("payload encodes exactly as core does", n > 0 && strcmp(buf, VECTOR_PAYLOAD) == 0);

    memset(&back, 0, sizeof(back));
    check("core's payload decodes",
          wh_pair_decode(VECTOR_PAYLOAD, strlen(VECTOR_PAYLOAD), &back) == 0);
    check("  to the same name, UTF-8 intact", strcmp(back.name, VECTOR_NAME) == 0);
    check("  and the same secret", memcmp(back.secret, secret, 32) == 0);

    {
        char padded[WH_PAIR_PAYLOAD_MAX + 8];
        sprintf(padded, "  %s\r\n", VECTOR_PAYLOAD);
        check("surrounding whitespace is tolerated",
              wh_pair_decode(padded, strlen(padded), &back) == 0);
    }

    /* What parsePairingPayload rejects, this rejects. */
    check("not a payload", wh_pair_decode("hello", 5, &back) == -1);
    check("wrong prefix", wh_pair_decode("PGPAIR2:abcd", 12, &back) == -1);
    check("a typed wormhole code is not a payload",
          wh_pair_decode("7-crossover-clockwork", 21, &back) == -1);
    {
        /* {"v":1,"name":"x","secret":"dG9vc2hvcnQ"} - a nine-byte secret. */
        static const char SHORT[] =
            "PGPAIR1:eyJ2IjoxLCJuYW1lIjoieCIsInNlY3JldCI6ImRHOXZjMmh2Y25RIn0";
        check("a short secret is refused", wh_pair_decode(SHORT, strlen(SHORT), &back) == -1);
    }
    {
        /* {"v":2,...} */
        static const char V2[] =
            "PGPAIR1:eyJ2IjoyLCJuYW1lIjoieCIsInNlY3JldCI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHhBUkVoTVVGUllYR0JrYUd4d2RIaDgifQ";
        check("another version is refused", wh_pair_decode(V2, strlen(V2), &back) == -1);
    }

    /* A payload that went through the text-message path arrives as exactly
     * the string that was sent, so a round trip here is the whole contract. */
    strcpy(p.name, "E72 \"quoted\" \\ back");
    n = wh_pair_encode(&p, buf, sizeof(buf));
    check("names with quotes and backslashes round-trip",
          n > 0 && wh_pair_decode(buf, (unsigned long)n, &back) == 0 &&
          strcmp(back.name, p.name) == 0);

    /* Handshake: what the joining device sends back over the derived code. */
    n = wh_pair_handshake_encode("Nokia E72", buf, sizeof(buf));
    check("handshake matches JSON.stringify({v:1,name})",
          n > 0 && strcmp(buf, "{\"v\":1,\"name\":\"Nokia E72\"}") == 0);
    {
        char name[WH_PAIR_NAME_MAX];
        static const char FROM_CORE[] = "{\"v\":1,\"name\":\"xollow\"}";
        check("core's handshake decodes",
              wh_pair_handshake_decode(FROM_CORE, strlen(FROM_CORE), name, sizeof(name)) == 0 &&
              strcmp(name, "xollow") == 0);
        check("a handshake of another version is refused",
              wh_pair_handshake_decode("{\"v\":2,\"name\":\"x\"}", 19, name, sizeof(name)) == -1);
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
