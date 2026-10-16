#include "harness.h"
#include "rx_crc.h"

static void crc_check_vector(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"123456789", 9) == 0xCBF43926UL, "check value");
}
static void crc_hello(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"hello", 5) == 0x3610A686UL, "crc32(hello)");
}
static void crc_chained_equals_whole(void) {
    unsigned long c = rx_crc32_update(0, (const unsigned char *)"1234", 4);
    c = rx_crc32_update(c, (const unsigned char *)"56789", 5);
    CHECK(c == 0xCBF43926UL, "chained");
}
static void crc_empty_is_zero(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"", 0) == 0, "empty");
}
int main(void) {
    RUN(crc_check_vector); RUN(crc_hello); RUN(crc_chained_equals_whole); RUN(crc_empty_is_zero);
    return REPORT();
}
