// LWB+ bring-up on a plain Pico 2: power the radio over gSPI, print its MAC, scan.
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"

#define LED 25 // the plain Pico 2's own LED

static int seen;

static int on_scan(void *env, const cyw43_ev_scan_result_t *r) {
    (void)env;
    if (r) {
        seen++;
        printf("  %-32.*s  rssi %4d  ch %2d\n", r->ssid_len, r->ssid, r->rssi, r->channel);
    }
    return 0;
}

int main(void) {
    stdio_init_all();
    gpio_init(LED);
    gpio_set_dir(LED, GPIO_OUT);
    for (int i = 0; i < 10 && !stdio_usb_connected(); i++) sleep_ms(500);
    printf("\nlwbtest: REG_ON GP2, DATA GP3, CS GP4, CLK GP5\n");

    if (cyw43_arch_init()) {
        printf("FAIL: cyw43 init -- the radio did not answer over SPI\n");
        for (;;) { gpio_put(LED, 1); sleep_ms(100); gpio_put(LED, 0); sleep_ms(100); }
    }
    cyw43_arch_enable_sta_mode();
    uint8_t mac[6];
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    printf("PASS: radio up, MAC %02x:%02x:%02x:%02x:%02x:%02x\n",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    for (;;) {
        seen = 0;
        cyw43_wifi_scan_options_t opts = {0};
        printf("scan:\n");
        if (cyw43_wifi_scan(&cyw43_state, &opts, NULL, on_scan) == 0) {
            while (cyw43_wifi_scan_active(&cyw43_state)) sleep_ms(100);
        }
        printf("scan done, %d results\n", seen);
        gpio_put(LED, 1); sleep_ms(1000); gpio_put(LED, 0); sleep_ms(4000);
    }
}
