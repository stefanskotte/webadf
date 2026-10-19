#include <string.h>
#include "rx_names.h"

static int part_ok(const char *p, size_t n) {
    size_t i;
    if (n < 1 || n > RX_PART_MAX) return 0;
    if ((n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)p[i];
        if (c < 0x20 || c == 0x7f || c == ':') return 0;
    }
    return 1;
}

int rx_path_ok(const char *path) {
    size_t len = strlen(path), start = 0, i;
    if (len < 1 || len > RX_PATH_MAX) return 0;
    for (i = 0; i <= len; i++) {
        if (i == len || path[i] == '/') {
            if (!part_ok(path + start, i - start)) return 0;
            start = i + 1;
        }
    }
    return 1;
}

unsigned rx_utoa(unsigned long v, char *out) {
    char tmp[11];
    unsigned n = 0, i;
    do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    for (i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    out[n] = 0;
    return n;
}

int rx_candidate(const char *path, unsigned n, char *out) {
    const char *last = strrchr(path, '/');
    size_t dirlen = last ? (size_t)(last - path + 1) : 0;
    const char *name = path + dirlen;
    size_t nlen = strlen(name), stem, extlen, slen;
    const char *dot;
    char suf[12];
    if (n <= 1) {
        if (strlen(path) > RX_PATH_MAX) return -1;
        strcpy(out, path);
        return 0;
    }
    dot = strrchr(name, '.');
    if (!dot || dot == name) dot = name + nlen;
    stem = (size_t)(dot - name);
    extlen = nlen - stem;
    suf[0] = '_';
    slen = 1 + rx_utoa(n, suf + 1);
    if (stem + slen + extlen > RX_PART_MAX) {
        if (slen + extlen >= RX_PART_MAX) return -1;
        stem = RX_PART_MAX - slen - extlen;
    }
    if (dirlen + stem + slen + extlen > RX_PATH_MAX) return -1;
    memcpy(out, path, dirlen);
    memcpy(out + dirlen, name, stem);
    memcpy(out + dirlen + stem, suf, slen);
    memcpy(out + dirlen + stem + slen, dot, extlen);
    out[dirlen + stem + slen + extlen] = 0;
    return 0;
}

void rx_base_name(const char *path, char *out) {
    size_t n = strlen(path), start;
    while (n > 0 && path[n - 1] == '/') n--;
    start = n;
    while (start > 0 && path[start - 1] != '/' && path[start - 1] != ':') start--;
    if (start == n) {   /* "DH0:" or "RAM:/": the volume's name, up to its colon (or a first '/') */
        for (start = 0, n = 0; path[n] && path[n] != ':' && path[n] != '/'; n++) ;
    }
    if (n - start > RX_PART_MAX) n = start + RX_PART_MAX;
    memcpy(out, path + start, n - start);
    out[n - start] = 0;
}
