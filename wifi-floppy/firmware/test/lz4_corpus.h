#ifndef LZ4_CORPUS_H
#define LZ4_CORPUS_H
/*
 * Frames for the LZ4 tests (spec 2026-10-18 §6, "check binaries and text files"): text and HTML that compress, random
 * bytes that do not, zeros, and text whose last 11 bytes are zeros (a raw block toward the board must not carry such a
 * run). Deterministic per seed. Header-only and byte access only: tools/paulanet-driver/test.sh builds it for the
 * 68000 too. Ours (MIT).
 */
#include <stdint.h>
#include <stddef.h>
#include <string.h>

enum { LC_TEXT, LC_RANDOM, LC_ZEROS, LC_TEXT_ZERO_TAIL, LC_HTML };

static uint32_t lc_next(uint32_t *s) {
    uint32_t x = *s;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return *s = x;
}

static const char *const LC_WORDS[] = {
    "the ", "amiga ", "floppy ", "network ", "packet ", "board ", "driver ", "paula ", "reads ", "writes ",
    "track ", "workbench ", "disk ", "file ", "and ", "of ", "to ", "a ", "is ", "with ", ". ", ",\n",
};
static const char *const LC_TAGS[] = {
    "<p>", "</p>\n", "<a href=\"/disk/", "\">", "</a>", "<li class=\"row\">", "</li>\n", "<div id=\"main\">", "</div>",
};

/* 20 bytes whose LZ4 block is exactly 20 bytes: 8 literals, a 4-byte match at offset 8, 8 literals. Defined here
 * once: every LZ4 test that needs a block as long as its frame uses this one. */
static const uint8_t SAME_SIZE[20] = { 'W', 'X', 'Y', 'Z', 1, 2, 3, 4, 'W', 'X', 'Y', 'Z', 5, 6, 7, 8, 9, 10, 11, 12 };

static void lc_frame(uint8_t *f, size_t len, int kind, uint32_t seed) {
    uint32_t s = seed * 2654435761u + 0x9E3779B9u;
    size_t i = 0;
    if (kind == LC_RANDOM) { for (; i < len; i++) f[i] = (uint8_t)lc_next(&s); return; }
    if (kind == LC_ZEROS) { memset(f, 0, len); return; }
    while (i < len) {
        const char *w = kind == LC_HTML && (lc_next(&s) & 3u) == 0u
            ? LC_TAGS[lc_next(&s) % (sizeof LC_TAGS / sizeof LC_TAGS[0])]
            : LC_WORDS[lc_next(&s) % (sizeof LC_WORDS / sizeof LC_WORDS[0])];
        while (*w && i < len) f[i++] = (uint8_t)*w++;
    }
    if (kind == LC_TEXT_ZERO_TAIL && len >= 11u) memset(f + len - 11u, 0, 11u);
}
#endif
