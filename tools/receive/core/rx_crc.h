#ifndef RX_CRC_H
#define RX_CRC_H
/* CRC-32 as zlib computes it (IEEE 802.3, reflected polynomial 0xEDB88320). Start with crc = 0 and chain. */
unsigned long rx_crc32_update(unsigned long crc, const unsigned char *p, unsigned long n);
#endif
