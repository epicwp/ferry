import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SiteInfo } from '../profile.js';

const run = promisify(execFile);

export function majorMinor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** §2.5: parity is the core of usability - PHP, DB flavor+version, webserver. */
export function ddevConfig(info: SiteInfo, name: string): string {
  return [
    `name: ${name}`,
    'type: wordpress',
    'docroot: ""',
    `php_version: "${majorMinor(info.php.version)}"`,
    `webserver_type: ${info.server === 'apache' ? 'apache-fpm' : 'nginx-fpm'}`,
    'database:',
    `  type: ${info.db.server}`,
    `  version: "${majorMinor(info.db.version)}"`,
    'disable_settings_management: true', // ferry generates wp-config itself (§4.4)
    '',
  ].join('\n');
}

/** Binlog pins doc (Task 1): enables log_bin so the journal (Task 10) can extract row events. */
export const BINLOG_CNF = [
  '[mysqld]',
  'log-bin=ferry-bin',
  'binlog-format=ROW',
  'binlog-row-image=FULL',
  'server-id=1',
  'expire-logs-days=14',
  '',
].join('\n');

export interface TableColumns {
  fields: string[];
  pkCols: string[];
}

/** `SHOW COLUMNS FROM <table>` is `Field\tType\tNull\tKey\tDefault\tExtra` - Key='PRI' marks a
 *  primary-key column (every column of a composite key is marked, not just one). */
export function parseShowColumns(stdout: string): TableColumns {
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.length > 0);
  const fields: string[] = [];
  const pkCols: string[] = [];
  for (const line of lines) {
    const [field, , , key] = line.split('\t');
    fields.push(field);
    if (key === 'PRI') pkCols.push(field);
  }
  return { fields, pkCols };
}

export interface CloneEnv {
  provision(clonePath: string, info: SiteInfo, name: string): Promise<void>;
  importDb(clonePath: string, dumpFile: string): Promise<void>;
  createAdmin(clonePath: string): Promise<{ user: string; password: string }>;
  url(name: string): string;
  binlogPosition(clonePath: string): Promise<{ file: string; position: number }>;
  extractBinlog(clonePath: string, pos: { file: string; position: number }): Promise<string>;
  showColumns(clonePath: string, table: string): Promise<TableColumns>;
  /** Ship the docroot to wherever the clone is served. Local envs serve in place: no-op. */
  deployFiles(clonePath: string): Promise<void>;
  /** Tear down everything provision() created for this clone name. */
  destroy(name: string): Promise<void>;
}

export class DdevEnv implements CloneEnv {
  async provision(clonePath: string, info: SiteInfo, name: string): Promise<void> {
    await fsp.mkdir(join(clonePath, '.ddev'), { recursive: true });
    await fsp.writeFile(join(clonePath, '.ddev', 'config.yaml'), ddevConfig(info, name));
    await fsp.mkdir(join(clonePath, '.ddev', 'mysql'), { recursive: true });
    await fsp.writeFile(join(clonePath, '.ddev', 'mysql', 'ferry-binlog.cnf'), BINLOG_CNF);
    await run('ddev', ['start', '-y'], { cwd: clonePath });
  }

  async importDb(clonePath: string, dumpFile: string): Promise<void> {
    await run('ddev', ['import-db', `--file=${dumpFile}`], { cwd: clonePath });
  }

  /** §4.6: a working admin requires a local user - customer passwords never come along. */
  async createAdmin(clonePath: string): Promise<{ user: string; password: string }> {
    const password = randomBytes(9).toString('base64url');
    await run(
      'ddev',
      ['wp', 'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
        '--role=administrator', `--user_pass=${password}`],
      { cwd: clonePath },
    );
    return { user: 'ferry-admin', password };
  }

  url(name: string): string {
    return `https://${name}.ddev.site`;
  }

  /** Pins doc: `SHOW BINLOG STATUS` (current non-deprecated name on MariaDB 10.5+). */
  async binlogPosition(clonePath: string): Promise<{ file: string; position: number }> {
    const { stdout } = await run('ddev', ['mysql', '-e', 'SHOW BINLOG STATUS'], { cwd: clonePath });
    const [file, position] = stdout.trim().split('\n')[1].split('\t');
    return { file, position: Number(position) };
  }

  /** Pins doc: db-container mysqlbinlog, `-s db` and `--no-defaults` are both load-bearing. */
  async extractBinlog(clonePath: string, pos: { file: string; position: number }): Promise<string> {
    const { stdout } = await run(
      'ddev',
      [
        'exec', '-s', 'db',
        'mysqlbinlog', '--no-defaults', '--base64-output=decode-rows', '-v',
        `--start-position=${pos.position}`,
        `/var/lib/mysql/${pos.file}`,
      ],
      { cwd: clonePath },
    );
    return stdout;
  }

  async showColumns(clonePath: string, table: string): Promise<TableColumns> {
    const { stdout } = await run('ddev', ['mysql', '-e', `SHOW COLUMNS FROM ${table}`], { cwd: clonePath });
    return parseShowColumns(stdout);
  }

  async deployFiles(): Promise<void> {} // DDEV serves the docroot in place

  async destroy(): Promise<void> {} // matches today's behavior: site delete never removed DDEV projects
}
