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
    setup(1, 1); feed("WEBADF 4 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 4 1 1\n") == 0, "protocol 4 as in 2.5");
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
/* Final review I1: the old file is gone and the new one cannot take its name -- the new copy must survive. */
static void replace_never_loses_both_copies(void) {
    char l[400];
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); strcpy(F.fail_rename_to, "Work:Keep.txt"); hello4();
    file4(l, "r", "new", 3, "Work:Keep.txt", "replace"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO r\nOK r 15:Work:Keep_2.txt\n") == 0, ob);
    CHECK(holds("Work:Keep_2.txt", "new"), "the new copy under a free name");
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); F.fail_renames = 1; hello4();
    file4(l, "s", "new", 3, "Work:Keep.txt", "replace"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO s\nERR s write dos error 203; the new copy is Work:.webadf-rx\n") == 0, ob);
    CHECK(holds("Work:" RX_TMP_NAME, "new"), "the temporary file is kept");
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
/* FS-UAE 3.2: a file open for writing (an exclusive lock) cannot be locked to look at, yet it exists. */
static void a_file_in_use_still_exists(void) {
    char l[400]; int i;
    setup(1, 1); i = ff_put(&F, "Work:Open", "old", 3, 0, ""); F.e[i].busy = 1; hello4();
    file4(l, "s", "new", 3, "Work:Open", "skip"); feed(l); drain();
    CHECK(strcmp(ob, "SKIP s\n") == 0, ob);
    file4(l, "k", "new", 3, "Work:Open", "keep"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO k\nOK k 11:Work:Open_2\n") == 0, ob);
    file4(l, "r", "new", 3, "Work:Open", "replace"); feed(l); feed("new"); drain();
    CHECK(strcmp(ob, "GO r\nERR r busy dos error 202\n") == 0, ob);
    CHECK(holds("Work:Open", "old"), "kept");
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

/* --- Task 3: MKDIR, RENAME, DELETE, PROTECT, NOTE (spec §2.3) --- */
static const char *req(const char *line) { feed(line); drain(); return ob; }
static void mkdir_makes_one_level(void) {
    setup(1, 1); hello4();
    CHECK(strcmp(req("MKDIR m1 8:Work:New\n"), "DONE m1 1\n") == 0, ob);
    CHECK(has("Work:New") && F.e[ff_find(&F, "Work:New")].is_dir, "made");
    CHECK(strcmp(req("MKDIR m2 8:Work:New\n"), "ERR m2 exists 13:dos error 203\n") == 0, ob);
    CHECK(strcmp(req("MKDIR m3 11:Work:No/Sub\n"), "ERR m3 notfound 13:dos error 205\n") == 0, "one level only");
    strcpy(F.wprot, "Floppy:");
    CHECK(strcmp(req("MKDIR m4 10:Floppy:New\n"), "ERR m4 wprot 13:dos error 214\n") == 0, ob);
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_code[i], "mkdir") == 0 && strcmp(ev_text[i], "dos error 214") == 0, "the owner sees it"); }
}
static void rename_within_a_volume_and_across_drawers(void) {
    setup(1, 1); ff_put(&F, "Work:a.txt", "a", 1, 0, ""); ff_add(&F, "Work:Tools", 1); hello4();
    CHECK(strcmp(req("RENAME r1 10:Work:a.txt 10:Work:b.txt\n"), "DONE r1 1\n") == 0, ob);
    CHECK(!has("Work:a.txt") && holds("Work:b.txt", "a"), "renamed");
    CHECK(strcmp(req("RENAME r2 10:Work:b.txt 16:Work:Tools/b.txt\n"), "DONE r2 1\n") == 0, "moved to another drawer");
    CHECK(holds("Work:Tools/b.txt", "a"), "moved");
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_code[i], "rename") == 0 && strcmp(ev_path[i], "Work:b.txt") == 0 &&
                                         strcmp(ev_to[i], "Work:Tools/b.txt") == 0, "the owner sees both"); }
    CHECK(strcmp(req("RENAME r3 9:Work:Nope 9:Work:Else\n"), "ERR r3 notfound 13:dos error 205\n") == 0, ob);
}
static void rename_across_volumes_is_xvol(void) {
    int w;
    setup(1, 1); ff_put(&F, "Work:a", "a", 1, 0, ""); hello4(); w = F.writes;
    CHECK(strcmp(req("RENAME x1 6:Work:a 8:Floppy:a\n"), "ERR x1 xvol 30:rename works within one volume\n") == 0, ob);
    CHECK_EQ_INT(F.writes, w);
    CHECK(strcmp(req("RENAME x2 6:Work:a 5:DH0:b\n"), "DONE x2 1\n") == 0, ob);
    CHECK(strcmp(req("RENAME x3 5:DH0:b 9:Nowhere:b\n"), "ERR x3 notfound 13:dos error 205\n") == 0, "a target volume that is not mounted");
    CHECK(strcmp(rx_err_code(215, 1), "xvol") == 0, "DOS 215");
}
static void rename_onto_an_existing_name_is_exists(void) {
    setup(1, 1); ff_put(&F, "Work:a", "a", 1, 0, ""); ff_put(&F, "Work:b", "b", 1, 0, ""); hello4();
    CHECK(strcmp(req("RENAME e1 6:Work:a 6:Work:b\n"), "ERR e1 exists 13:dos error 203\n") == 0, ob);
    CHECK(holds("Work:a", "a") && holds("Work:b", "b"), "both kept");
}
static void protect_sets_the_bits(void) {
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello4();
    CHECK(strcmp(req("PROTECT p1 6:Work:x 45\n"), "DONE p1 1\n") == 0, ob);
    CHECK(F.e[ff_find(&F, "Work:x")].prot == 0x45, "set");
    CHECK(strcmp(req("PROTECT p2 6:Work:x zz\n"), "ERR p2 bad 11:bad request\n") == 0, "not hex");
    CHECK(strcmp(req("PROTECT p3 6:Work:x\n"), "ERR p3 bad 11:bad request\n") == 0, "no bits");
    CHECK(strcmp(req("PROTECT p4 6:Work:y 0\n"), "ERR p4 notfound 13:dos error 205\n") == 0, ob);
}
static void note_sets_the_comment(void) {
    char l[300], c80[81];
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, "old"); hello4();
    CHECK(strcmp(req("NOTE n1 6:Work:x 13:a new comment\n"), "DONE n1 1\n") == 0, ob);
    CHECK(strcmp(F.e[ff_find(&F, "Work:x")].comment, "a new comment") == 0, "set");
    CHECK(strcmp(req("NOTE n2 6:Work:x 0:\n"), "DONE n2 1\n") == 0, "an empty comment clears it");
    CHECK(F.e[ff_find(&F, "Work:x")].comment[0] == 0, "cleared");
    memset(c80, 'c', 80); c80[80] = 0;
    sprintf(l, "NOTE n3 6:Work:x 80:%s\n", c80);
    CHECK(strcmp(req(l), "ERR n3 bad 11:bad request\n") == 0, "80 bytes: one too many");
    c80[79] = 0; sprintf(l, "NOTE n4 6:Work:x 79:%s\n", c80);
    CHECK(strcmp(req(l), "DONE n4 1\n") == 0, "79 bytes");
    CHECK(strcmp(req("NOTE n5 6:Work:x 3:a\x01" "b\n"), "ERR n5 bad 11:bad request\n") == 0, "a control byte");
}
static void delete_a_file_is_done_1(void) {
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello4();
    CHECK(strcmp(req("DELETE d1 6:Work:x\n"), "DONE d1 1\n") == 0, ob);
    CHECK(!has("Work:x"), "gone");
    CHECK(strcmp(req("DELETE d2 6:Work:x\n"), "ERR d2 notfound 13:dos error 205\n") == 0, "no DEL before a file's ERR");
    ff_put(&F, "Work:L", "x", 1, 1, "");
    CHECK(strcmp(req("DELETE d3 6:Work:L\n"), "ERR d3 denied 13:dos error 222\n") == 0, "nothing is forced (W3)");
    CHECK(has("Work:L"), "kept");
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_code[i], "delete") == 0, "the owner sees it"); }
}
static void delete_a_drawer_of_300_paces_del_every_50(void) {
    char nm[40]; int i;
    setup(1, 1); ff_add(&F, "Work:Old", 1);
    for (i = 0; i < 300; i++) { sprintf(nm, "Work:Old/f%03d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello4();
    req("DELETE big 8:Work:Old\n");
    CHECK(strcmp(ob, "DEL big 50\nDEL big 100\nDEL big 150\nDEL big 200\nDEL big 250\nDEL big 300\nDONE big 301\n") == 0, ob);
    CHECK_EQ_INT(F.n, 2);   /* Work: and Floppy: */
    CHECK(max_take <= RX_OUT_MAX, "never more than the 1 KB buffer");
    CHECK(passes >= 300 / RX_DEL_PASS, "a few steps per pass: the loop keeps answering");
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && ev[k].size == 301 && !ev_has_text[k] && strcmp(ev_path[k], "Work:Old") == 0, "the owner sees 301"); }
}
static void delete_a_nested_tree(void) {
    setup(1, 1);
    ff_add(&F, "Work:T", 1); ff_add(&F, "Work:T/a", 1); ff_add(&F, "Work:T/a/b", 1);
    ff_put(&F, "Work:T/a/b/f", "x", 1, 0, ""); ff_put(&F, "Work:T/a/g", "x", 1, 0, ""); ff_put(&F, "Work:T/h", "x", 1, 0, "");
    ff_add(&F, "Work:T/empty", 1); ff_put(&F, "Work:Tail", "keep", 4, 0, "");
    hello4();
    CHECK(strcmp(req("DELETE t 6:Work:T\n"), "DONE t 7\n") == 0, ob);
    CHECK(!has("Work:T") && !has("Work:T/a/b/f") && holds("Work:Tail", "keep"), "only the tree");
}
static void a_protected_entry_stops_the_delete(void) {
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "x", 1, 0, "");
    ff_add(&F, "Work:D/Sub", 1); ff_put(&F, "Work:D/Sub/locked", "x", 1, 1, "");
    hello4();
    req("DELETE s 6:Work:D\n");
    CHECK(strcmp(ob, "DEL s 1\nERR s denied 25:Sub/locked: dos error 222\n") == 0, ob);
    CHECK(has("Work:D/Sub/locked") && has("Work:D/Sub") && !has("Work:D/a"), "stopped at the first refusal");
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && strcmp(ev_path[k], "Work:D") == 0 && ev[k].size == 1, "the owner sees the named path and the count"); }
    CHECK(!F.dir_open, "no drawer left open");
}
static void a_delete_that_stops_at_once_sends_del_0(void) {
    int i;
    setup(1, 1); ff_add(&F, "Work:D", 1); i = ff_put(&F, "Work:D/open", "x", 1, 0, ""); F.e[i].busy = 1; hello4();
    CHECK(strcmp(req("DELETE s 6:Work:D\n"), "DEL s 0\nERR s busy 19:open: dos error 202\n") == 0, ob);
    setup(1, 1); i = ff_add(&F, "Work:E", 1); F.e[i].prot = 1; hello4();
    CHECK(strcmp(req("DELETE s 6:Work:E\n"), "DEL s 0\nERR s denied 13:dos error 222\n") == 0, "the drawer itself: Fault's words only");
}
/* Final review C1: a link inside a drawer, or the named path itself being a link, is removed as a link; what it points
   to is never entered (AmigaDOS resolves a path through a link to its target). */
