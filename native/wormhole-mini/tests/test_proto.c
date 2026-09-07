/* Offline tests for the framing and encoding layers: base64, SHA-1, the
 * WebSocket accept-key computation, and the JSON reader/writer.
 *
 * These need no network. The live check against a real mailbox server is
 * cli/wh-mini. */
#include <stdio.h>
#include <string.h>

#include "../src/base64.h"
#include "../src/sha1.h"
#include "../src/json.h"
#include "../src/wordlist.h"

static int failures = 0;
static int checks = 0;

static void check_str(const char *what, const char *got, const char *expect)
{
    checks++;
    if (strcmp(got, expect) != 0) {
        printf("FAIL %s\n  got      %s\n  expected %s\n", what, got, expect);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void check_true(const char *what, int cond)
{
    checks++;
    if (!cond) {
        printf("FAIL %s\n", what);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void hexstr(const unsigned char *in, unsigned long n, char *out)
{
    static const char d[] = "0123456789abcdef";
    unsigned long i;
    for (i = 0; i < n; i++) {
        out[i * 2] = d[(in[i] >> 4) & 0xf];
        out[i * 2 + 1] = d[in[i] & 0xf];
    }
    out[n * 2] = '\0';
}

int main(void)
{
    char buf[512];

    /* --- base64, RFC 4648 test vectors -------------------------------- */
    wh_base64_encode((const unsigned char *)"", 0, buf, sizeof(buf));
    check_str("base64(\"\")", buf, "");
    wh_base64_encode((const unsigned char *)"f", 1, buf, sizeof(buf));
    check_str("base64(\"f\")", buf, "Zg==");
    wh_base64_encode((const unsigned char *)"fo", 2, buf, sizeof(buf));
    check_str("base64(\"fo\")", buf, "Zm8=");
    wh_base64_encode((const unsigned char *)"foo", 3, buf, sizeof(buf));
    check_str("base64(\"foo\")", buf, "Zm9v");
    wh_base64_encode((const unsigned char *)"foob", 4, buf, sizeof(buf));
    check_str("base64(\"foob\")", buf, "Zm9vYg==");
    wh_base64_encode((const unsigned char *)"fooba", 5, buf, sizeof(buf));
    check_str("base64(\"fooba\")", buf, "Zm9vYmE=");
    wh_base64_encode((const unsigned char *)"foobar", 6, buf, sizeof(buf));
    check_str("base64(\"foobar\")", buf, "Zm9vYmFy");
    check_true("base64 refuses a short buffer",
               wh_base64_encode((const unsigned char *)"foobar", 6, buf, 4) == -1);

    /* --- SHA-1 -------------------------------------------------------- */
    {
        unsigned char d[WH_SHA1_LEN];
        char hex[64];
        char longmsg[1000];
        int i;

        wh_sha1((const unsigned char *)"abc", 3, d);
        hexstr(d, WH_SHA1_LEN, hex);
        check_str("sha1(\"abc\")", hex, "a9993e364706816aba3e25717850c26c9cd0d89d");

        wh_sha1((const unsigned char *)"", 0, d);
        hexstr(d, WH_SHA1_LEN, hex);
        check_str("sha1(\"\")", hex, "da39a3ee5e6b4b0d3255bfef95601890afd80709");

        wh_sha1((const unsigned char *)
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 56, d);
        hexstr(d, WH_SHA1_LEN, hex);
        check_str("sha1(two-block message)", hex,
                  "84983e441c3bd26ebaae4aa1f95129e5e54670f1");

        /* Exercises the extra-block padding path (length % 64 >= 56). */
        for (i = 0; i < 1000; i++) longmsg[i] = 'a';
        wh_sha1((const unsigned char *)longmsg, 1000, d);
        hexstr(d, WH_SHA1_LEN, hex);
        check_str("sha1(1000 x 'a')", hex,
                  "291e9a6c66994949b57ba5e650361e98fc36b1ba");
    }

    /* --- the RFC 6455 handshake example ------------------------------- */
    {
        static const char key[] = "dGhlIHNhbXBsZSBub25jZQ==";
        static const char guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        unsigned char src[128];
        unsigned char d[WH_SHA1_LEN];
        unsigned long kl = strlen(key), gl = strlen(guid);

        memcpy(src, key, kl);
        memcpy(src + kl, guid, gl);
        wh_sha1(src, kl + gl, d);
        wh_base64_encode(d, WH_SHA1_LEN, buf, sizeof(buf));
        check_str("RFC 6455 Sec-WebSocket-Accept", buf, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    /* --- JSON reader -------------------------------------------------- */
    {
        static const char doc[] =
            "{\"type\": \"message\", \"side\": \"3f0ab1c2d9\", \"phase\": \"pake\","
            " \"body\": \"7b22\", \"server_tx\": 1234, \"nested\": {\"a\": [1, 2,"
            " {\"type\": \"decoy\"}], \"b\": \"}\"}, \"last\": \"tail\"}";
        wh_json_val v;
        char s[64];

        check_true("find type", wh_json_get(doc, strlen(doc), "type", &v) == 0);
        check_true("type is a string", v.type == WH_JSON_STRING);
        check_true("type == message", wh_json_streq(&v, "message"));
        check_true("type != messag", !wh_json_streq(&v, "messag"));
        check_true("type != messages", !wh_json_streq(&v, "messages"));

        check_true("find phase", wh_json_get(doc, strlen(doc), "phase", &v) == 0);
        wh_json_str(&v, s, sizeof(s));
        check_str("phase value", s, "pake");

        check_true("find number", wh_json_get(doc, strlen(doc), "server_tx", &v) == 0);
        {
            unsigned long n = 0;
            check_true("number parses", wh_json_u32(&v, &n) == 0);
            check_true("number value", n == 1234);
        }

        /* Sizes come off the network, so a value too large for a 32-bit
         * build must be rejected on every build rather than wrapping. */
        {
            static const char big[] = "{\"filesize\": 4294967295}";
            static const char over[] = "{\"filesize\": 4294967296}";
            static const char huge[] = "{\"filesize\": 99999999999999999999}";
            unsigned long n = 0;
            check_true("4294967295 is accepted",
                       wh_json_get(big, strlen(big), "filesize", &v) == 0 &&
                       wh_json_u32(&v, &n) == 0 && n == 4294967295UL);
            check_true("4294967296 is rejected",
                       wh_json_get(over, strlen(over), "filesize", &v) == 0 &&
                       wh_json_u32(&v, &n) == -1);
            check_true("an absurd size is rejected",
                       wh_json_get(huge, strlen(huge), "filesize", &v) == 0 &&
                       wh_json_u32(&v, &n) == -1);
        }

        /* The decoy "type" inside the nested object must not be found, and a
         * brace inside a nested string must not end the skip early. */
        check_true("find last after nesting",
                   wh_json_get(doc, strlen(doc), "last", &v) == 0);
        check_true("last == tail", wh_json_streq(&v, "tail"));
        check_true("nested key is not visible at top level",
                   wh_json_get(doc, strlen(doc), "a", &v) == -1);
        check_true("absent key reports absent",
                   wh_json_get(doc, strlen(doc), "nope", &v) == -1);
    }

    /* --- JSON string decoding ----------------------------------------- */
    {
        static const char doc[] = "{\"m\": \"a\\\"b\\\\c\\nd\\u0041\\u00e9\"}";
        wh_json_val v;
        char s[64];
        check_true("find escaped string", wh_json_get(doc, strlen(doc), "m", &v) == 0);
        check_true("decodes", wh_json_str(&v, s, sizeof(s)) > 0);
        check_str("escapes decoded", s, "a\"b\\c\ndA\xc3\xa9");
        check_true("short buffer is refused", wh_json_str(&v, s, 3) == -1);
    }

    /* --- JSON arrays, which is how transit hints arrive ---------------- */
    {
        static const char doc[] =
            "{\"hints-v1\": ["
            "{\"type\": \"direct-tcp-v1\", \"hostname\": \"192.168.1.79\", \"port\": 45871},"
            "{\"type\": \"relay-v1\", \"name\": null, \"hints\": ["
            "{\"type\": \"direct-tcp-v1\", \"hostname\": \"relay.example\", \"port\": 4001}]},"
            "{\"type\": \"unknown-future-thing\"}"
            "], \"after\": 7}";
        wh_json_val arr, el, f;
        wh_json_iter it;
        int n = 0, rc;
        char host[64];
        unsigned long port = 0;
        int saw_direct = 0, saw_relay = 0, saw_unknown = 0;

        check_true("find the hints array",
                   wh_json_get(doc, strlen(doc), "hints-v1", &arr) == 0);
        check_true("it is an array", arr.type == WH_JSON_ARRAY);

        rc = wh_json_array_first(&arr, &it, &el);
        while (rc == 0) {
            n++;
            if (wh_json_get(el.p, el.len, "type", &f) == 0) {
                if (wh_json_streq(&f, "direct-tcp-v1")) {
                    saw_direct++;
                    if (wh_json_get(el.p, el.len, "hostname", &f) == 0)
                        wh_json_str(&f, host, sizeof(host));
                    if (wh_json_get(el.p, el.len, "port", &f) == 0)
                        wh_json_u32(&f, &port);
                } else if (wh_json_streq(&f, "relay-v1")) {
                    saw_relay++;
                } else {
                    saw_unknown++;
                }
            }
            rc = wh_json_array_next(&arr, &it, &el);
        }
        check_true("iteration ends cleanly", rc == 1);
        check_true("three elements seen", n == 3);
        check_true("one direct hint", saw_direct == 1);
        check_true("one relay hint", saw_relay == 1);
        check_true("an unknown hint type is tolerated", saw_unknown == 1);
        check_str("direct hint hostname", host, "192.168.1.79");
        check_true("direct hint port", port == 45871);

        /* A nested array must not confuse the outer walk. */
        check_true("key after the array is still reachable",
                   wh_json_get(doc, strlen(doc), "after", &f) == 0);

        /* Degenerate arrays. */
        {
            static const char empty[] = "{\"a\": []}";
            wh_json_val a2, e2;
            wh_json_iter i2;
            check_true("empty array is found",
                       wh_json_get(empty, strlen(empty), "a", &a2) == 0);
            check_true("empty array yields nothing",
                       wh_json_array_first(&a2, &i2, &e2) == 1);
        }
    }

    /* --- JSON writer -------------------------------------------------- */
    {
        wh_jw w;
        wh_jw_init(&w, buf, sizeof(buf));
        wh_jw_obj_open(&w);
        wh_jw_str(&w, "type", "bind");
        wh_jw_str(&w, "appid", "lothar.com/wormhole/text-or-file-xfer");
        wh_jw_str(&w, "side", "3f0ab1c2d9");
        wh_jw_obj_close(&w);
        check_true("writer succeeds", wh_jw_done(&w) == 0);
        check_str("bind message", buf,
                  "{\"type\":\"bind\",\"appid\":"
                  "\"lothar.com/wormhole/text-or-file-xfer\",\"side\":\"3f0ab1c2d9\"}");

        wh_jw_init(&w, buf, sizeof(buf));
        wh_jw_obj_open(&w);
        wh_jw_str(&w, "type", "add");
        wh_jw_str(&w, "phase", "pake");
        wh_jw_u32(&w, "n", 0);
        wh_jw_obj_close(&w);
        check_true("writer with zero succeeds", wh_jw_done(&w) == 0);
        check_str("zero is written", buf,
                  "{\"type\":\"add\",\"phase\":\"pake\",\"n\":0}");

        /* Overflow must be reported, not silently truncated. */
        wh_jw_init(&w, buf, 8);
        wh_jw_obj_open(&w);
        wh_jw_str(&w, "type", "something far too long for the buffer");
        wh_jw_obj_close(&w);
        check_true("overflow is reported", wh_jw_done(&w) == -1);

        /* A quote in a value must be escaped. */
        wh_jw_init(&w, buf, sizeof(buf));
        wh_jw_obj_open(&w);
        wh_jw_str(&w, "k", "a\"b");
        wh_jw_obj_close(&w);
        check_true("escaping writer succeeds", wh_jw_done(&w) == 0);
        check_str("quote escaped", buf, "{\"k\":\"a\\\"b\"}");
    }

    /* --- wormhole codes ------------------------------------------------ */
    {
        int trial;
        int all_ok = 1;
        int format_ok = 1;

        /* The word lists must be the engine's, in the engine's order: a
         * two-word code takes its first word from the even list and its
         * second from the odd list. "crossover-clockwork" is even-odd. */
        check_str("even list starts at adroitness", wh_even_words[0], "adroitness");
        check_str("odd list starts at aardvark", wh_odd_words[0], "aardvark");
        check_true("even list is full", wh_even_words[255] != 0 &&
                                        wh_even_words[255][0] != '\0');
        check_true("odd list is full", wh_odd_words[255] != 0 &&
                                       wh_odd_words[255][0] != '\0');

        for (trial = 0; trial < 200; trial++) {
            char code[WH_CODE_MAX];
            char *first, *second;
            int i, found_even = 0, found_odd = 0;

            if (wh_make_code("42", code, sizeof(code)) != 0) { all_ok = 0; break; }

            if (code[0] != '4' || code[1] != '2' || code[2] != '-') format_ok = 0;
            first = strchr(code, '-');
            if (!first) { format_ok = 0; break; }
            second = strchr(first + 1, '-');
            if (!second) { format_ok = 0; break; }
            *first = '\0';
            *second = '\0';

            for (i = 0; i < WH_WORDLIST_SIZE; i++) {
                if (strcmp(first + 1, wh_even_words[i]) == 0) found_even = 1;
                if (strcmp(second + 1, wh_odd_words[i]) == 0) found_odd = 1;
            }
            if (!found_even || !found_odd) { all_ok = 0; break; }
        }
        check_true("generated codes are nameplate-even-odd", format_ok);
        check_true("both words come from the right lists", all_ok);

        /* A code must never be silently truncated into a wrong one. */
        {
            char tiny[8];
            check_true("a short buffer is refused",
                       wh_make_code("42", tiny, sizeof(tiny)) == -1);
        }
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
