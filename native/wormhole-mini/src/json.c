#include "json.h"

static int is_ws(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static unsigned long skip_ws(const char *d, unsigned long n, unsigned long i)
{
    while (i < n && is_ws(d[i])) i++;
    return i;
}

/* Advance past a string starting at the opening quote. Returns the index
 * after the closing quote, or n on error. */
static unsigned long skip_string(const char *d, unsigned long n, unsigned long i)
{
    if (i >= n || d[i] != '"') return n;
    i++;
    while (i < n) {
        if (d[i] == '\\') {
            i += 2;
            continue;
        }
        if (d[i] == '"') return i + 1;
        i++;
    }
    return n;
}

/* Advance past any value. Nesting is tracked with a counter rather than
 * recursion. Returns the index just past the value, or n on error. */
static unsigned long skip_value(const char *d, unsigned long n, unsigned long i)
{
    int depth = 0;

    i = skip_ws(d, n, i);
    if (i >= n) return n;

    if (d[i] == '"') return skip_string(d, n, i);

    if (d[i] != '{' && d[i] != '[') {
        while (i < n && d[i] != ',' && d[i] != '}' && d[i] != ']' && !is_ws(d[i])) i++;
        return i;
    }

    while (i < n) {
        char c = d[i];
        if (c == '"') {
            i = skip_string(d, n, i);
            continue;
        }
        if (c == '{' || c == '[') depth++;
        else if (c == '}' || c == ']') {
            depth--;
            if (depth == 0) return i + 1;
        }
        i++;
    }
    return n;
}

static int classify(const char *d, unsigned long n, unsigned long i)
{
    if (i >= n) return WH_JSON_NONE;
    switch (d[i]) {
    case '"': return WH_JSON_STRING;
    case '{': return WH_JSON_OBJECT;
    case '[': return WH_JSON_ARRAY;
    case 't': case 'f': return WH_JSON_BOOL;
    case 'n': return WH_JSON_NULL;
    default: return WH_JSON_NUMBER;
    }
}

static int key_matches(const char *d, unsigned long start, unsigned long end,
                       const char *key)
{
    unsigned long i;
    /* start/end bracket the raw key including quotes. Keys in this protocol
     * are plain ASCII, so a byte compare is enough. */
    if (end < start + 2) return 0;
    for (i = 0; i + start + 1 < end - 1; i++) {
        if (key[i] == '\0') return 0;
        if (d[start + 1 + i] != key[i]) return 0;
    }
    return key[end - start - 2] == '\0';
}

int wh_json_get(const char *doc, unsigned long doclen, const char *key,
                wh_json_val *out)
{
    unsigned long i = skip_ws(doc, doclen, 0);

    out->p = 0;
    out->len = 0;
    out->type = WH_JSON_NONE;

    if (i >= doclen || doc[i] != '{') return -1;
    i++;

    for (;;) {
        unsigned long kstart, kend, vstart, vend;

        i = skip_ws(doc, doclen, i);
        if (i >= doclen) return -1;
        if (doc[i] == '}') return -1;
        if (doc[i] == ',') { i++; continue; }
        if (doc[i] != '"') return -1;

        kstart = i;
        kend = skip_string(doc, doclen, i);
        /* skip_string returns doclen when the string never closes. A key
         * that ends exactly at the end of the document is malformed here
         * too, since a ':' must follow it. */
        if (kend >= doclen) return -1;
        i = skip_ws(doc, doclen, kend);
        if (i >= doclen || doc[i] != ':') return -1;
        i++;

        vstart = skip_ws(doc, doclen, i);
        vend = skip_value(doc, doclen, vstart);
        if (vend > doclen) return -1;

        if (key_matches(doc, kstart, kend, key)) {
            out->type = classify(doc, doclen, vstart);
            if (out->type == WH_JSON_STRING) {
                out->p = doc + vstart + 1;
                out->len = (vend - 1) - (vstart + 1);
            } else {
                out->p = doc + vstart;
                out->len = vend - vstart;
            }
            return 0;
        }
        i = vend;
    }
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static long emit_utf8(unsigned long cp, char *out, unsigned long cap,
                      unsigned long o)
{
    if (cp < 0x80) {
        if (o + 1 > cap) return -1;
        out[o++] = (char)cp;
    } else if (cp < 0x800) {
        if (o + 2 > cap) return -1;
        out[o++] = (char)(0xc0 | (cp >> 6));
        out[o++] = (char)(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
        if (o + 3 > cap) return -1;
        out[o++] = (char)(0xe0 | (cp >> 12));
        out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[o++] = (char)(0x80 | (cp & 0x3f));
    } else {
        if (o + 4 > cap) return -1;
        out[o++] = (char)(0xf0 | (cp >> 18));
        out[o++] = (char)(0x80 | ((cp >> 12) & 0x3f));
        out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[o++] = (char)(0x80 | (cp & 0x3f));
    }
    return (long)o;
}

long wh_json_str(const wh_json_val *v, char *out, unsigned long cap)
{
    unsigned long i = 0, o = 0;

    if (v->type != WH_JSON_STRING || cap == 0) return -1;

    while (i < v->len) {
        char c = v->p[i];
        if (c != '\\') {
            if (o + 1 >= cap) return -1;
            out[o++] = c;
            i++;
            continue;
        }
        i++;
        if (i >= v->len) return -1;
        switch (v->p[i]) {
        case '"':  if (o + 1 >= cap) return -1; out[o++] = '"';  i++; break;
        case '\\': if (o + 1 >= cap) return -1; out[o++] = '\\'; i++; break;
        case '/':  if (o + 1 >= cap) return -1; out[o++] = '/';  i++; break;
        case 'b':  if (o + 1 >= cap) return -1; out[o++] = '\b'; i++; break;
        case 'f':  if (o + 1 >= cap) return -1; out[o++] = '\f'; i++; break;
        case 'n':  if (o + 1 >= cap) return -1; out[o++] = '\n'; i++; break;
        case 'r':  if (o + 1 >= cap) return -1; out[o++] = '\r'; i++; break;
        case 't':  if (o + 1 >= cap) return -1; out[o++] = '\t'; i++; break;
        case 'u': {
            unsigned long cp = 0;
            long no;
            int k;
            if (i + 4 >= v->len) return -1;
            for (k = 1; k <= 4; k++) {
                int h = hexval(v->p[i + k]);
                if (h < 0) return -1;
                cp = (cp << 4) | (unsigned long)h;
            }
            i += 5;
            /* Combine a surrogate pair if one follows. */
            if (cp >= 0xd800 && cp <= 0xdbff && i + 5 < v->len &&
                v->p[i] == '\\' && v->p[i + 1] == 'u') {
                unsigned long lo = 0;
                int ok = 1;
                for (k = 2; k <= 5; k++) {
                    int h = hexval(v->p[i + k]);
                    if (h < 0) { ok = 0; break; }
                    lo = (lo << 4) | (unsigned long)h;
                }
                if (ok && lo >= 0xdc00 && lo <= 0xdfff) {
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                    i += 6;
                }
            }
            no = emit_utf8(cp, out, cap - 1, o);
            if (no < 0) return -1;
            o = (unsigned long)no;
            break;
        }
        default: return -1;
        }
    }
    out[o] = '\0';
    return (long)o;
}

int wh_json_streq(const wh_json_val *v, const char *s)
{
    unsigned long i;
    if (v->type != WH_JSON_STRING) return 0;
    for (i = 0; i < v->len; i++) {
        if (s[i] == '\0' || v->p[i] != s[i]) return 0;
    }
    return s[v->len] == '\0';
}

int wh_json_u32(const wh_json_val *v, unsigned long *out)
{
    /* Capped at 32 bits regardless of how wide unsigned long happens to be,
     * so a value that a 32-bit build could not represent is rejected on
     * every build rather than silently wrapping on the phone. A file size
     * is the main thing read through here, and 4 GiB is also the FAT32
     * per-file limit on the memory card. */
    static const unsigned long LIMIT = 4294967295UL;
    unsigned long i, acc = 0;

    if (v->type != WH_JSON_NUMBER || v->len == 0) return -1;
    for (i = 0; i < v->len; i++) {
        unsigned long digit;
        if (v->p[i] < '0' || v->p[i] > '9') return -1;
        digit = (unsigned long)(v->p[i] - '0');
        if (acc > (LIMIT - digit) / 10) return -1;
        acc = acc * 10 + digit;
    }
    *out = acc;
    return 0;
}

/* --- writer ---------------------------------------------------------- */

static void jw_ch(wh_jw *w, char c)
{
    if (w->err) return;
    if (w->len + 1 >= w->cap) { w->err = 1; return; }
    w->buf[w->len++] = c;
}

static void jw_raw_str(wh_jw *w, const char *s)
{
    while (*s && !w->err) jw_ch(w, *s++);
}

/* JSON string escaping. The protocol only ever puts ASCII here (hex bodies,
 * nameplates, phase names), so control characters are escaped generically
 * and everything else passes through. */
static void jw_quoted(wh_jw *w, const char *s)
{
    jw_ch(w, '"');
    while (*s && !w->err) {
        unsigned char c = (unsigned char)*s++;
        if (c == '"' || c == '\\') {
            jw_ch(w, '\\');
            jw_ch(w, (char)c);
        } else if (c < 0x20) {
            static const char hexd[] = "0123456789abcdef";
            jw_raw_str(w, "\\u00");
            jw_ch(w, hexd[(c >> 4) & 0xf]);
            jw_ch(w, hexd[c & 0xf]);
        } else {
            jw_ch(w, (char)c);
        }
    }
    jw_ch(w, '"');
}

void wh_jw_init(wh_jw *w, char *buf, unsigned long cap)
{
    w->buf = buf;
    w->cap = cap;
    w->len = 0;
    w->err = 0;
    w->need_comma = 0;
}

void wh_jw_obj_open(wh_jw *w)
{
    jw_ch(w, '{');
    w->need_comma = 0;
}

void wh_jw_obj_close(wh_jw *w)
{
    jw_ch(w, '}');
    w->need_comma = 1;
}

void wh_jw_key(wh_jw *w, const char *key)
{
    if (w->need_comma) jw_ch(w, ',');
    jw_quoted(w, key);
    jw_ch(w, ':');
    w->need_comma = 1;
}

void wh_jw_str(wh_jw *w, const char *key, const char *value)
{
    wh_jw_key(w, key);
    jw_quoted(w, value);
}

void wh_jw_u32(wh_jw *w, const char *key, unsigned long value)
{
    char tmp[24];
    int n = 0, i;
    wh_jw_key(w, key);
    if (value == 0) {
        jw_ch(w, '0');
        return;
    }
    while (value > 0 && n < (int)sizeof(tmp)) {
        tmp[n++] = (char)('0' + (value % 10));
        value /= 10;
    }
    for (i = n - 1; i >= 0; i--) jw_ch(w, tmp[i]);
}

void wh_jw_raw(wh_jw *w, const char *key, const char *json)
{
    wh_jw_key(w, key);
    jw_raw_str(w, json);
}

int wh_jw_done(wh_jw *w)
{
    if (w->err) return -1;
    if (w->len >= w->cap) { w->err = 1; return -1; }
    w->buf[w->len] = '\0';
    return 0;
}
