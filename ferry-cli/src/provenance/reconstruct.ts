import { constants, promises as fsp } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import pLimit from 'p-limit';
import { md5File } from './md5.js';

export interface ReconstructItem { path: string; sourceFile: string; md5: string }

/**
 * Verify the cache source's MD5, then CoW-copy into the clone (COPYFILE_FICLONE:
 * reflink on APFS, silent full-copy fallback elsewhere). Real copies, never
 * hardlinks - an agent editing the clone must never write through into the
 * shared cache. Failures are returned; the caller demotes them to a bridge fetch.
 */
export async function reconstruct(items: ReconstructItem[], docroot: string): Promise<{ failed: ReconstructItem[] }> {
  const limit = pLimit(8);
  const failed: ReconstructItem[] = [];
  await Promise.all(items.map((item) => limit(async () => {
    const dest = resolve(docroot, item.path);
    // Ensure the destination is contained within docroot to prevent path traversal
    if (!dest.startsWith(resolve(docroot) + sep)) {
      failed.push(item);
      return;
    }
    if ((await md5File(item.sourceFile)) !== item.md5) {
      failed.push(item);
      return;
    }
    try {
      await fsp.mkdir(dirname(dest), { recursive: true });
      await fsp.copyFile(item.sourceFile, dest, constants.COPYFILE_FICLONE);
    } catch {
      failed.push(item);
    }
  })));
  return { failed };
}
