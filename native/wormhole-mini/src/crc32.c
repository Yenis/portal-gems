#include "crc32.h"

/* Reflected polynomial 0xEDB88320, one entry per nibble. */
static const unsigned long WH_CRC_TABLE[16] = {
    0x00000000UL, 0x1db71064UL, 0x3b6e20c8UL, 0x26d930acUL,
    0x76dc4190UL, 0x6b6b51f4UL, 0x4db26158UL, 0x5005713cUL,
    0xedb88320UL, 0xf00f9344UL, 0xd6d6a3e8UL, 0xcb61b38cUL,
    0x9b64c2b0UL, 0x86d3d2d4UL, 0xa00ae278UL, 0xbdbdf21cUL
};

unsigned long wh_crc32(unsigned long crc, const unsigned char *data,
                       unsigned long len)
{
    unsigned long i;

    crc = ~crc & 0xffffffffUL;
    for (i = 0; i < len; i++) {
        crc ^= data[i];
        crc = (crc >> 4) ^ WH_CRC_TABLE[crc & 0x0f];
        crc = (crc >> 4) ^ WH_CRC_TABLE[crc & 0x0f];
    }
    return ~crc & 0xffffffffUL;
}
