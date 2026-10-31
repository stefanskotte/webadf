/* Protocol 4 (spec docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md §2): the web app writes to the
   Amiga's own disks, only while the owner ticked "Let the web app change my disks". */
#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

#define KEY "0123456789abcdef0123456789abcdef"
#define KEY2 "fedcba9876543210fedcba9876543210"
static fakefs F; static rx_fs FS; static rx_session S; static rx_upq Q;
#define EV_MAX 512
static rx_event ev[EV_MAX]; static int n_ev;
static char ev_path[EV_MAX][300], ev_text[EV_MAX][100], ev_code[EV_MAX][20], ev_id[EV_MAX][48], ev_to[EV_MAX][300];
static int ev_has_text[EV_MAX];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= EV_MAX) return;
    ev[n_ev] = *e;
    snprintf(ev_path[n_ev], 300, "%s", e->path ? e->path : "");
    snprintf(ev_text[n_ev], 100, "%s", e->text ? e->text : "");
    ev_has_text[n_ev] = e->text != NULL;
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_id[n_ev], 48, "%s", e->id ? e->id : "");
    snprintf(ev_to[n_ev], 300, "%s", e->to ? e->to : "");
    ev[n_ev].path = NULL; ev[n_ev].text = NULL; ev[n_ev].code = NULL; ev[n_ev].id = NULL; ev[n_ev].key = NULL; ev[n_ev].to = NULL;
    n_ev++;
}
static int last_ev(int kind) { int i; for (i = n_ev - 1; i >= 0; i--) if (ev[i].kind == kind) return i; return -1; }
static void vol(const char *name, const char *dev) {
    rx_vol *v = &F.vols[F.nvols++];
    memset(v, 0, sizeof *v);
    snprintf(v->name, sizeof v->name, "%s", name); snprintf(v->device, sizeof v->device, "%s", dev);
    v->size = 1000000; v->free = 500000;
}
/* browse, write: the owner's two switches. Two volumes: Work (DH0:) and Floppy (DF0:). */
static void setup(int browse, int write) {
    ff_init(&F, &FS); n_ev = 0;
    rx_upq_init(&Q, KEY); Q.browse = browse; Q.write = write;
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q);
    vol("Work", "DH0:"); vol("Floppy", "DF0:");
    ff_add(&F, "Work:", 1); ff_add(&F, "Floppy:", 1);
}
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
static int feedn(const char *str, unsigned long n) { return rx_feed(&S, (const unsigned char *)str, n); }
static char ob[400000]; static unsigned ob_n; static int passes, max_take;
static void drain(void) {
    static char b[RX_UP_BLOCK + 1];
    ob_n = 0; ob[0] = 0; passes = 0; max_take = 0;
    while (rx_want_output(&S) && passes < 100000) {
        int k = rx_take_output(&S, b, sizeof b - 1);
        passes++;
        if (k < 0) break;
        if (k > max_take) max_take = k;
        memcpy(ob + ob_n, b, (size_t)k); ob_n += (unsigned)k; ob[ob_n] = 0;
    }
}
static void hello4(void) { feed("WEBADF 4 " KEY "\n"); drain(); }
static int lines_starting(const char *prefix) {
    int n = 0; const char *p = ob; size_t k = strlen(prefix);
    while (*p) { if (strncmp(p, prefix, k) == 0) n++; p = strchr(p, '\n'); if (!p) break; p++; }
    return n;
}

/* --- Task 1: the hello and the switch --- */
static void a_protocol_4_hello_answers_both_switches(void) {
    setup(1, 1); hello4(); CHECK(strcmp(ob, "READY 4 1 1\n") == 0, ob);
    CHECK(rx_write_on(&S), "writing on");
    setup(1, 0); hello4(); CHECK(strcmp(ob, "READY 4 1 0\n") == 0, ob);
    CHECK(!rx_write_on(&S), "writing off");
    setup(0, 1); hello4(); CHECK(strcmp(ob, "READY 4 0 0\n") == 0, "writing needs browsing");
    CHECK(!rx_write_on(&S), "off without browsing");
    setup(1, 1); feed("WEBADF 4 " KEY2 "\n"); drain(); CHECK(strcmp(ob, "READY 4 0 0\n") == 0, "another key: neither");
    setup(1, 1); feed("WEBADF 9 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 4 1 1\n") == 0, "a newer board is answered as 4");
}
static void older_hellos_are_answered_as_before(void) {
    setup(1, 1); feed("WEBADF 3 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, ob);
    CHECK(!rx_write_on(&S), "never writes on protocol 3");
    setup(1, 1); feed("WEBADF 2 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 2\n") == 0, ob);
    setup(1, 1); feed("WEBADF 1\n"); drain(); CHECK(strcmp(ob, "READY 1\n") == 0, ob);
}
static void a_changed_write_switch_makes_the_hello_stale(void) {
    setup(1, 1); hello4();
    CHECK(!rx_hello_stale(&S), "as said");
    Q.write = 0; CHECK(rx_hello_stale(&S), "writing off: close, so the board hears READY 4 1 0");
    Q.write = 1; CHECK(!rx_hello_stale(&S), "back");
    Q.browse = 0; CHECK(rx_hello_stale(&S), "browsing off takes writing with it");
    setup(1, 0); feed("WEBADF 3 " KEY "\n"); drain(); Q.write = 1;
    CHECK(!rx_hello_stale(&S), "protocol 3 never hears the write flag");
}

