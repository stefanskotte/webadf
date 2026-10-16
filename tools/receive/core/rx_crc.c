#include "rx_crc.h"

static unsigned long table[256];
static int ready;

static void init(void) {
    unsigned long c;
    int n, k;
    for (n = 0; n < 256; n++) {
        c = (unsigned long)n;
        for (k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320UL ^ (c >> 1) : c >> 1;
        table[n] = c;
    }
    ready = 1;
}

unsigned long rx_crc32_update(unsigned long crc, const unsigned char *p, unsigned long n) {
    if (!ready) init();
    crc = (crc ^ 0xFFFFFFFFUL) & 0xFFFFFFFFUL;
    while (n--) crc = table[(crc ^ *p++) & 0xFF] ^ (crc >> 8);
    return (crc ^ 0xFFFFFFFFUL) & 0xFFFFFFFFUL;
}