static void a_delete_never_follows_a_link(void) {
    int i;
    setup(1, 1);
    ff_add(&F, "Work:Sys", 1); ff_put(&F, "Work:Sys/x.library", "x", 1, 0, ""); ff_put(&F, "Work:Sys/y", "y", 1, 0, "");
    ff_add(&F, "Work:Old", 1); ff_put(&F, "Work:Old/f", "f", 1, 0, "");
    i = ff_add(&F, "Work:Old/Libs", 1); strcpy(F.e[i].link_to, "Work:Sys");
    i = ff_add(&F, "Work:Alias", 1); strcpy(F.e[i].link_to, "Work:Sys");
    hello4();
    CHECK(strcmp(req("DELETE d 8:Work:Old\n"), "DONE d 3\n") == 0, ob);
    CHECK(holds("Work:Sys/x.library", "x") && holds("Work:Sys/y", "y"), "the link's target untouched");
    CHECK(!has("Work:Old") && !has("Work:Old/Libs"), "the drawer and the link gone");
    CHECK(strcmp(req("DELETE a 10:Work:Alias\n"), "DONE a 1\n") == 0, ob);
    CHECK(!has("Work:Alias") && holds("Work:Sys/x.library", "x"), "a named link: only the link");
}
static void out_of_memory_mid_delete_is_io(void) {
    char nm[40]; int i;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 10; i++) { sprintf(nm, "Work:D/f%d", i); ff_put(&F, nm, "", 0, 0, ""); }
    F.dir_err_at = 6; F.dir_err = 103; hello4();   /* the first open looks the named drawer up in Work: */
    CHECK(strcmp(req("DELETE m 6:Work:D\n"), "DEL m 4\nERR m io 13:dos error 103\n") == 0, ob);
}
static void write_paths_are_checked_before_any_hook(void) {
    setup(1, 1); ff_put(&F, "ENVARC:x", "x", 1, 0, ""); ff_add(&F, "CON:", 1); hello4();
    CHECK(strcmp(req("DELETE a 5:Work:\n"), "ERR a bad 11:bad request\n") == 0, "a volume root (W4)");
    CHECK(strcmp(req("DELETE b 8:ENVARC:x\n"), "ERR b notfound 13:dos error 205\n") == 0, "an assign");
    CHECK(strcmp(req("MKDIR c 5:CON:x\n"), "ERR c notfound 13:dos error 205\n") == 0, "a handler");
    CHECK(strcmp(req("RENAME d 7:Floppy: 7:Floppy:x\n"), "ERR d bad 11:bad request\n") == 0, "relabel is not rename");
    CHECK(strcmp(req("DELETE e 9:Work:../x\n"), "ERR e bad 11:bad request\n") == 0, "dotdot");
    CHECK(strcmp(req("PROTECT f 1:x 0\n"), "ERR f bad 11:bad request\n") == 0, "relative");
    CHECK(strcmp(req("NOTE g 6:Work:/ 0:\n"), "ERR g bad 11:bad request\n") == 0, "a bare slash");
    CHECK_EQ_INT(F.writes, 0); CHECK_EQ_INT(F.dir_opens, 0); CHECK(has("ENVARC:x"), "kept");
}
static void write_requests_while_writing_is_off_are_readonly(void) {
    setup(1, 0); ff_put(&F, "Work:x", "x", 1, 0, ""); hello4();
    CHECK(strcmp(req("DELETE a 6:Work:x\n"), "ERR a readonly 26:writing is off in Transfer\n") == 0, ob);
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_code[i], "delete") == 0 && strcmp(ev_text[i], "writing is off in Transfer") == 0, "the owner sees it"); }
    setup(0, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello4();
    CHECK(strcmp(req("MKDIR b 6:Work:y\n"), "ERR b readonly 26:writing is off in Transfer\n") == 0, "browsing off");
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); feed("WEBADF 3 " KEY "\n"); drain();
    CHECK(strcmp(req("NOTE c 6:Work:x 0:\n"), "ERR c readonly 26:writing is off in Transfer\n") == 0, "protocol 3");
    CHECK(strcmp(req("DIR d 5:Work:\n"), "ENT d f 1 0 0.0.0 1:x 0:\nDONE d 1\n") == 0, "reads still answered");
    CHECK_EQ_INT(F.writes, 0); CHECK(has("Work:x"), "kept");
}
static void switching_writing_off_stops_a_delete_between_steps(void) {
    static char b[RX_UP_BLOCK + 1]; char nm[40]; int i, k;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 20; i++) { sprintf(nm, "Work:D/f%02d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello4(); feed("DELETE w 6:Work:D\n");
    k = rx_take_output(&S, b, sizeof b - 1); (void)k;   /* the first pass removes RX_DEL_PASS entries */
    Q.write = 0;
    drain();
    CHECK(strcmp(ob, "DEL w 4\nERR w readonly 26:writing is off in Transfer\n") == 0, ob);
    CHECK_EQ_INT(F.n, 2 + 1 + 20 - RX_DEL_PASS);
    CHECK(rx_hello_stale(&S), "then the board hears READY 4 1 0");
}
static void a_lost_connection_ends_a_delete(void) {
    static char b[RX_UP_BLOCK + 1]; char nm[40]; int i, n;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 20; i++) { sprintf(nm, "Work:D/f%02d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello4(); feed("DELETE w 6:Work:D\n");
    rx_take_output(&S, b, sizeof b - 1);
    rx_disconnected(&S); n = F.n;
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && strcmp(ev_text[k], "connection lost") == 0 && strcmp(ev_path[k], "Work:D") == 0, "the owner is told"); }
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q); hello4();
    CHECK(strcmp(ob, "READY 4 1 1\n") == 0, ob);
    CHECK_EQ_INT(F.n, n); CHECK(!F.dir_open, "nothing open");
}
static void a_write_request_waits_behind_a_file(void) {
    setup(1, 1); ff_put(&F, "DH0:One", "1", 1, 0, ""); rx_up_add(&Q, "DH0:One", "One"); hello4();
    CHECK(strncmp(ob, "READY 4 1 1\nPUT 1 1 ", 20) == 0, ob);
    feed("MKDIR m 6:Work:N\n"); drain(); CHECK(!has("Work:N"), "waits while the file is going up");
    feed("TAKE 1 0 1\n"); drain(); feed("DONE 1 3:One\n"); drain();
    CHECK(strcmp(ob, "DONE m 1\n") == 0, ob); CHECK(has("Work:N"), "then made");
}
static void malformed_write_requests_are_bad(void) {
    setup(1, 1); hello4();
    CHECK(strcmp(req("MKDIR\n"), "ERR - bad 11:bad request\n") == 0, ob);
    CHECK(strcmp(req("MKDIR m\n"), "ERR m bad 11:bad request\n") == 0, "no path");
    CHECK(strcmp(req("MKDIR m 6:Work:x junk\n"), "ERR m bad 11:bad request\n") == 0, "after the path");
    CHECK(strcmp(req("RENAME r 6:Work:a\n"), "ERR r bad 11:bad request\n") == 0, "no target");
    CHECK(strcmp(req("RENAME r 6:Work:a 1:b\n"), "ERR r bad 11:bad request\n") == 0, "a relative target");
    CHECK(strcmp(req("NOTE n 6:Work:a\n"), "ERR n bad 11:bad request\n") == 0, "no comment");
    CHECK(strcmp(req("PROTECT p 6:Work:a 123456789\n"), "ERR p bad 11:bad request\n") == 0, "over 32 bits");
    CHECK(strcmp(req("DELETE d 99:Work:a\n"), "ERR d bad 11:bad request\n") == 0, "a length past the line");
}
static void the_owners_words_for_writes(void) {
    rx_event e; char w[100];
    memset(&e, 0, sizeof e); e.kind = RX_EV_REQ;
    e.code = "mkdir"; e.path = "Work:New"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "made Work:New") == 0, w);
    e.code = "rename"; e.path = "Work:a"; e.to = "Work:b"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "renamed Work:a to Work:b") == 0, w);
    e.code = "delete"; e.path = "Work:old"; e.size = 37; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "deleted Work:old (37)") == 0, w);
    e.code = "protect"; e.path = "Work:x"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "protected Work:x") == 0, w);
    e.code = "note"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "comment on Work:x") == 0, w);
    e.text = "dos error 214";
    e.code = "mkdir"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not make Work:x: dos error 214") == 0, w);
    e.code = "rename"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not rename Work:x: dos error 214") == 0, w);
    e.code = "delete"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not delete Work:x: dos error 214") == 0, w);
    e.code = "protect"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not protect Work:x: dos error 214") == 0, w);
    e.code = "note"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not comment on Work:x: dos error 214") == 0, w);
    e.code = "dir"; e.text = NULL; e.size = 0; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "listed Work:x") == 0, "reads unchanged");
}
static void write_error_codes(void) {
    CHECK(strcmp(rx_err_code(203, 1), "exists") == 0, "203"); CHECK(strcmp(rx_err_code(214, 1), "wprot") == 0, "214");
    CHECK(strcmp(rx_err_code(221, 1), "full") == 0, "221"); CHECK(strcmp(rx_err_code(222, 1), "denied") == 0, "222");
    CHECK(strcmp(rx_err_code(223, 1), "denied") == 0, "223"); CHECK(strcmp(rx_err_code(224, 0), "denied") == 0, "224 as before");
    CHECK(strcmp(rx_err_code(226, 1), "io") == 0, "226 as before"); CHECK(strcmp(rx_err_code(216, 1), "io") == 0, "216");
}

