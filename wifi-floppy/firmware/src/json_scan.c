#include "json_scan.h"
#include <string.h>

// Linear scan for "key": value. The one property that matters here is that
// a `"key"`-shaped substring INSIDE a string VALUE is never mistaken for an
// actual key -- so every quoted string in the input is walked past as a
// unit (respecting backslash escapes), and only a quoted string that is
// itself immediately followed by a colon is considered a candidate key.
// This does not track nesting depth; it doesn't need to, because every key
// this device reads is unique across the whole response shape.
static const char *find_value(const char *json, const char *key) {
    size_t keylen = strlen(key);
    const char *p = json;
    while (*p) {
        if (*p != '"') { p++; continue; }

        const char *start = p + 1;
        const char *q = start;
        while (*q && *q != '"') {
            if (*q == '\\' && q[1]) q++; // skip an escaped character whole
            q++;
        }
        if (!*q) break; // unterminated string: malformed input, stop here

        const char *after = q + 1;
        while (*after == ' ' || *after == '\t' || *after == '\n' || *after == '\r') after++;

        if (*after == ':' && (size_t)(q - start) == keylen &&
            memcmp(start, key, keylen) == 0) {
            const char *v = after + 1;
            while (*v == ' ' || *v == '\t' || *v == '\n' || *v == '\r') v++;
            return v;
        }
        p = q + 1; // resume scanning after this string, key or not
    }
    return NULL;
}

bool json_str(const char *json, const char *key, char *out, int out_len) {
    const char *v = find_value(json, key);
    if (!v || out_len <= 0) return false;
    if (strncmp(v, "null", 4) == 0) {
        out[0] = '\0';
        return true;
    }
    if (*v != '"') return false; // not a string value
    v++;
    int n = 0;
    while (*v && *v != '"' && n < out_len - 1) {
        if (*v == '\\' && v[1]) {
            v++;
            char c = *v;
            switch (c) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                default: break; // '"', '\\', '/' and unknown escapes: copy as-is
            }
            out[n++] = c;
            v++;
        } else {
            out[n++] = *v++;
        }
    }
    out[n] = '\0';
    return true;
}

bool json_u32(const char *json, const char *key, uint32_t *out) {
    const char *v = find_value(json, key);
    if (!v || *v < '0' || *v > '9') return false; // rejects null/negative too
    uint32_t val = 0;
    while (*v >= '0' && *v <= '9') {
        val = val * 10u + (uint32_t)(*v - '0');
        v++;
    }
    *out = val;
    return true;
}

bool json_bool(const char *json, const char *key, bool *out) {
    const char *v = find_value(json, key);
    if (!v) return false;
    if (strncmp(v, "true", 4) == 0)  { *out = true;  return true; }
    if (strncmp(v, "false", 5) == 0) { *out = false; return true; }
    return false;
}

bool json_is_null(const char *json, const char *key) {
    const char *v = find_value(json, key);
    return v && strncmp(v, "null", 4) == 0;
}
