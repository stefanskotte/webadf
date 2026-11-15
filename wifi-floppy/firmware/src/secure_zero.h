#ifndef SECURE_ZERO_H
#define SECURE_ZERO_H
// Wipes a secret (a password, a token) the compiler cannot drop. A plain
// memset() of a buffer that is not read afterwards is a dead store, and the
// optimiser is free to remove it; writing through a volatile pointer is not.
// Header-only and pure, so host tests and the device build share it.
#include <stddef.h>

static inline void secure_zero(void *p, size_t n) {
    volatile unsigned char *v = (volatile unsigned char *)p;
    while (n--) *v++ = 0;
}

#endif
