#ifndef HARNESS_H
#define HARNESS_H
#include <stdio.h>
#include <string.h>
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
