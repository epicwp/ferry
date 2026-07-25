import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const EXCLUDE_TOP = new Set(['tests', 'vendor', 'composer.json', 'composer.lock', 'phpunit.xml']);

/** Dev-time stand-in for a released plugin artifact (spec §2.3). */
export function buildPluginZip(pluginDir: string): Buffer {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = relative(pluginDir, abs);
      if (EXCLUDE_TOP.has(rel.split(sep)[0]!)) continue;
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        files[`ferry-connect/${rel.split(sep).join('/')}`] = readFileSync(abs);
      }
    }
  };
  walk(pluginDir);
  return Buffer.from(zipSync(files));
}
