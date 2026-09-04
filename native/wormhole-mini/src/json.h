/* A minimal JSON reader and writer.
 *
 * Deliberately not a general parser. The mailbox protocol sends small, flat
 * objects, so the reader looks up keys at the top level of one object and
 * hands back a slice of the original text - no allocation, no tree, and no
 * recursion (nesting is skipped with a depth counter, so a hostile document
 * cannot blow the phone's stack). */
#ifndef WH_JSON_H
#define WH_JSON_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    WH_JSON_NONE = 0,
    WH_JSON_STRING,
    WH_JSON_NUMBER,
    WH_JSON_OBJECT,
    WH_JSON_ARRAY,
    WH_JSON_BOOL,
    WH_JSON_NULL
} wh_json_type;

typedef struct {
    const char *p;      /* for strings, the contents between the quotes */
    unsigned long len;  /* still escaped; use wh_json_str to decode */
    int type;
} wh_json_val;

/* Look up a key in the top-level object. Returns 0, or -1 if absent or the
 * document is malformed. */
int wh_json_get(const char *doc, unsigned long doclen, const char *key,
                wh_json_val *out);

/* Decode a string value into `out` as NUL-terminated text. Returns the
 * length, or -1 if it does not fit or an escape is malformed. */
long wh_json_str(const wh_json_val *v, char *out, unsigned long cap);

/* Compare a string value against plain ASCII, without decoding. Returns 1 on
 * a match. */
int wh_json_streq(const wh_json_val *v, const char *s);

/* Read a non-negative integer value. Returns 0, or -1. */
int wh_json_u32(const wh_json_val *v, unsigned long *out);

/* --- writer ---------------------------------------------------------- */

typedef struct {
    char *buf;
    unsigned long cap;
    unsigned long len;
    int err;            /* sticky: checked once at the end */
    int need_comma;
} wh_jw;

void wh_jw_init(wh_jw *w, char *buf, unsigned long cap);
void wh_jw_obj_open(wh_jw *w);
void wh_jw_obj_close(wh_jw *w);
void wh_jw_key(wh_jw *w, const char *key);
void wh_jw_str(wh_jw *w, const char *key, const char *value);
void wh_jw_u32(wh_jw *w, const char *key, unsigned long value);
/* Raw, pre-formatted JSON as a value. The caller owns its validity. */
void wh_jw_raw(wh_jw *w, const char *key, const char *json);
/* Returns 0 and NUL-terminates, or -1 if anything overflowed. */
int wh_jw_done(wh_jw *w);

#ifdef __cplusplus
}
#endif
#endif /* WH_JSON_H */
