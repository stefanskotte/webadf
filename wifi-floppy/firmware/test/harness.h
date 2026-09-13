#ifndef HARNESS_H
#define HARNESS_H
#include <stdio.h>
#include <string.h>
/*
 * Line-buffer stdout before main() runs.
 *
 * Without this a crash LOSES the output that says which test crashed. On a
 * terminal stdout is line-buffered and everything appears; piped -- which is
 * what CI does -- it is block-buffered, so a segfault takes the whole buffer
 * with it and the log shows the previous binary's report followed by a bare
 * "Segmentation fault". That is exactly the situation where the name of the
 * running test is the only thing worth having, and exactly when it vanishes.
 *
 * A constructor rather than a call in each main(): there are seventeen of
 * them, and one that forgot would be indistinguishable from this not working.
 */
__attribute__((constructor)) static void harness_line_buffer(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
}

static int tests_failed = 0;
static int checks_run = 0;
#define CHECK(cond, msg) do { checks_run++; if (!(cond)) { \
    printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, (msg)); tests_failed++; } } while (0)
#define CHECK_EQ_INT(a, b) do { checks_run++; long _a=(long)(a), _b=(long)(b); \
    if (_a != _b) { printf("  FAIL %s:%d: expected %ld, got %ld\n", __FILE__, __LINE__, _b, _a); \
    tests_failed++; } } while (0)
#define RUN(fn) do { printf("- %s\n", #fn); fn(); } while (0)
#define REPORT() (printf("%s: %d checks, %d failed\n", __FILE__, checks_run, tests_failed), \
                  tests_failed ? 1 : 0)
#endif
