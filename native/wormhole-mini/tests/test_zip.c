/* The zip reader, against archives produced by Python's zipfile. */
#include <stdio.h>
#include <string.h>

#include "../src/zip.h"
#include "../src/crc32.h"
#include "vectors/zip_vectors.h"

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

/* The archive lives in memory here; on the phone it is a staged file. */
typedef struct {
    const unsigned char *data;
    unsigned long size;
} TBlob;

static long blob_read(void *ctx, unsigned long offset, unsigned char *buf,
                      unsigned long len)
{
    TBlob *b = (TBlob *)ctx;
    if (offset > b->size) return -1;
    if (len > b->size - offset) len = b->size - offset;
    memcpy(buf, b->data + offset, (size_t)len);
    return (long)len;
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

static wh_inflate_state g_inflate;

int main(void)
{
    int ci;

    /* Name safety, which is the difference between unpacking a folder and
     * writing wherever the sender fancies. */
    {
        static const char *const unsafe[] = {
            "../escape", "a/../../escape", "/absolute", "C:\\windows\\x",
            "a\\b", "..", ".", "a/./b", "a/../b", "", "a/..",
            "sub/../../out"
        };
        static const char *const safe[] = {
            "notes.txt", "photos/one.jpg", "a/b/c/d/deep.txt", "empty/",
            "a..b/c", "...hidden", "file..txt"
        };
        int i, ok = 1;
        for (i = 0; i < (int)(sizeof(unsafe) / sizeof(unsafe[0])); i++) {
            if (wh_zip_name_is_safe(unsafe[i])) {
                printf("  accepted an unsafe name: [%s]\n", unsafe[i]);
                ok = 0;
            }
        }
        check("unsafe entry names are refused", ok);

        ok = 1;
        for (i = 0; i < (int)(sizeof(safe) / sizeof(safe[0])); i++) {
            if (!wh_zip_name_is_safe(safe[i])) {
                printf("  rejected a safe name: [%s]\n", safe[i]);
                ok = 0;
            }
        }
        check("ordinary entry names are accepted", ok);
    }

    for (ci = 0; ci < (int)(sizeof(WH_ZV_CASES) / sizeof(WH_ZV_CASES[0])); ci++) {
        const wh_zv_case *c = &WH_ZV_CASES[ci];
        TBlob blob;
        wh_zip zip;
        wh_zip_iter it;
        wh_zip_entry entry;
        char what[128];
        int rc, seen = 0, ok = 1;

        blob.data = c->data;
        blob.size = c->size;

        rc = wh_zip_open(&zip, blob_read, &blob, c->size);
        sprintf(what, "%s: opens", c->name);
        check(what, rc == WH_ZIP_OK);
        if (rc != WH_ZIP_OK) continue;

        sprintf(what, "%s: entry count", c->name);
        check(what, (int)zip.entries == c->count);

        rc = wh_zip_first(&zip, &it, &entry);
        while (rc == WH_ZIP_OK) {
            const wh_zv_entry *want = &c->entries[seen];
            TCount got;

            if (seen >= c->count) { ok = 0; break; }
            if (strcmp(entry.name, want->name) != 0) {
                printf("  entry %d: name [%s], expected [%s]\n",
                       seen, entry.name, want->name);
                ok = 0;
            }
            if (entry.is_dir != want->is_dir) {
                printf("  entry %d (%s): is_dir %d, expected %d\n",
                       seen, entry.name, entry.is_dir, want->is_dir);
                ok = 0;
            }

            got.len = 0;
            got.crc = 0;
            if (wh_zip_extract(&zip, &entry, &g_inflate, count_sink, &got) != WH_ZIP_OK) {
                printf("  entry %d (%s): extract failed\n", seen, entry.name);
                ok = 0;
            } else if (got.len != want->size || got.crc != want->crc) {
                printf("  entry %d (%s): %lu bytes crc %08lx, expected %lu / %08lx\n",
                       seen, entry.name, got.len, got.crc, want->size, want->crc);
                ok = 0;
            }

            seen++;
            rc = wh_zip_next(&zip, &it, &entry);
        }

        sprintf(what, "%s: iteration ends cleanly", c->name);
        check(what, rc == 1);
        sprintf(what, "%s: all %d entries extract with matching CRC", c->name, c->count);
        check(what, ok && seen == c->count);
    }

    /* A truncated archive must be refused, not half-read. */
    {
        TBlob blob;
        wh_zip zip;
        blob.data = WH_ZV_CASES[0].data;
        blob.size = WH_ZV_CASES[0].size / 2;
        check("a truncated archive is refused",
              wh_zip_open(&zip, blob_read, &blob, blob.size) != WH_ZIP_OK);
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
