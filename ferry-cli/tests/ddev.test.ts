import { describe, expect, it } from 'vitest';
import { BINLOG_CNF, ddevConfig, majorMinor } from '../src/env/ddev.js';
import type { SiteInfo } from '../src/profile.js';

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: ['gd'], ini: { memory_limit: '256M' } },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: 'utf8mb4_unicode_520_ci', bytes: 52428800 },
  server: 'nginx',
  constants: {},
  multisite: false,
  prefix: 'wp_',
  abspath: '/home/u/public_html/',
  siteurl: 'https://wasgeurtje.nl',
  ...over,
});

describe('majorMinor', () => {
  it('truncates to major.minor', () => {
    expect(majorMinor('8.2.15')).toBe('8.2');
    expect(majorMinor('10.6.16')).toBe('10.6');
  });
});

describe('ddevConfig', () => {
  it('renders production parity into ddev yaml', () => {
    const yaml = ddevConfig(info(), 'wasgeurtje-nl');
    expect(yaml).toContain('name: wasgeurtje-nl');
    expect(yaml).toContain('type: wordpress');
    expect(yaml).toContain('php_version: "8.2"');
    expect(yaml).toContain('webserver_type: nginx-fpm');
    expect(yaml).toContain('type: mariadb');
    expect(yaml).toContain('version: "10.6"');
    expect(yaml).toContain('disable_settings_management: true');
  });

  it('maps apache to apache-fpm', () => {
    expect(ddevConfig(info({ server: 'apache' }), 'x')).toContain('webserver_type: apache-fpm');
  });
});

describe('BINLOG_CNF', () => {
  it('matches the Task 1 pins doc verbatim', () => {
    expect(BINLOG_CNF).toBe([
      '[mysqld]',
      'log-bin=ferry-bin',
      'binlog-format=ROW',
      'binlog-row-image=FULL',
      'server-id=1',
      'expire-logs-days=14',
      '',
    ].join('\n'));
  });
});
