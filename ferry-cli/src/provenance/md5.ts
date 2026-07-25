import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streaming MD5 of a file; null on any read error (incl. ENOENT). */
export async function md5File(path: string): Promise<string | null> {
  try {
    const hash = createHash('md5');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
