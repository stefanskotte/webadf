#include "harness.h"
#include "../src/token_store.h"
#include "../src/psram_image.h"
#include <string.h>

static char buf[128];

static void test_token_round_trips(void) {
    token_store_erase();
    CHECK(!token_store_load(buf, sizeof buf), "no token initially");
    CHECK(token_store_save("tok-abc"), "save");
    CHECK(token_store_load(buf, sizeof buf), "load");
    CHECK(strcmp(buf, "tok-abc") == 0, "value");
}

// The flash-versus-real-time-bus mitigation (task-10-brief.md), exercised
// directly: a token write disables XIP, and core0's DMA IRQ -- which
// re-arms the flux feed and raises INDEX every revolution -- must never be
// caught mid-flash (main.c moves it into RAM with __not_in_flash_func for
// exactly this reason). token_store_save() is belt-and-braces on top of
// that: it must refuse outright whenever a disk is mounted, so a future
// caller that writes a token post-mount (this task's registration flow
// never does -- it always runs before anything is mounted) cannot
// reintroduce the stall.
static void test_save_refuses_while_a_disk_is_mounted(void) {
    token_store_erase();
    psram_publish_slot(0);
    CHECK(!token_store_save("should-not-land"), "must refuse while a disk is mounted");
    CHECK(!token_store_load(buf, sizeof buf), "nothing may be stored on refusal");
    psram_publish_slot(SLOT_NONE);
    CHECK(token_store_save("now-ok"), "must succeed once unmounted");
    CHECK(token_store_load(buf, sizeof buf) && strcmp(buf, "now-ok") == 0,
          "the post-unmount save must actually land");
}

int main(void) {
    RUN(test_token_round_trips);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    return REPORT();
}