/* --- Transfer 2.6, protocol 5 (spec §9) --- */
static void hello5(void) { feed("WEBADF 5 " KEY "\n"); drain(); }
static void a_protocol_5_hello(void) {
    setup(1, 1); hello5(); CHECK(strcmp(ob, "READY 5 1 1\n") == 0, ob); CHECK(rx_write_on(&S), "writing on");
    setup(1, 0); hello5(); CHECK(strcmp(ob, "READY 5 1 0\n") == 0, ob);
    setup(0, 1); hello5(); CHECK(strcmp(ob, "READY 5 0 0\n") == 0, ob);
    setup(1, 1); feed("WEBADF 5 " KEY2 "\n"); drain(); CHECK(strcmp(ob, "READY 5 0 0\n") == 0, "another key");
    setup(1, 1); feed("WEBADF 9 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 5 1 1\n") == 0, "a newer board is answered as 5");
    setup(1, 1); hello5(); Q.write = 0; CHECK(rx_hello_stale(&S), "the write flag is heard on 5 too");
}
static void delete_one_a_file(void) {
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); ff_put(&F, "Work:y", "y", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE o 6:Work:x one\n"), "DONE o 1\n") == 0, ob);
    CHECK(!has("Work:x") && holds("Work:y", "y"), "only x");
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_code[i], "delete") == 0 && ev[i].size == 1 && strcmp(ev_path[i], "Work:x") == 0, "the owner sees it"); }
}
static void delete_one_an_empty_drawer(void) {
    setup(1, 1); ff_add(&F, "Work:E", 1); hello5();
    CHECK(strcmp(req("DELETE o 6:Work:E one\n"), "DONE o 1\n") == 0, ob);
    CHECK(!has("Work:E"), "gone");
}
static void delete_one_a_full_drawer_is_notempty(void) {
    int n;
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "a", 1, 0, ""); ff_add(&F, "Work:D/Sub", 1);
    ff_put(&F, "Work:D/Sub/b", "b", 1, 0, ""); ff_add(&F, "Work:D/Empty", 1); hello5(); n = F.n;
    CHECK(strcmp(req("DELETE o 6:Work:D one\n"), "ERR o notempty 13:dos error 216\n") == 0, ob);
    CHECK_EQ_INT(F.n, n);
    CHECK(holds("Work:D/a", "a") && holds("Work:D/Sub/b", "b") && has("Work:D/Empty") && has("Work:D"), "nothing inside touched");
    { int i = last_ev(RX_EV_REQ); CHECK(i >= 0 && strcmp(ev_text[i], "dos error 216") == 0 && strcmp(ev_path[i], "Work:D") == 0, "the owner is told"); }
}
static void delete_one_a_link(void) {
    int i;
    setup(1, 1); ff_add(&F, "Work:Sys", 1); ff_put(&F, "Work:Sys/x.library", "x", 1, 0, "");
    i = ff_add(&F, "Work:Alias", 1); strcpy(F.e[i].link_to, "Work:Sys"); hello5();
    CHECK(strcmp(req("DELETE o 10:Work:Alias one\n"), "DONE o 1\n") == 0, ob);
    CHECK(!has("Work:Alias") && holds("Work:Sys/x.library", "x") && has("Work:Sys"), "only the link");
}
static void delete_one_refusals(void) {
    int i;
    setup(1, 1); ff_put(&F, "Work:L", "x", 1, 1, ""); hello5();
    CHECK(strcmp(req("DELETE o 6:Work:L one\n"), "ERR o denied 13:dos error 222\n") == 0, ob); CHECK(has("Work:L"), "kept");
    CHECK(strcmp(req("DELETE o 6:Work:N one\n"), "ERR o notfound 13:dos error 205\n") == 0, ob);
    i = ff_put(&F, "Work:B", "x", 1, 0, ""); F.e[i].busy = 1;
    CHECK(strcmp(req("DELETE o 6:Work:B one\n"), "ERR o busy 13:dos error 202\n") == 0, ob);
    strcpy(F.wprot, "Floppy:"); ff_put(&F, "Floppy:f", "x", 1, 0, "");
    CHECK(strcmp(req("DELETE o 8:Floppy:f one\n"), "ERR o wprot 13:dos error 214\n") == 0, ob);
    CHECK(strcmp(req("DELETE o 5:Work: one\n"), "ERR o bad 11:bad request\n") == 0, "a volume root");
    setup(1, 0); ff_put(&F, "Work:x", "x", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE o 6:Work:x one\n"), "ERR o readonly 26:writing is off in Transfer\n") == 0, ob);
    CHECK(has("Work:x"), "kept");
}
static void one_on_protocol_4_is_bad(void) {
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello4();
    CHECK(strcmp(req("DELETE o 6:Work:x one\n"), "ERR o bad 11:bad request\n") == 0, ob); CHECK(has("Work:x"), "kept");
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE o 6:Work:x two\n"), "ERR o bad 11:bad request\n") == 0, "another token");
    CHECK(strcmp(req("DELETE o 6:Work:x one one\n"), "ERR o bad 11:bad request\n") == 0, "twice");
    CHECK(strcmp(req("MKDIR o 6:Work:y one\n"), "ERR o bad 11:bad request\n") == 0, "only DELETE takes it");
    CHECK(has("Work:x") && !has("Work:y"), "kept");
}

/* The rename-first drawer delete (spec §9; plan rulings X1-X6). */
static const char *hid(const char *rid, unsigned i) {   /* the hidden name for rid's i-th try */
    static char b[40];
    snprintf(b, sizeof b, ".webadf-del-%08lx", (rx_crc32_update(0, (const unsigned char *)rid, strlen(rid)) + i) & 0xFFFFFFFFUL);
    return b;
}
static int kids(const char *pre) { int i, n = 0; for (i = 0; i < F.n; i++) if (strncmp(F.e[i].name, pre, strlen(pre)) == 0) n++; return n; }
static int hidden_left(void) { int i; for (i = 0; i < F.n; i++) if (strstr(F.e[i].name, ".webadf-del-")) return 1; return 0; }
static void a_drawer_delete_hides_the_drawer_first(void) {
    char nm[40], want[64]; int i;
    setup(1, 1); ff_add(&F, "Work:Old", 1);
    for (i = 0; i < 300; i++) { sprintf(nm, "Work:Old/f%03d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello5();
    req("DELETE big 8:Work:Old\n");
    CHECK(strcmp(ob, "DEL big 50\nDEL big 100\nDEL big 150\nDEL big 200\nDEL big 250\nDEL big 300\nDONE big 301\n") == 0, ob);
    CHECK_EQ_INT(F.renames, 1);
    snprintf(want, sizeof want, "Work:%s", hid("big", 0));
    CHECK(strcmp(F.last_from, "Work:Old") == 0 && strcmp(F.last_to, want) == 0, F.last_to);
    CHECK_EQ_INT((int)strlen(hid("big", 0)), 20);
    CHECK_EQ_INT(F.n, 2);
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && ev[k].size == 301 && !ev_has_text[k] && strcmp(ev_path[k], "Work:Old") == 0, "the owner sees the old name"); }
}
static void a_file_saved_by_the_old_path_survives(void) {
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "a", 1, 0, ""); ff_add(&F, "Work:D/S", 1);
    ff_put(&F, "Work:D/S/b", "b", 1, 0, "");
    strcpy(F.plant, "Work:D/new.txt"); hello5();
    CHECK(strcmp(req("DELETE s 6:Work:D\n"), "DONE s 4\n") == 0, ob);
    CHECK(holds("Work:D/new.txt", "new") && has("Work:D"), "saved meanwhile: kept");
    CHECK(!has("Work:D/a") && !has("Work:D/S/b") && !hidden_left(), "the rest gone");
}
static void a_stop_renames_it_back(void) {
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "x", 1, 0, "");
    ff_add(&F, "Work:D/Sub", 1); ff_put(&F, "Work:D/Sub/locked", "x", 1, 1, "");
    hello5();
    req("DELETE s 6:Work:D\n");
    CHECK(strcmp(ob, "DEL s 1\nERR s denied 25:Sub/locked: dos error 222\n") == 0, ob);
    CHECK(has("Work:D/Sub/locked") && has("Work:D/Sub") && !has("Work:D/a") && !hidden_left(), "back where it was");
    CHECK_EQ_INT(F.renames, 2);
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && strcmp(ev_path[k], "Work:D") == 0 && ev[k].size == 1, "the owner sees the old name"); }
    CHECK(!F.dir_open, "no drawer left open");
}
static void the_old_name_taken_says_where_the_rest_is(void) {
    char want[160], h[64];
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "x", 1, 0, "");
    ff_add(&F, "Work:D/Sub", 1); ff_put(&F, "Work:D/Sub/locked", "x", 1, 1, "");
    strcpy(F.plant, "Work:D/x"); hello5();
    req("DELETE s 6:Work:D\n");
    snprintf(want, sizeof want, "the rest is in %s: Sub/locked: dos error 222", hid("s", 0));
    { char line[200]; snprintf(line, sizeof line, "DEL s 1\nERR s denied %u:%s\n", (unsigned)strlen(want), want);
      CHECK(strcmp(ob, line) == 0, ob); }
    snprintf(h, sizeof h, "Work:%s/Sub/locked", hid("s", 0));
    CHECK(has(h) && holds("Work:D/x", "new"), "both kept: the new drawer and the rest");
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && strcmp(ev_path[k], "Work:D") == 0 && strstr(ev_text[k], "the rest is in .webadf-del-") == ev_text[k], ev_text[k]); }
}
static void a_taken_hidden_name_takes_the_next(void) {
    char h0[64], keep[80], want[64];
    setup(1, 1);
    snprintf(h0, sizeof h0, "Work:%s", hid("t", 0)); ff_add(&F, h0, 1);
    snprintf(keep, sizeof keep, "%s/keep", h0); ff_put(&F, keep, "k", 1, 0, "");
    ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "a", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE t 6:Work:D\n"), "DONE t 2\n") == 0, ob);
    snprintf(want, sizeof want, "Work:%s", hid("t", 1));
    CHECK(strcmp(F.last_to, want) == 0, F.last_to);
    CHECK(holds(keep, "k") && !has("Work:D") && !has(want), "the one there untouched; the next one used and gone");
}
static void the_first_rename_failing_deletes_in_place(void) {
    char p[300]; int i;
    setup(1, 1); ff_add(&F, "Work:T", 1); ff_add(&F, "Work:T/a", 1); ff_put(&F, "Work:T/a/f", "x", 1, 0, "");
    F.rename_err = 223; hello5();
    CHECK(strcmp(req("DELETE t 6:Work:T\n"), "DONE t 3\n") == 0, ob);
    CHECK_EQ_INT(F.renames, 1); CHECK(!has("Work:T") && !has("Work:T/a/f"), "deleted in place");
    setup(1, 1); ff_add(&F, "Work:T", 1); ff_put(&F, "Work:T/f", "x", 1, 0, "");
    F.fail_renames = 1; hello5();
    CHECK(strcmp(req("DELETE t 6:Work:T\n"), "DONE t 2\n") == 0, ob);
    CHECK_EQ_INT(F.renames, 8); CHECK(!has("Work:T"), "eight names taken: in place");
    setup(1, 1); strcpy(p, "Work:");
    for (i = 0; i < 8; i++) { if (i) strcat(p, "/"); strcat(p, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); ff_add(&F, p, 1); }
    strcat(p, "/x"); ff_add(&F, p, 1); hello5();
    { char line[320]; snprintf(line, sizeof line, "DELETE l %u:%s\n", (unsigned)strlen(p), p);
      CHECK(strcmp(req(line), "DONE l 1\n") == 0, ob); }
    CHECK_EQ_INT(F.renames, 0); CHECK(!has(p), "a hidden name past 255 bytes: in place");
}
static void writing_off_mid_delete_renames_it_back(void) {
    static char b[RX_UP_BLOCK + 1]; char nm[40]; int i;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 20; i++) { sprintf(nm, "Work:D/f%02d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello5(); feed("DELETE w 6:Work:D\n");
    rx_take_output(&S, b, sizeof b - 1);
    Q.write = 0;
    drain();
    CHECK(strcmp(ob, "DEL w 4\nERR w readonly 26:writing is off in Transfer\n") == 0, ob);
    CHECK(has("Work:D") && kids("Work:D/") == 20 - RX_DEL_PASS && !hidden_left(), "back where it was");
    CHECK_EQ_INT(F.n, 2 + 1 + 20 - RX_DEL_PASS);
}
static void a_lost_connection_renames_it_back(void) {
    static char b[RX_UP_BLOCK + 1]; char nm[40]; int i;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 20; i++) { sprintf(nm, "Work:D/f%02d", i); ff_put(&F, nm, "", 0, 0, ""); }
    hello5(); feed("DELETE w 6:Work:D\n");
    rx_take_output(&S, b, sizeof b - 1);
    rx_disconnected(&S);
    CHECK(has("Work:D") && kids("Work:D/") == 20 - RX_DEL_PASS && !hidden_left(), "back where it was");
    { int k = last_ev(RX_EV_REQ); CHECK(k >= 0 && strcmp(ev_text[k], "connection lost") == 0 && strcmp(ev_path[k], "Work:D") == 0, "the owner is told the old name"); }
    CHECK(!F.dir_open, "nothing open");
}
static void protocol_4_deletes_in_place(void) {
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/a", "x", 1, 0, "");
    ff_add(&F, "Work:D/Sub", 1); ff_put(&F, "Work:D/Sub/locked", "x", 1, 1, "");
    hello4();
    CHECK(strcmp(req("DELETE s 6:Work:D\n"), "DEL s 1\nERR s denied 25:Sub/locked: dos error 222\n") == 0, ob);
    CHECK_EQ_INT(F.renames, 0);
    setup(1, 1); ff_put(&F, "Work:x", "x", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE f 6:Work:x\n"), "DONE f 1\n") == 0, ob);
    CHECK_EQ_INT(F.renames, 0);   /* a file DELETE is unchanged */
}

/* Final review (Transfer 2.6) minors 3 and 7. */
static void a_stop_restores_the_disks_spelling(void) {
    setup(1, 1); ff_add(&F, "Work:Old", 1); ff_put(&F, "Work:Old/locked", "x", 1, 1, ""); hello5();
    F.nocase = 1;
    req("DELETE s 8:Work:OLD\n");
    CHECK(strcmp(ob, "DEL s 0\nERR s denied 21:locked: dos error 222\n") == 0, ob);
    F.nocase = 0;
    CHECK(has("Work:Old") && has("Work:Old/locked") && !has("Work:OLD") && !hidden_left(), "back as Old, not OLD");
}
static void a_stop_on_the_drawer_itself_renames_it_back(void) {
    int i;
    setup(1, 1); i = ff_add(&F, "Work:E", 1); F.e[i].prot = 1; ff_put(&F, "Work:E/f", "x", 1, 0, ""); hello5();
    CHECK(strcmp(req("DELETE s 6:Work:E\n"), "DEL s 1\nERR s denied 13:dos error 222\n") == 0, ob);
    CHECK(has("Work:E") && !has("Work:E/f") && !hidden_left(), "emptied, and back under its name");
}
static void a_lost_connection_says_where_the_rest_is(void) {
    static char b[RX_UP_BLOCK + 1]; char nm[40]; int i;
    setup(1, 1); ff_add(&F, "Work:D", 1);
    for (i = 0; i < 20; i++) { sprintf(nm, "Work:D/f%02d", i); ff_put(&F, nm, "", 0, 0, ""); }
    strcpy(F.plant, "Work:D/x"); hello5(); feed("DELETE w 6:Work:D\n");
    rx_take_output(&S, b, sizeof b - 1);
    rx_disconnected(&S);
    { int k = last_ev(RX_EV_REQ); char want[80];
      snprintf(want, sizeof want, "the rest is in %s: connection lost", hid("w", 0));
      CHECK(k >= 0 && strcmp(ev_text[k], want) == 0 && strcmp(ev_path[k], "Work:D") == 0, ev_text[k]); }
    CHECK(holds("Work:D/x", "new") && hidden_left(), "both kept");
}
static void the_rest_is_in_is_cut_to_79_bytes(void) {
    const char *deep = "Work:D/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    char pre[64];
    setup(1, 1); ff_add(&F, "Work:D", 1); ff_add(&F, "Work:D/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1); ff_put(&F, deep, "x", 1, 1, "");
    strcpy(F.plant, "Work:D/x"); hello5();
    req("DELETE s 6:Work:D\n");
    snprintf(pre, sizeof pre, "DEL s 0\nERR s denied 79:the rest is in %s: aaaa", hid("s", 0));
    CHECK(strncmp(ob, pre, strlen(pre)) == 0, ob);
    CHECK(strlen(strchr(strstr(ob, "79:"), ':') + 1) == 79 + 1, "79 bytes and the newline");
}

/* --- Transfer 2.7: writing switched off while an absolute FILE is received (plan 2026-11-01-transfer-2-7 Task 1) --- */
static void writing_off_mid_replace_keeps_the_old_file(void) {
    static char data[40000]; char l[400]; int i;
    for (i = 0; i < 40000; i++) data[i] = (char)('a' + i % 26);
    setup(1, 1); ff_put(&F, "Work:Keep.txt", "old", 3, 0, ""); hello4();
    file4(l, "r", data, 40000, "Work:Keep.txt", "replace"); feed(l); drain();
    CHECK(strcmp(ob, "GO r\n") == 0, ob);
    feedn(data, 20000); drain();
    Q.write = 0; rx_switch_changed(&S);
    CHECK(!has("Work:" RX_TMP_NAME), "the temporary file goes at once");
    { long w = F.written; feedn(data + 20000, 19999); drain(); CHECK(ob_n == 0, "nothing answered before the last byte");
      CHECK(F.written == w, "nothing written after the switch"); }
    feedn(data + 39999, 1); drain();
    CHECK(strcmp(ob, "ERR r readonly writing is off in Transfer\n") == 0, ob);
    CHECK(holds("Work:Keep.txt", "old") && !has("Work:" RX_TMP_NAME), "the old file untouched");
    { int k = last_ev(RX_EV_FAILED); CHECK(k >= 0 && strcmp(ev_text[k], "writing is off in Transfer") == 0, "the owner sees it"); }
    CHECK(!rx_busy(&S), "idle");
}
static void browsing_off_stops_it_too(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "k", "abcdef", 6, "Work:New.txt", "keep"); feed(l); feed("abc"); drain();
    Q.browse = 0; Q.write = 0; rx_switch_changed(&S);
    feed("def"); drain();
    CHECK(strcmp(ob, "ERR k readonly writing is off in Transfer\n") == 0, ob);
    CHECK(!has("Work:New.txt") && !has("Work:" RX_TMP_NAME), "nothing lands");
}
static void the_feed_checks_without_the_call(void) {   /* the core is safe even if a front end forgets */
    char l[400];
    setup(1, 1); hello4();
    file4(l, "k", "abcdef", 6, "Work:New.txt", "keep"); feed(l); feed("abc"); drain();
    Q.write = 0;
    { long w = F.written; feed("def"); drain(); CHECK(F.written == w, "not written"); }
    CHECK(strcmp(ob, "ERR k readonly writing is off in Transfer\n") == 0, ob);
    CHECK(!has("Work:New.txt") && !has("Work:" RX_TMP_NAME), "nothing lands");
}
static void back_on_during_the_drain_still_fails(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "k", "abcdef", 6, "Work:New.txt", "keep"); feed(l); feed("ab"); drain();
    Q.write = 0; rx_switch_changed(&S); Q.write = 1; rx_switch_changed(&S);
    feed("cdef"); drain();
    CHECK(strcmp(ob, "ERR k readonly writing is off in Transfer\n") == 0, ob);
    CHECK(!has("Work:New.txt") && !has("Work:" RX_TMP_NAME), "not resumed");
}
static void the_connection_is_usable_after_the_abort(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "k", "abcdef", 6, "Work:New.txt", "keep"); feed(l); feed("abc"); drain();
    Q.write = 0; rx_switch_changed(&S);
    CHECK(!rx_hello_stale(&S), "not while the rest is drained");
    CHECK(feed("def") == 0, "no protocol error"); drain();
    CHECK(feed("PING\n") == 0, "a line after it"); drain(); CHECK(strcmp(ob, "PONG\n") == 0, ob);
    file4(l, "a", "xyz", 3, "In.txt", ""); feed(l); feed("xyz"); drain();
    CHECK(strcmp(ob, "GO a\nOK a 6:In.txt\n") == 0, "a relative file still lands");
    CHECK(rx_hello_stale(&S), "idle now: the board reconnects to hear READY 4 1 0");
    Q.write = 1;
    file4(l, "b", "xyz", 3, "Work:B.txt", "keep"); feed(l); feed("xyz"); drain();
    CHECK(strcmp(ob, "GO b\nOK b 10:Work:B.txt\n") == 0, "and an absolute one once writing is on");
}
static void a_relative_file_ignores_the_switch(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "a", "abcdef", 6, "In.txt", ""); feed(l); feed("abc"); drain();
    Q.write = 0; Q.browse = 0; rx_switch_changed(&S);
    feed("def"); drain();
    CHECK(strcmp(ob, "OK a 6:In.txt\n") == 0, ob);
    CHECK(holds("In.txt", "abcdef"), "ReceiveDir is not the web app's writing");
}
static void a_lost_connection_during_the_drain(void) {
    char l[400];
    setup(1, 1); hello4();
    file4(l, "k", "abcdef", 6, "Work:New.txt", "keep"); feed(l); feed("abc"); drain();
    Q.write = 0; rx_switch_changed(&S);
    { int n0 = n_ev; rx_disconnected(&S);
      CHECK(n_ev == n0 + 1 && ev[n_ev - 1].kind == RX_EV_FAILED, "one FAILED"); }
    CHECK(!has("Work:New.txt") && !has("Work:" RX_TMP_NAME), "nothing lands");
    rx_switch_changed(&S); CHECK(!rx_busy(&S), "a no-op when idle");
}

