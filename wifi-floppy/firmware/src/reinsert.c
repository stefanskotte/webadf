#include "reinsert.h"
#include <string.h>

void reinsert_init(reinsert_t *r) {
    memset(r, 0, sizeof *r);
}

bool reinsert_on_wprot(reinsert_t *r, bool mounted, const char *disk_id, bool wprot) {
    if (!mounted) { r->known = false; return false; }
    const bool same = r->known && strcmp(r->disk_id, disk_id) == 0;
    const bool flip = same && r->wprot != wprot;
    r->known = true;
    r->wprot = wprot;
    strncpy(r->disk_id, disk_id, sizeof r->disk_id - 1);
    r->disk_id[sizeof r->disk_id - 1] = '\0';
    return flip;
}
