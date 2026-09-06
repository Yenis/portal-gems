/* CRC-32 (the zip/PNG polynomial), computed a nibble at a time.
 *
 * A byte-at-a-time table is 1 KB; a nibble table is 64 bytes and costs one
 * extra shift per byte. On a phone where every static allocation is real
 * memory that is the better trade, and this is never the bottleneck - the
 * network is. */
#ifndef WH_CRC32_H
#define WH_CRC32_H

#ifdef __cplusplus
extern "C" {
#endif

/* Start with 0, feed successive blocks, and the running value is the CRC. */
unsigned long wh_crc32(unsigned long crc, const unsigned char *data,
                       unsigned long len);

#ifdef __cplusplus
}
#endif
#endif /* WH_CRC32_H */
