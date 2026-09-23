#include "fw_offer.h"
#include "json_scan.h"
#include <string.h>

static int b64v(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
// Strict: length a multiple of 4, '=' only as the last one or two characters.
static int b64_decode(const char *in, uint8_t *out, int cap) {
    size_t n = strlen(in);
    if (n == 0 || n % 4) return -1;
    int o = 0;
    for (size_t i = 0; i < n; i += 4) {
        int v[4], pad = 0;
        for (int k = 0; k < 4; k++) {
            char ch = in[i + (size_t)k];
            if (ch == '=') {
                if (i + 4 != n || k < 2) return -1;
                v[k] = 0; pad++;
            } else {
                if (pad) return -1;
                v[k] = b64v(ch);
                if (v[k] < 0) return -1;
            }
        }
        uint32_t w = ((uint32_t)v[0] << 18) | ((uint32_t)v[1] << 12) | ((uint32_t)v[2] << 6) | (uint32_t)v[3];
        for (int k = 0; k < 3 - pad; k++) {
            if (o >= cap) return -1;
            out[o++] = (uint8_t)(w >> (16 - 8 * k));
        }
    }
    return o;
}
static bool is_hex64(const char *s) {
    if (strlen(s) != 64) return false;
    for (int i = 0; i < 64; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}

bool fw_offer_parse(const char *j, fw_offer_t *o) {
    memset(o, 0, sizeof *o);
    char sig_b64[96];
    if (!json_str(j, "version", o->version, sizeof o->version) || o->version[0] == '\0') return false;
    if (!json_u32(j, "sequence", &o->sequence) || o->sequence == 0) return false;
    if (!json_str(j, "sha256", o->sha256, sizeof o->sha256) || !is_hex64(o->sha256)) return false;
    if (!json_u32(j, "sizeBytes", &o->size_bytes) || o->size_bytes == 0) return false;
    if (!json_str(j, "signature", sig_b64, sizeof sig_b64)) return false;
    if (b64_decode(sig_b64, o->signature, sizeof o->signature) != 64) return false;
    if (!json_str(j, "keyId", o->key_id, sizeof o->key_id) || o->key_id[0] == '\0') return false;
    return true;
}