int main(void) {
    RUN(a_protocol_4_hello_answers_both_switches); RUN(older_hellos_are_answered_as_before);
    RUN(a_changed_write_switch_makes_the_hello_stale);
    RUN(an_absolute_file_lands_on_its_volume); RUN(missing_drawers_are_made); RUN(keep_picks_a_free_name);
    RUN(replace_swaps_only_after_the_crc_matched); RUN(replace_keeps_the_old_file_when_it_cannot_be_deleted);
    RUN(skip_answers_skip_and_takes_no_bytes); RUN(skip_on_a_new_name_writes_it); RUN(a_drawer_of_that_name);
    RUN(a_file_in_use_still_exists); RUN(replace_never_loses_both_copies);
    RUN(writing_off_is_readonly); RUN(bad_absolute_files); RUN(a_write_protected_disk_is_wprot);
    RUN(a_full_volume_is_full); RUN(a_disk_full_mid_write_is_full); RUN(the_relative_file_is_unchanged);
    RUN(mkdir_makes_one_level); RUN(rename_within_a_volume_and_across_drawers); RUN(rename_across_volumes_is_xvol);
    RUN(rename_onto_an_existing_name_is_exists); RUN(protect_sets_the_bits); RUN(note_sets_the_comment);
    RUN(delete_a_file_is_done_1); RUN(delete_a_drawer_of_300_paces_del_every_50); RUN(delete_a_nested_tree);
    RUN(a_protected_entry_stops_the_delete); RUN(a_delete_that_stops_at_once_sends_del_0); RUN(out_of_memory_mid_delete_is_io);
    RUN(a_delete_never_follows_a_link);
    RUN(write_paths_are_checked_before_any_hook); RUN(write_requests_while_writing_is_off_are_readonly);
    RUN(switching_writing_off_stops_a_delete_between_steps); RUN(a_lost_connection_ends_a_delete);
    RUN(a_write_request_waits_behind_a_file); RUN(malformed_write_requests_are_bad); RUN(the_owners_words_for_writes);
    RUN(write_error_codes);
    RUN(writing_off_mid_replace_keeps_the_old_file); RUN(browsing_off_stops_it_too); RUN(the_feed_checks_without_the_call);
    RUN(back_on_during_the_drain_still_fails); RUN(the_connection_is_usable_after_the_abort);
    RUN(a_relative_file_ignores_the_switch); RUN(a_lost_connection_during_the_drain);
    RUN(a_protocol_5_hello); RUN(delete_one_a_file); RUN(delete_one_an_empty_drawer);
    RUN(delete_one_a_full_drawer_is_notempty); RUN(delete_one_a_link); RUN(delete_one_refusals); RUN(one_on_protocol_4_is_bad);
    RUN(a_drawer_delete_hides_the_drawer_first); RUN(a_file_saved_by_the_old_path_survives); RUN(a_stop_renames_it_back);
    RUN(the_old_name_taken_says_where_the_rest_is); RUN(a_taken_hidden_name_takes_the_next);
    RUN(the_first_rename_failing_deletes_in_place); RUN(writing_off_mid_delete_renames_it_back);
    RUN(a_lost_connection_renames_it_back); RUN(protocol_4_deletes_in_place);
    RUN(a_stop_restores_the_disks_spelling); RUN(a_stop_on_the_drawer_itself_renames_it_back);
    RUN(a_lost_connection_says_where_the_rest_is); RUN(the_rest_is_in_is_cut_to_79_bytes);
    (void)feedn; (void)lines_starting; (void)last_ev; (void)ff_put;
    return REPORT();
}
