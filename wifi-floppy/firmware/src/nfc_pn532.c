#include "nfc_reader_priv.h"

void pn532_probe(nfc_reader_t *r) { nfc_go(r, ST_ABSENT); }
bool pn532_handle(nfc_reader_t *r) { (void)r; return false; }
int pn532_frame(uint8_t *out, int cap, const uint8_t *data, int n) { (void)out; (void)cap; (void)data; (void)n; return -1; }
pn_parse_t pn532_parse(const uint8_t *b, int n, int *at, int *len, int *need) {
    (void)b; (void)n; (void)at; (void)len; (void)need; return PN_BAD;
}
