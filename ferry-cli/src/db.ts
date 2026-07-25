import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FerryClient } from './client.js';

export interface TableInfo {
  name: string;
  rows: number;
  bytes: number;
  pk: string | null;
  maxpk: number | null;
}

/** Lite-pull rule names; must stay in sync with the plugin's DbExcludes::NAMES. */
export const LITE_SKIP = ['revisions', 'transients', 'sessions', 'as_logs', 'as_completed'];

export async function pullDatabase(client: FerryClient, dumpDir: string, skip: string[] = []): Promise<string> {
  await fsp.mkdir(dumpDir, { recursive: true });
  const { data } = await client.getJson('/ferry/v1/db/tables');
  const tables = data.tables as TableInfo[];
  const parts: string[] = [];
  for (const table of tables) {
    const file = join(dumpDir, `${table.name}.sql`);
    await fsp.writeFile(file, '');
    let after = 0;
    for (;;) {
      const query: Record<string, string> = { table: table.name, after: String(after) };
      if (skip.length > 0) {
        query.skip = skip.join(',');
      }
      if (table.maxpk !== null) {
        query.before = String(table.maxpk); // §3.5: snapshot bound fixed at export start
      }
      const { buffer, headers } = await client.getBuffer('/ferry/v1/db', query);
      if (skip.length > 0 && headers['x-ferry-skip'] !== skip.join(',')) {
        throw new Error(
          'the Ferry Connect plugin on the site does not support lite pulls - update the plugin on the site, or re-run with --full',
        );
      }
      await fsp.appendFile(file, gunzipSync(buffer));
      if (headers['x-complete'] === '1') {
        break;
      }
      const last = Number(headers['x-last-key']);
      if (!Number.isFinite(last) || last <= after) {
        throw new Error(`database export of ${table.name} made no progress - aborting`);
      }
      after = last;
    }
    parts.push(file);
  }
  const combined = join(dumpDir, 'dump.sql');
  await fsp.writeFile(combined, 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n');
  for (const part of parts) {
    await fsp.appendFile(combined, await fsp.readFile(part));
  }
  return combined;
}
