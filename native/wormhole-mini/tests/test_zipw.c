/* The zip writer: round-tripped through our own reader, and written to
 * build/written.zip so tools/checkzip.py can confirm a real zip library
 * agrees. Reading back what we wrote proves self-consistency; only an
 * outside reader proves we understood the format. */
#include <stdio.h>
#include <string.h>

#include "../src/zipw.h"
#include "../src/zip.h"
#include "../src/crc32.h"

static int failures = 0;
static int checks = 0;

static void check(const char *what, int ok)
{
    checks++;
    if (!ok) {
        printf("FAIL %s\n", what);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

#define ARCHIVE_MAX (1024UL * 1024UL)
static unsigned char g_archive[ARCHIVE_MAX];
static unsigned long g_archive_len;
static unsigned char g_cd[64UL * 1024UL];
static wh_inflate_state g_inflate;

static int collect(void *ctx, const unsigned char *buf, unsigned long len)
{
    (void)ctx;
    if (g_archive_len + len > ARCHIVE_MAX) return -1;
    memcpy(g_archive + g_archive_len, buf, (size_t)len);
    g_archive_len += len;
    return 0;
}

static long archive_read(void *ctx, unsigned long offset, unsigned char *buf,
                         unsigned long len)
{
    (void)ctx;
    if (offset > g_archive_len) return -1;
    if (len > g_archive_len - offset) len = g_archive_len - offset;
    memcpy(buf, g_archive + offset, (size_t)len);
    return (long)len;
}

/* The same deterministic contents tools/checkzip.py rebuilds. */
static unsigned char g_big[100000];

static void fill_big(void)
{
    unsigned long i;
    for (i = 0; i < sizeof(g_big); i++) g_big[i] = (unsigned char)((i * 7 + 11) & 0xff);
}

typedef struct {
    unsigned long len;
    unsigned long crc;
} TCount;

static int count_sink(void *ctx, const unsigned char *buf, unsigned long len)
{
    TCount *c = (TCount *)ctx;
    c->crc = wh_crc32(c->crc, buf, len);
    c->len += len;
    return 0;
}

int main(void)
{
    wh_zipw w;
    wh_zip zip;
    wh_zip_iter it;
    wh_zip_entry entry;
    int rc, seen = 0;

    static const char *const KNames[] = {
        "notes.txt", "photos/one.bin", "empty/", "big.bin", "a/b/c/deep.txt"
    };
    static const unsigned long KSizes[] = { 12, 300, 0, 100000, 4 };

    fill_big();
    g_archive_len = 0;
    wh_zipw_init(&w, collect, 0, g_cd, sizeof(g_cd));

    check("begin notes.txt", wh_zipw_begin_file(&w, "notes.txt") == WH_ZIPW_OK);
    check("write notes.txt",
          wh_zipw_write(&w, (const unsigned char *)"a short note", 12) == WH_ZIPW_OK);
    check("end notes.txt", wh_zipw_end_file(&w) == WH_ZIPW_OK);

    {
        unsigned char pattern[300];
        unsigned long i;
        for (i = 0; i < sizeof(pattern); i++) pattern[i] = (unsigned char)(i & 0xff);
        check("begin photos/one.bin",
              wh_zipw_begin_file(&w, "photos/one.bin") == WH_ZIPW_OK);
        /* Written in two pieces, because a real file arrives in blocks. */
        wh_zipw_write(&w, pattern, 100);
        wh_zipw_write(&w, pattern + 100, 200);
        check("end photos/one.bin", wh_zipw_end_file(&w) == WH_ZIPW_OK);
    }

    check("empty directory", wh_zipw_add_dir(&w, "empty/") == WH_ZIPW_OK);

    check("begin big.bin", wh_zipw_begin_file(&w, "big.bin") == WH_ZIPW_OK);
    {
        unsigned long off = 0;
        while (off < sizeof(g_big)) {
            unsigned long n = sizeof(g_big) - off;
            if (n > 4096) n = 4096;
            wh_zipw_write(&w, g_big + off, n);
            off += n;
        }
    }
    check("end big.bin", wh_zipw_end_file(&w) == WH_ZIPW_OK);

    check("begin a/b/c/deep.txt",
          wh_zipw_begin_file(&w, "a/b/c/deep.txt") == WH_ZIPW_OK);
    wh_zipw_write(&w, (const unsigned char *)"deep", 4);
    check("end a/b/c/deep.txt", wh_zipw_end_file(&w) == WH_ZIPW_OK);

    check("finish", wh_zipw_finish(&w) == WH_ZIPW_OK);
    check("archive is not empty", g_archive_len > 0);

    /* Calls out of order must be refused rather than producing nonsense. */
    {
        wh_zipw bad;
        wh_zipw_init(&bad, collect, 0, g_cd, sizeof(g_cd));
        check("write without begin is refused",
              wh_zipw_write(&bad, (const unsigned char *)"x", 1) == WH_ZIPW_ESTATE);
        check("end without begin is refused",
              wh_zipw_end_file(&bad) == WH_ZIPW_ESTATE);
    }

    /* Read it back with our own reader. */
    rc = wh_zip_open(&zip, archive_read, 0, g_archive_len);
    check("our reader opens what our writer produced", rc == WH_ZIP_OK);
    check("entry count", (int)zip.entries == 5);

    rc = wh_zip_first(&zip, &it, &entry);
    while (rc == WH_ZIP_OK && seen < 5) {
        TCount got;
        char what[400];

        sprintf(what, "entry %d is %s", seen, KNames[seen]);
        check(what, strcmp(entry.name, KNames[seen]) == 0);

        got.len = 0;
        got.crc = 0;
        sprintf(what, "%s extracts", entry.name);
        check(what, wh_zip_extract(&zip, &entry, &g_inflate, count_sink, &got)
                        == WH_ZIP_OK);
        sprintf(what, "%s is %lu bytes", entry.name, KSizes[seen]);
        check(what, got.len == KSizes[seen]);

        seen++;
        rc = wh_zip_next(&zip, &it, &entry);
    }
    check("all five entries seen", seen == 5);

    /* Hand it to a real zip library. */
    {
        FILE *f = fopen("build/written.zip", "wb");
        if (f) {
            fwrite(g_archive, 1, (size_t)g_archive_len, f);
            fclose(f);
            printf("\nwrote build/written.zip (%lu bytes) for tools/checkzip.py\n",
                   g_archive_len);
        } else {
            printf("\ncould not write build/written.zip\n");
            failures++;
        }
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
