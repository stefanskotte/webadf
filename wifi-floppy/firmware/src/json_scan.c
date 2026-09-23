#include "json_scan.h"
#include <string.h>

// Linear scan for "key": value. The one property that matters here is that
// a `"key"`-shaped substring INSIDE a string VALUE is never mistaken for an
// actual key -- so every quoted string in the input is walked past as a
// unit (respecting backslash escapes), and only a quoted string that is
// itself immediately followed by a colon is considered a candidate key.
// This does not track nesting depth; it doesn't need to, because every key
// this device reads is unique across the whole response shape, once `update`
// has been lifted out by json_object(..., true); dc_step does that before
// anything else reads the body.
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

bool json_u32_strict(const char *json, const char *key, uint32_t *out) {
    const char *v = find_value(json, key);
    if (!v || *v < '0' || *v > '9') return false; // rejects null/negative too
    uint64_t val = 0;
    while (*v >= '0' && *v <= '9') {
        val = val * 10u + (uint32_t)(*v - '0');
        if (val > 0xFFFFFFFFu) return false; // overflow past uint32, bail before it could wrap
        v++;
    }
    // Only a JSON value delimiter (comma, closing brace/bracket, whitespace,
    // or end of input) may follow the digits. Anything else -- '.', 'e',
    // a bare letter -- means this was not an integer in the first place.
    if (*v != '\0' && *v != ',' && *v != '}' && *v != ']' &&
        *v != ' ' && *v != '\t' && *v != '\n' && *v != '\r') {
        return false;
    }
    *out = (uint32_t)val;
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

bool json_has(const char *json, const char *key) {
    return find_value(json, key) != NULL;
}

bool json_object(char *json, const char *key, char *out, int out_len, bool blank) {
    const char *v = find_value(json, key);
    if (!v || *v != '{' || out_len <= 0) return false;
    int depth = 0;
    const char *p = v;
    for (; *p; p++) {
        if (*p == '"') {                       // walk a string whole, escapes included
            p++;
            while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
            if (!*p) return false;
            continue;
        }
        if (*p == '{') depth++;
        else if (*p == '}' && --depth == 0) break;
    }
    if (!*p) return false;                     // unterminated object
    int n = (int)(p - v) + 1;
    if (n >= out_len) return false;
    memcpy(out, v, (size_t)n);
    out[n] = '\0';
    if (blank) memset((char *)v, ' ', (size_t)n);
    return true;
}
