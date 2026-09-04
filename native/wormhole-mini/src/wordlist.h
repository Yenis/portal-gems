/* The PGP wordlist, for generating human-speakable codes on the phone.
 *
 * The same list the engine uses (native/magic-wormhole/src/core/pgpwords.json
 * via core/wordlist.rs), so a code shown on the E72 looks like a code from
 * any other wormhole client. A two-word code takes its first word from the
 * even list and its second from the odd list. */
#ifndef WH_WORDLIST_H
#define WH_WORDLIST_H

#ifdef __cplusplus
extern "C" {
#endif

#define WH_WORDLIST_SIZE 256
/* Longest code: nameplate, two words and two hyphens, plus room to spare. */
#define WH_CODE_MAX 64

extern const char *const wh_even_words[WH_WORDLIST_SIZE];
extern const char *const wh_odd_words[WH_WORDLIST_SIZE];

/* Build "<nameplate>-<even>-<odd>" with two freshly chosen words.
 * Returns 0, or -1 if it will not fit. */
int wh_make_code(const char *nameplate, char *out, unsigned long cap);

#ifdef __cplusplus
}
#endif
#endif /* WH_WORDLIST_H */
