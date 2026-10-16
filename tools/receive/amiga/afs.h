#ifndef AFS_H
#define AFS_H
#include <dos/dos.h>
#include "rx_proto.h"
typedef struct afs_ctx { char root[256]; BPTR fh; } afs_ctx;
void afs_init(afs_ctx *c, rx_fs *fs, const char *root);
void afs_set_root(afs_ctx *c, const char *root);
#endif
