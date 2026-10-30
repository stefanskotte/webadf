#ifndef AFS_H
#define AFS_H
#include <dos/dos.h>
#include "rx_proto.h"
typedef struct afs_ctx {
    char root[256]; BPTR fh; BPTR rh;
    BPTR dl; struct FileInfoBlock *dfib;   /* the drawer being listed for the web app (protocol 3) */
} afs_ctx;
void afs_init(afs_ctx *c, rx_fs *fs, const char *root);
void afs_set_root(afs_ctx *c, const char *root);
void afs_base_name(const char *path, char *out);   /* rx_base_name: the last part, trailing '/' ignored, or a volume's name */
#endif
