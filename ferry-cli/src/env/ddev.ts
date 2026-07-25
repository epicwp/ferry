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

export interface CloneEnv {
  provision(clonePath: string, info: SiteInfo, name: string): Promise<void>;
  importDb(clonePath: string, dumpFile: string): Promise<void>;
  createAdmin(clonePath: string): Promise<{ user: string; password: string }>;
  url(name: string): string;
}

export class DdevEnv implements CloneEnv {
  async provision(clonePath: string, info: SiteInfo, name: string): Promise<void> {
    await fsp.mkdir(join(clonePath, '.ddev'), { recursive: true });
    await fsp.writeFile(join(clonePath, '.ddev', 'config.yaml'), ddevConfig(info, name));
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
}