/* --- Task 2: the extended FILE (spec §2.2) --- */
static void file4(char *dst, const char *id, const char *data, unsigned long len, const char *path, const char *mode) {
    unsigned long crc = rx_crc32_update(0, (const unsigned char *)data, len);
    sprintf(dst, "FILE %s %lu %lx 40 %u:%s 4:note%s%s\n", id, len, crc, (unsigned)strlen(path), path, mode[0] ? " " : "", mode);
}
static int has(const char *name) { return ff_find(&F, name) >= 0; }
static int holds(const char *name, const char *data) {
    int i = ff_find(&F, name);
    return i >= 0 && F.e[i].len == strlen(data) && memcmp(F.e[i].data, data, strlen(data)) == 0;
}
static void an_absolute_file_lands_on_its_volume(void) {
    char l[400];
    setup(1, 1); ff_add(&F, "Work:Tools", 1); hello4();
    file4(l, "f1", "hello", 5, "Work:Tools/x.txt", "keep"); feed(l); drain();
    CHECK(strcmp(ob, "GO f1\n") == 0, ob);
    CHECK(has("Work:Tools/" RX_TMP_NAME), "written through the temporary file in the target drawer");
    feed("hello"); drain();
    CHECK(strcmp(ob, "OK f1 16:Work:Tools/x.txt\n") == 0, ob);
    CHECK(holds("Work:Tools/x.txt", "hello") && !has("Work:Tools/" RX_TMP_NAME), "renamed, temp gone");
    { int i = ff_find(&F, "Work:Tools/x.txt"); CHECK(i >= 0 && F.e[i].prot == 0x40 && strcmp(F.e[i].comment, "note") == 0, "meta"); }
    { int i = last_ev(RX_EV_DONE); CHECK(i >= 0 && strcmp(ev_path[i], "Work:Tools/x.txt") == 0, "the owner sees the path"); }
    file4(l, "f2", "x", 1, "Floppy:x", "keep"); feed(l); feed("x"); drain();
    CHECK(strcmp(ob, "GO f2\nOK f2 8:Floppy:x\n") == 0, "the root of a volume");
    file4(l, "f3", "x", 1, "DF0:y", "keep"); feed(l); feed("x"); drain();
    CHECK(strcmp(ob, "GO f3\nOK f3 5:DF0:y\n") == 0, "by device name");
}
static void missing_drawers_are_made(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "f1", "ab", 2, "Work:New/Deep/y.txt", "keep"); feed(l); feed("ab"); drain();
    CHECK(strcmp(ob, "GO f1\nOK f1 19:Work:New/Deep/y.txt\n") == 0, ob);
    CHECK(has("Work:New") && has("Work:New/Deep") && holds("Work:New/Deep/y.txt", "ab"), "made");
}
static void keep_picks_a_free_name(void) {
    char l[400];
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); hello4();
    file4(l, "k", "new", 3, "Work:Keep.txt", "keep"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO k\nOK k 15:Work:Keep_2.txt\n") == 0, ob);
    CHECK(holds("Work:Keep.txt", "old") && holds("Work:Keep_2.txt", "new"), "both");
}
static void replace_swaps_only_after_the_crc_matched(void) {
    char l[400];
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); hello4();
    file4(l, "r", "nex", 3, "Work:Keep.txt", "replace"); feed(l); feed("new"); drain();   /* the CRC of other bytes */
    CHECK(strcmp(ob, "GO r\nERR r crc checksum mismatch\n") == 0, ob);
    CHECK(holds("Work:Keep.txt", "old") && !has("Work:" RX_TMP_NAME), "the old one untouched");
    file4(l, "r2", "new!", 4, "Work:Keep.txt", "replace"); feed(l); feed("new!"); drain();
    CHECK(strcmp(ob, "GO r2\nOK r2 13:Work:Keep.txt\n") == 0, ob);
    CHECK(holds("Work:Keep.txt", "new!") && !has("Work:Keep_2.txt") && !has("Work:" RX_TMP_NAME), "replaced in place");
}
static void replace_keeps_the_old_file_when_it_cannot_be_deleted(void) {
    char l[400]; int i;
    setup(1, 1); i = ff_put(&F, "Work:Locked", "old", 3, 1, ""); (void)i; hello4();   /* prot bit 0: the d-bit is off */
    file4(l, "r", "new", 3, "Work:Locked", "replace"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO r\nERR r denied dos error 222\n") == 0, ob);
    CHECK(holds("Work:Locked", "old") && !has("Work:" RX_TMP_NAME), "old kept, temp removed");
    i = ff_put(&F, "Work:Open", "old", 3, 0, ""); F.e[i].busy = 1;
    file4(l, "r2", "new", 3, "Work:Open", "replace"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO r2\nERR r2 busy dos error 202\n") == 0, ob);
    CHECK(holds("Work:Open", "old") && !has("Work:" RX_TMP_NAME), "old kept, temp removed");
    { int k = last_ev(RX_EV_FAILED); CHECK(k >= 0 && strcmp(ev_text[k], "dos error 202") == 0, "the owner sees why"); }
}
static void skip_answers_skip_and_takes_no_bytes(void) {
    char l[400];
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); hello4();
    file4(l, "s", "new", 3, "Work:Keep.txt", "skip"); feed(l); drain();
    CHECK(strcmp(ob, "SKIP s\n") == 0, ob);
    CHECK(!rx_busy(&S), "no bytes awaited");
    feed("PING\n"); drain(); CHECK(strcmp(ob, "PONG\n") == 0, "the next line is a line");
    CHECK(holds("Work:Keep.txt", "old") && !has("Work:" RX_TMP_NAME), "untouched");
    { int k = last_ev(RX_EV_SKIP); CHECK(k >= 0 && strcmp(ev_id[k], "s") == 0 && strcmp(ev_path[k], "Work:Keep.txt") == 0, "the owner sees it"); }
}
static void skip_on_a_new_name_writes_it(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "s", "new", 3, "Work:Fresh", "skip"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO s\nOK s 10:Work:Fresh\n") == 0, ob);
}
static void a_drawer_of_that_name(void) {
    char l[400];
    setup(1, 1); ff_add(&F, "Work:D", 1); hello4();
    file4(l, "a", "x", 1, "Work:D", "replace"); feed(l); drain();
    CHECK(strcmp(ob, "ERR a denied a drawer has that name\n") == 0, ob);
    file4(l, "b", "x", 1, "Work:D", "skip"); feed(l); drain(); CHECK(strcmp(ob, "SKIP b\n") == 0, ob);
    file4(l, "c", "x", 1, "Work:D", "keep"); feed(l); feed("x"); drain(); CHECK(strcmp(ob, "GO c\nOK c 8:Work:D_2\n") == 0, ob);
    CHECK(has("Work:D") && F.e[ff_find(&F, "Work:D")].is_dir, "the drawer stays");
}
static void writing_off_is_readonly(void) {
    char l[400];
    file4(l, "w", "x", 1, "Work:x", "keep");
    setup(1, 0); hello4(); feed(l); drain(); CHECK(strcmp(ob, "ERR w readonly writing is off in Transfer\n") == 0, ob);
    setup(0, 1); hello4(); feed(l); drain(); CHECK(strcmp(ob, "ERR w readonly writing is off in Transfer\n") == 0, "browsing off");
    setup(1, 1); feed("WEBADF 3 " KEY "\n"); drain(); feed(l); drain();
    CHECK(strcmp(ob, "ERR w readonly writing is off in Transfer\n") == 0, "protocol 3");
    setup(1, 1); feed("WEBADF 4 " KEY2 "\n"); drain(); feed(l); drain();
    CHECK(strcmp(ob, "ERR w readonly writing is off in Transfer\n") == 0, "another key");
    CHECK_EQ_INT(F.writes, 0);
    { int k = last_ev(RX_EV_FAILED); CHECK(k >= 0 && strcmp(ev_text[k], "writing is off in Transfer") == 0, "the owner sees it"); }
}
static void bad_absolute_files(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "a", "x", 1, "Work:x", ""); feed(l); drain(); CHECK(strcmp(ob, "ERR a name bad request\n") == 0, "no mode");
    file4(l, "b", "x", 1, "x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR b name bad request\n") == 0, "a relative path with a mode");
    file4(l, "c", "x", 1, "Work:", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR c name bad name\n") == 0, "the root");
    file4(l, "d", "x", 1, "Work:../x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR d name bad name\n") == 0, "dotdot");
    file4(l, "e", "x", 1, "Work:x", "overwrite"); feed(l); drain(); CHECK(strcmp(ob, "ERR e name bad request\n") == 0, "an unknown mode");
    file4(l, "f", "x", 1, "Work:x", "keep junk"); feed(l); drain(); CHECK(strcmp(ob, "ERR f name bad request\n") == 0, "after the mode");
    file4(l, "g", "x", 1, "Nope:x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR g folder no such volume\n") == 0, "not mounted");
    file4(l, "h", "x", 1, "ENVARC:x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR h folder no such volume\n") == 0, "an assign");
    F.vols_fail = 1;
    file4(l, "i", "x", 1, "Work:x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR i folder cannot read the volume list\n") == 0, ob);
    CHECK_EQ_INT(F.writes, 0);
}
static void a_write_protected_disk_is_wprot(void) {
    char l[400];
    setup(1, 1); strcpy(F.wprot, "Floppy:"); hello4();
    file4(l, "p", "x", 1, "Floppy:x", "keep"); feed(l); drain();
    CHECK(strcmp(ob, "ERR p wprot dos error 214\n") == 0, ob);
    file4(l, "q", "x", 1, "Floppy:D/x", "keep"); feed(l); drain();
    CHECK(strcmp(ob, "ERR q wprot dos error 214\n") == 0, "the drawer cannot be made either");
}
static void a_full_volume_is_full(void) {
    char l[400];
    setup(1, 1); F.vol_free = 8192 + 2; hello4();
    file4(l, "a", "abc", 3, "Work:x", "keep"); feed(l); drain(); CHECK(strcmp(ob, "ERR a full not enough space\n") == 0, ob);
    file4(l, "b", "ab", 2, "Work:x", "keep"); feed(l); feed("ab"); drain(); CHECK(strcmp(ob, "GO b\nOK b 6:Work:x\n") == 0, "it fits");
}
static void a_disk_full_mid_write_is_full(void) {
    char l[400];
    setup(1, 1); F.fail_write_after = 2; F.write_err = FF_DISK_FULL; hello4();
    file4(l, "a", "abcd", 4, "Work:x", "keep"); feed(l); feed("abcd"); drain();
    CHECK(strcmp(ob, "GO a\nERR a full dos error 221\n") == 0, ob);
    CHECK(!has("Work:" RX_TMP_NAME) && !has("Work:x"), "nothing left");
}
static void the_relative_file_is_unchanged(void) {
    char l[400];
    setup(1, 1); F.free = 20000; F.vol_free = 0; hello4();
    file4(l, "a", "abc", 3, "In.txt", ""); feed(l); feed("abc"); drain();
    CHECK(strcmp(ob, "GO a\nOK a 6:In.txt\n") == 0, "into ReceiveDir, whatever the volumes' free space");
    F.free = 8192 + 2;
    file4(l, "b", "abc", 3, "Big.txt", ""); feed(l); drain(); CHECK(strcmp(ob, "ERR b space not enough space\n") == 0, ob);
    setup(1, 1); F.fail_write_after = 1; F.write_err = FF_DISK_FULL; hello4();
    file4(l, "c", "abc", 3, "In.txt", ""); feed(l); feed("abc"); drain();
    CHECK(strcmp(ob, "GO c\nERR c write cannot write\n") == 0, "a relative path keeps its code");
}

int main(void) {
    RUN(a_protocol_4_hello_answers_both_switches); RUN(older_hellos_are_answered_as_before);
    RUN(a_changed_write_switch_makes_the_hello_stale);
    RUN(an_absolute_file_lands_on_its_volume); RUN(missing_drawers_are_made); RUN(keep_picks_a_free_name);
    RUN(replace_swaps_only_after_the_crc_matched); RUN(replace_keeps_the_old_file_when_it_cannot_be_deleted);
    RUN(skip_answers_skip_and_takes_no_bytes); RUN(skip_on_a_new_name_writes_it); RUN(a_drawer_of_that_name);
    RUN(writing_off_is_readonly); RUN(bad_absolute_files); RUN(a_write_protected_disk_is_wprot);
    RUN(a_full_volume_is_full); RUN(a_disk_full_mid_write_is_full); RUN(the_relative_file_is_unchanged);
    (void)feedn; (void)lines_starting; (void)last_ev; (void)ff_put;
    return REPORT();
}
