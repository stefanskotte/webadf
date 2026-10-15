import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertKey, BlobExistsError, type BlobBackend } from './backend';
import { signUpload } from './upload-sig';

const CHUNK = 64 * 1024;

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

function validKey(key: string): boolean {
  try { assertKey(key); return true; } catch { return false; }
}

/**
 * A file as a web stream that opens the file on the first read and CLOSES it
 * when the stream ends, errors or is cancelled.
 *
 * Two measured reasons it is not FileHandle.readableWebStream():
 *  - that does not close its handle by default: on Node 25.8 every read -- to
 *    the end or cancelled -- left one descriptor open (local.test.ts counts
 *    them), and its `autoClose` option is newer than the Nodes this runs on;
 *  - on Node 25 a FileHandle that is garbage-collected while open is an
 *    UNCAUGHT error (ERR_INVALID_STATE), not a warning. A caller that takes a
 *    get() result and never reads the stream (a size check, a 304) would take
 *    the server down. Opening lazily means an unread stream holds nothing.
 */
function fileStream(path: string): ReadableStream<Uint8Array> {
  let fh: FileHandle | null = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (fh) await fh.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        fh ??= await fs.open(path, 'r');
        const buf = new Uint8Array(CHUNK);
        const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(buf.subarray(0, bytesRead));
      } catch (err) {
        await close().catch(() => {});
        controller.error(err);
      }
    },
    async cancel() {
      await close();
    },
    // highWaterMark 0: the default (1) pulls once at construction to fill the
    // queue, which would open the file before anyone asked for a byte.
  }, { highWaterMark: 0 });
}

/**
 * Blobs as plain files under `dir` (self-hosting, spec D6/D8). One file per
 * key at <dir>/<key>, plus a sidecar <file>.meta.json holding { contentType }.
 * Every write goes to a temp file in the same directory first and is fsynced,
 * so a reader never sees a half-written object and a failed upload leaves
 * nothing under the key.
 */
export function localBackend(dir: string): BlobBackend {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    assertKey(key);
    const p = resolve(root, key);
    // Belt and braces after assertKey: the resolved path must stay inside root.
    if (!p.startsWith(root + sep)) throw new Error(`storage: invalid key ${JSON.stringify(key)}`);
    return p;
  };
  const metaOf = (p: string) => `${p}.meta.json`;

  return {
    label: 'Local disk',

    async put(key, body, { contentType, overwrite }) {
      const p = pathOf(key);
      await fs.mkdir(dirname(p), { recursive: true });
      const tmp = join(dirname(p), `.tmp-${randomUUID()}`);
      try {
        const fh = await fs.open(tmp, 'wx');
        try {
          if (body instanceof Uint8Array) {
            await fh.writeFile(body);
          } else {
            const reader = body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await fh.write(value);
            }
          }
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.writeFile(`${tmp}.meta.json`, JSON.stringify({ contentType }));
        if (overwrite) {
          await fs.rename(`${tmp}.meta.json`, metaOf(p));
          await fs.rename(tmp, p);
        } else {
          // link() fails with EEXIST atomically: exactly one concurrent writer wins.
          try {
            await fs.link(tmp, p);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new BlobExistsError(key);
            throw e;
          }
          await fs.rename(`${tmp}.meta.json`, metaOf(p));
        }
      } finally {
        await fs.rm(tmp, { force: true });
        await fs.rm(`${tmp}.meta.json`, { force: true });
      }
    },

    async get(key) {
      const p = pathOf(key);
      let size: number;
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) return null;
        size = st.size;
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
      const meta = JSON.parse(await fs.readFile(metaOf(p), 'utf8').catch(() => '{}')) as { contentType?: string };
      return { stream: fileStream(p), contentType: meta.contentType ?? null, sizeBytes: size };
    },

    async head(key) {
      try {
        const st = await fs.stat(pathOf(key));
        return st.isFile() ? { sizeBytes: st.size, uploadedAt: st.mtime } : null;
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
    },

    async del(key) {
      const p = pathOf(key);
      await fs.rm(p, { force: true });
      await fs.rm(metaOf(p), { force: true });
    },

    // One directory level: every store lists a flat namespace ('adf/',
    // 'cover/'), so a recursive walk would only add cost.
    async *list(prefix) {
      const dirKey = prefix.replace(/\/$/, '');
      const base = pathOf(dirKey);
      let names: string[];
      try {
        names = await fs.readdir(base);
      } catch (e) {
        if (isEnoent(e)) return;
        throw e;
      }
      for (const n of names) {
        const key = `${dirKey}/${n}`;
        // Skips temp files (.tmp-*), sidecars (*.meta.json) and anything else
        // that is not a key this backend could have written.
        if (!validKey(key)) continue;
        try {
          const st = await fs.stat(join(base, n));
          if (st.isFile()) yield { key, uploadedAt: st.mtime };
        } catch (e) {
          if (!isEnoent(e)) throw e; // deleted between readdir and stat
        }
      }
    },

    async uploadUrl(key, { maxBytes, ttlMs }) {
      assertKey(key);
      return signUpload(key, maxBytes, ttlMs);
    },
  };
}
