#include <string.h>
#include "harness.h"
#include "rx_names.h"

static void ok_paths(void) {
    CHECK(rx_path_ok("Hello.txt"), "plain");
    CHECK(rx_path_ok("mods/axelf.mod"), "subfolder");
    CHECK(rx_path_ok("Caf\xe9.txt"), "latin-1");
    CHECK(rx_path_ok("123456789012345678901234567890"), "30 bytes");
    CHECK(rx_path_ok(".info"), "leading dot is a name");
    CHECK(rx_path_ok("a b/c d"), "spaces");
}
static void bad_paths(void) {
    CHECK(!rx_path_ok(""), "empty");
    CHECK(!rx_path_ok("../x"), "dotdot");
    CHECK(!rx_path_ok("a/../x"), "inner dotdot");
    CHECK(!rx_path_ok("./x"), "dot");
    CHECK(!rx_path_ok("/x"), "absolute");
    CHECK(!rx_path_ok("x/"), "trailing slash");
    CHECK(!rx_path_ok("a//b"), "double slash");
    CHECK(!rx_path_ok("DH0:x"), "device");
    CHECK(!rx_path_ok("a\nb"), "control byte");
    CHECK(!rx_path_ok("a\x7f"), "DEL");
    CHECK(!rx_path_ok("1234567890123456789012345678901"), "31 bytes");
    char longp[300]; memset(longp, 'a', 299); longp[299] = 0;
    for (int i = 20; i < 299; i += 21) longp[i] = '/';
    CHECK(!rx_path_ok(longp), "over 255 bytes");
}
static void candidates(void) {
    char out[RX_PATH_MAX + 1];
    CHECK_EQ_INT(rx_candidate("Hello.txt", 1, out), 0); CHECK(strcmp(out, "Hello.txt") == 0, "n=1 is the path");
    rx_candidate("Hello.txt", 2, out); CHECK(strcmp(out, "Hello_2.txt") == 0, "Hello_2.txt");
    rx_candidate("dir/Foo", 3, out); CHECK(strcmp(out, "dir/Foo_3") == 0, "no extension");
    rx_candidate(".info", 2, out); CHECK(strcmp(out, ".info_2") == 0, "leading dot is not an extension");
    rx_candidate("a.b.lha", 2, out); CHECK(strcmp(out, "a.b_2.lha") == 0, "last dot");
    /* 26 + 4 = 30 bytes: the stem is cut to make room for "_2" and then "_10". */
    rx_candidate("AAAAAAAAAAAAAAAAAAAAAAAAAA.lha", 2, out);
    CHECK(strcmp(out, "AAAAAAAAAAAAAAAAAAAAAAAA_2.lha") == 0, "stem truncated, 30 bytes");
    CHECK_EQ_INT(strlen(out), 30);
    rx_candidate("AAAAAAAAAAAAAAAAAAAAAAAAAA.lha", 10, out);
    CHECK(strcmp(out, "AAAAAAAAAAAAAAAAAAAAAAA_10.lha") == 0, "_10");
    /* An extension so long that no stem byte is left: refused. */
    CHECK_EQ_INT(rx_candidate("a.12345678901234567890123456789", 2, out), -1);
}
static void utoa(void) {
    char b[12];
    CHECK_EQ_INT(rx_utoa(0, b), 1); CHECK(strcmp(b, "0") == 0, "0");
    CHECK_EQ_INT(rx_utoa(4194304UL, b), 7); CHECK(strcmp(b, "4194304") == 0, "4194304");
    CHECK_EQ_INT(rx_utoa(4294967295UL, b), 10); CHECK(strcmp(b, "4294967295") == 0, "max");
}
/* The name a dropped or typed Amiga path goes up under (fix round 1 of Task 5): the last part, a trailing '/' ignored
   (Shell TAB completion adds one), or the volume's name for a bare volume. */
static void base_names(void) {
    char out[RX_PART_MAX + 1];
    rx_base_name("DH0:Drawer", out); CHECK(strcmp(out, "Drawer") == 0, "absolute");
    rx_base_name("DH0:Drawer/", out); CHECK(strcmp(out, "Drawer") == 0, "absolute, trailing slash");
    rx_base_name("DH0:a/Mods//", out); CHECK(strcmp(out, "Mods") == 0, "two trailing slashes");
    rx_base_name("Work:Up/Hello.txt", out); CHECK(strcmp(out, "Hello.txt") == 0, "a file");
    rx_base_name("Drawer/", out); CHECK(strcmp(out, "Drawer") == 0, "relative, trailing slash");
    rx_base_name("Drawer", out); CHECK(strcmp(out, "Drawer") == 0, "relative");
    rx_base_name("DH0:", out); CHECK(strcmp(out, "DH0") == 0, "bare volume");
    rx_base_name("RAM:/", out); CHECK(strcmp(out, "RAM") == 0, "volume, then a slash");
    rx_base_name("DH0:123456789012345678901234567890XYZ", out); CHECK_EQ_INT(strlen(out), RX_PART_MAX);
}
static void sendable_names(void) {
    char n31[32];
    CHECK(rx_name_sendable("Work"), "plain");
    CHECK(rx_name_sendable("RAM Disk"), "a space inside");
    CHECK(rx_name_sendable("Caf\xe9"), "latin-1");
    CHECK(rx_name_sendable(".info"), "a leading dot");
    CHECK(rx_name_sendable("123456789012345678901234567890"), "30 bytes");
    memset(n31, 'a', 31); n31[31] = 0;
    CHECK(!rx_name_sendable(n31), "31 bytes");
    CHECK(!rx_name_sendable(""), "empty");
    CHECK(!rx_name_sendable("   "), "only spaces");
    CHECK(!rx_name_sendable("\xa0\xa0"), "only no-break spaces (JavaScript's trim takes them too)");
    CHECK(!rx_name_sendable("."), "dot");
    CHECK(!rx_name_sendable(".."), "dot dot");
    CHECK(!rx_name_sendable("a:b"), "colon");
    CHECK(!rx_name_sendable("a/b"), "slash");
    CHECK(!rx_name_sendable("a\x01"), "control byte");
    CHECK(!rx_name_sendable("a\x7f"), "DEL");
    CHECK(!rx_name_sendable("a\x85"), "C1 byte");
}
static void sendable_devices(void) {
    CHECK(rx_device_sendable("DF0:"), "DF0:");
    CHECK(rx_device_sendable("RAM:"), "RAM:");
    CHECK(rx_device_sendable("my.dev-1_:"), "dots, dashes, underscores");
    CHECK(rx_device_sendable("123456789012345678901234567890:"), "30 and a colon");
    CHECK(!rx_device_sendable("1234567890123456789012345678901:"), "31 and a colon");
    CHECK(!rx_device_sendable("DF0"), "no colon");
    CHECK(!rx_device_sendable(":"), "only a colon");
    CHECK(!rx_device_sendable("D F0:"), "a space");
    CHECK(!rx_device_sendable("DF0:x"), "after the colon");
}

int main(void) { RUN(ok_paths); RUN(bad_paths); RUN(candidates); RUN(utoa); RUN(base_names); RUN(sendable_names); RUN(sendable_devices); return REPORT(); }
