/* Offline tests for multi-file bundles: reading the loose marker out of a
 * directory offer, the names that keep two same-named arrivals apart, and
 * the phrase that says what a bundle holds.
 *
 * The marked offer below is the exact string native/magic-wormhole pins in
 * test_offer_directory_loose. Two implementations reading one literal is the
 * point: if either side changes the wire format, one of the two tests says
 * so. See docs/MULTI-FILE-DESIGN.md. */
#include <stdio.h>
#include <string.h>

#include "../src/xfer.h"

static int failures = 0;
static int checks = 0;

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

/* wh_offer is large (direct hints, two 256-byte names); keep it off the
 * stack as the phone has to. */
static wh_offer g_offer;

static int parse(const char *msg)
{
    memset(&g_offer, 0, sizeof(g_offer));
    return wh_xfer_parse_offer(msg, (unsigned long)strlen(msg), &g_offer);
}

/* A directory offer with `ext` spliced in after the standard members. */
static int parse_dir(const char *ext)
{
    static char msg[1024];
    sprintf(msg,
            "{\"offer\":{\"directory\":{\"dirname\":\"d\","
            "\"mode\":\"zipfile/deflated\",\"zipsize\":45,"
            "\"numbytes\":1234,\"numfiles\":23%s}}}",
            ext);
    return parse(msg);
}

static void check_loose(const char *what, const char *ext, int loose,
                        unsigned long files, unsigned long folders)
{
    int rc = parse_dir(ext);
    checks++;
    if (rc != 0 || !g_offer.is_directory || g_offer.is_loose != loose ||
        g_offer.loose_files != files || g_offer.loose_folders != folders ||
        g_offer.num_files != 23 || g_offer.filesize != 45 ||
        g_offer.num_bytes != 1234 || strcmp(g_offer.dirname, "d") != 0) {
        printf("FAIL %s\n  rc %d dir %d loose %d files %lu folders %lu\n", what, rc,
               g_offer.is_directory, g_offer.is_loose, g_offer.loose_files,
               g_offer.loose_folders);
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void check_name(const char *name, int is_dir, unsigned long n,
                       const char *expect)
{
    char out[300];
    char what[400];
    int rc = wh_numbered_name(name, is_dir, n, out, sizeof(out));
    sprintf(what, "%s \"%s\" #%lu", is_dir ? "folder" : "file", name, n);
    check_true(what, rc == 0);
    check_str(what, out, expect);
}

static void check_items(unsigned long files, unsigned long folders,
                        const char *expect)
{
    char out[64];
    char what[64];
    sprintf(what, "items %lu/%lu", files, folders);
    check_true(what, wh_items_text(files, folders, out, sizeof(out)) == 0);
    check_str(what, out, expect);
}

int main(void)
{
    /* --- the marked offer, byte for byte as wormhole-core sends it ------ */
    {
        static const char WIRE[] =
            "{\"offer\":{\"directory\":{\"dirname\":\"7 files and 2 folders\","
            "\"mode\":\"zipfile/deflated\",\"numbytes\":1234,\"numfiles\":23,"
            "\"portalgems\":{\"files\":7,\"folders\":2,\"loose\":true},"
            "\"zipsize\":45}}}";
        check_true("pinned loose offer parses", parse(WIRE) == 0);
        check_true("  is a directory offer", g_offer.is_directory == 1);
        check_true("  is loose", g_offer.is_loose == 1);
        check_true("  7 files at the top", g_offer.loose_files == 7);
        check_true("  2 folders at the top", g_offer.loose_folders == 2);
        check_true("  numfiles still counts every file", g_offer.num_files == 23);
        check_true("  numbytes", g_offer.num_bytes == 1234);
        check_true("  zipsize is the transfer size", g_offer.filesize == 45);
        check_str("  fallback name is kept", g_offer.dirname, "7 files and 2 folders");
    }

    /* --- loose, with usable counts ------------------------------------- */
    check_loose("loose with both counts",
                ",\"portalgems\":{\"loose\":true,\"files\":7,\"folders\":2}", 1, 7, 2);
    check_loose("loose, files only",
                ",\"portalgems\":{\"loose\":true,\"files\":5,\"folders\":0}", 1, 5, 0);
    check_loose("loose, folders only",
                ",\"portalgems\":{\"loose\":true,\"files\":0,\"folders\":3}", 1, 0, 3);
    check_loose("loose, members in another order",
                ",\"portalgems\":{\"folders\":2,\"files\":7,\"loose\":true}", 1, 7, 2);
    check_loose("loose, with members from a later version",
                ",\"portalgems\":{\"loose\":true,\"files\":7,\"folders\":2,"
                "\"names\":[\"a\",\"b\"],\"more\":{\"x\":1}}", 1, 7, 2);
    check_loose("loose, with whitespace",
                ", \"portalgems\" : { \"loose\" : true , \"files\" : 7 , \"folders\" : 2 }",
                1, 7, 2);

    /* --- loose, counts missing or unusable: numfiles stands in ---------- */
    check_loose("loose without counts", ",\"portalgems\":{\"loose\":true}", 1, 23, 0);
    check_loose("loose with files only claimed",
                ",\"portalgems\":{\"loose\":true,\"files\":7}", 1, 23, 0);
    check_loose("loose with folders only claimed",
                ",\"portalgems\":{\"loose\":true,\"folders\":2}", 1, 23, 0);
    check_loose("loose with a string count",
                ",\"portalgems\":{\"loose\":true,\"files\":\"7\",\"folders\":2}", 1, 23, 0);
    check_loose("loose with a negative count",
                ",\"portalgems\":{\"loose\":true,\"files\":-1,\"folders\":2}", 1, 23, 0);
    check_loose("loose with a fractional count",
                ",\"portalgems\":{\"loose\":true,\"files\":7.5,\"folders\":2}", 1, 23, 0);
    check_loose("loose with null counts",
                ",\"portalgems\":{\"loose\":true,\"files\":null,\"folders\":null}", 1, 23, 0);
    check_loose("loose with a count past 32 bits",
                ",\"portalgems\":{\"loose\":true,\"files\":4294967296,\"folders\":2}",
                1, 23, 0);

    /* --- not loose ------------------------------------------------------ */
    check_loose("no extension at all", "", 0, 0, 0);
    check_loose("loose is false",
                ",\"portalgems\":{\"loose\":false,\"files\":7,\"folders\":2}", 0, 0, 0);
    check_loose("counts without loose",
                ",\"portalgems\":{\"files\":7,\"folders\":2}", 0, 0, 0);
    check_loose("empty extension", ",\"portalgems\":{}", 0, 0, 0);
    check_loose("loose is a string", ",\"portalgems\":{\"loose\":\"true\"}", 0, 0, 0);
    check_loose("loose is a number", ",\"portalgems\":{\"loose\":1}", 0, 0, 0);
    check_loose("loose is null", ",\"portalgems\":{\"loose\":null}", 0, 0, 0);
    check_loose("extension is true", ",\"portalgems\":true", 0, 0, 0);
    check_loose("extension is a string", ",\"portalgems\":\"loose\"", 0, 0, 0);
    check_loose("extension is null", ",\"portalgems\":null", 0, 0, 0);
    check_loose("extension is an array", ",\"portalgems\":[true]", 0, 0, 0);
    check_loose("somebody else's extension",
                ",\"somebody_elses\":{\"loose\":true}", 0, 0, 0);
    /* A truncated literal must not read as true. */
    check_loose("loose is tru", ",\"portalgems\":{\"loose\":tru}", 0, 0, 0);
    check_loose("loose is truex", ",\"portalgems\":{\"loose\":truex}", 0, 0, 0);

    /* --- the other offers are what they were ---------------------------- */
    {
        check_true("file offer parses",
                   parse("{\"offer\":{\"file\":{\"filename\":\"a.jpg\",\"filesize\":34556}}}") == 0);
        check_true("  not a directory", g_offer.is_directory == 0);
        check_true("  not loose", g_offer.is_loose == 0);
        check_str("  filename", g_offer.filename, "a.jpg");
        check_true("  filesize", g_offer.filesize == 34556);

        /* A file offer cannot be made loose by decorating it. */
        check_true("file offer with a marker parses",
                   parse("{\"offer\":{\"file\":{\"filename\":\"a.jpg\",\"filesize\":1,"
                         "\"portalgems\":{\"loose\":true}}}}") == 0);
        check_true("  and is not loose", g_offer.is_loose == 0);

        check_true("an unknown offer is refused",
                   parse("{\"offer\":{\"hologram\":{}}}") == -1);
        check_true("a directory offer without a zipsize is refused",
                   parse("{\"offer\":{\"directory\":{\"dirname\":\"d\","
                         "\"portalgems\":{\"loose\":true}}}}") == -1);
        check_true("a message that is not an offer is refused",
                   parse("{\"transit\":{}}") == -1);

        /* State from a previous offer does not leak into the next. */
        parse_dir(",\"portalgems\":{\"loose\":true,\"files\":7,\"folders\":2}");
        {
            /* Parsed into the same struct, with no reset in between. */
            static const char PLAIN[] =
                "{\"offer\":{\"directory\":{\"dirname\":\"d\","
                "\"mode\":\"zipfile/deflated\","
                "\"zipsize\":1,\"numbytes\":1,\"numfiles\":1}}}";
            check_true("a plain folder parses after a bundle",
                       wh_xfer_parse_offer(PLAIN, sizeof(PLAIN) - 1, &g_offer) == 0);
        }
        check_true("a plain folder after a bundle is not loose",
                   g_offer.is_loose == 0 && g_offer.loose_files == 0 &&
                   g_offer.loose_folders == 0);
    }

    /* --- names that keep arrivals apart --------------------------------- */
    /* The same shapes as create_unique / unique_entry_name in wormhole-core
     * and dedupPath on the desktop. */
    check_name("a.txt", 0, 0, "a.txt");
    check_name("a.txt", 0, 1, "a (1).txt");
    check_name("a.txt", 0, 2, "a (2).txt");
    check_name("a.txt", 0, 12, "a (12).txt");
    check_name("a.txt", 0, 1000, "a (1000).txt");
    check_name("noext", 0, 0, "noext");
    check_name("noext", 0, 1, "noext (1)");
    check_name(".hidden", 0, 1, ".hidden (1)");
    check_name("b.tar.gz", 0, 1, "b.tar (1).gz");
    check_name("a (1).txt", 0, 1, "a (1) (1).txt");
    check_name("trailing.", 0, 1, "trailing (1).");
    check_name("with space.jpg", 0, 3, "with space (3).jpg");
    /* A folder's dots are part of its name. */
    check_name("photos", 1, 0, "photos");
    check_name("photos", 1, 1, "photos (1)");
    check_name("my.stuff", 1, 1, "my.stuff (1)");
    check_name("my.stuff", 1, 0, "my.stuff");
    {
        char small[8];
        check_true("a name that does not fit is refused",
                   wh_numbered_name("abcdefgh.txt", 0, 1, small, sizeof(small)) == -1);
        check_true("an exact fit is accepted",
                   wh_numbered_name("a.txt", 0, 0, small, 6) == 0);
        check_true("one byte short is refused",
                   wh_numbered_name("a.txt", 0, 0, small, 5) == -1);
        check_true("a zero-size buffer is refused",
                   wh_numbered_name("a", 0, 0, small, 0) == -1);
    }

    /* --- what a bundle holds, in words ---------------------------------- */
    check_items(7, 0, "7 files");
    check_items(1, 0, "1 file");
    check_items(0, 3, "3 folders");
    check_items(0, 1, "1 folder");
    check_items(7, 2, "7 files and 2 folders");
    check_items(1, 1, "1 file and 1 folder");
    check_items(1, 4, "1 file and 4 folders");
    check_items(5, 1, "5 files and 1 folder");
    check_items(0, 0, "0 files");
    check_items(4294967295UL, 4294967295UL, "4294967295 files and 4294967295 folders");
    {
        char small[8];
        check_true("a phrase that does not fit is refused",
                   wh_items_text(7, 2, small, sizeof(small)) == -1);
    }

    printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
