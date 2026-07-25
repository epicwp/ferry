import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyOverlay, finalizeClone, generateHtaccessFallback, generateMuPlugin, generateNginxFallback,
  generateWpConfig, neutralizeDropIns, phpScalar,
} from '../src/overlay.js';
import type { SiteInfo } from '../src/profile.js';

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 0 },
  server: 'nginx',
  constants: {
    WP_DEBUG: true,
    WP_ENVIRONMENT_TYPE: 'production',
    WP_MEMORY_LIMIT: '256M',
    WP_CONTENT_DIR: '/home/u/public_html/wp-content',  // path constant: must not carry
    SOME_PLUGIN_PATH: '/home/u/private/keys',           // absolute path value: must not carry
    WP_CACHE: true,                                     // forced false locally
    COOKIE_DOMAIN: '.wasgeurtje.nl',                    // production domain: must not carry
  },
  multisite: false,
  prefix: 'wpx_',
  abspath: '/home/u/public_html/',
  siteurl: 'https://wasgeurtje.nl',
  ...over,
});

describe('phpScalar', () => {
  it('encodes scalars as php literals', () => {
    expect(phpScalar(true)).toBe('true');
    expect(phpScalar(42)).toBe('42');
    expect(phpScalar(null)).toBe('null');
    expect(phpScalar("it's")).toBe("'it\\'s'");
    expect(phpScalar({})).toBeNull();
  });
});

describe('generateWpConfig', () => {
  const config = generateWpConfig(info(), 'https://wasgeurtje-nl.ddev.site');

  it('uses ddev credentials and the production prefix', () => {
    expect(config).toContain("define('DB_NAME', 'db');");
    expect(config).toContain("define('DB_HOST', 'db');");
    expect(config).toContain("$table_prefix = 'wpx_';");
  });

  it('carries production constants but skips path-like and overridden ones', () => {
    expect(config).toContain("define('WP_DEBUG', true);");
    expect(config).toContain("define('WP_ENVIRONMENT_TYPE', 'production');");
    expect(config).toContain("define('WP_MEMORY_LIMIT', '256M');");
    expect(config).not.toContain('WP_CONTENT_DIR');
    expect(config).not.toContain('SOME_PLUGIN_PATH');
    expect(config).not.toContain('COOKIE_DOMAIN');
    expect(config).toContain("define('WP_CACHE', false);");
    expect(config).toContain("define('DISABLE_WP_CRON', true);");
    expect(config).toContain("define('FERRY_LOCAL_URL', 'https://wasgeurtje-nl.ddev.site');");
  });

  it('generates all eight local salts and boots wp', () => {
    for (const key of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
      'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) {
      expect(config).toContain(`define('${key}',`);
    }
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
  });
});

describe('generateMuPlugin', () => {
  it('maps urls at runtime and seals the harness', () => {
    const mu = generateMuPlugin();
    expect(mu).toContain("add_filter('pre_option_siteurl'");
    expect(mu).toContain("add_filter('pre_option_home'");
    expect(mu).toContain("add_filter('pre_wp_mail', '__return_false')");
    expect(mu).toContain("add_filter('pre_http_request'");
    expect(mu).not.toContain('fn ('); // must stay old-PHP-safe: runs on production's PHP version
    expect(mu).not.toContain('fn(');
  });

  it('mu-plugin consults the stub registry before blocking', () => {
    const mu = generateMuPlugin();
    expect(mu).toContain("function_exists('ferry_stub_response')");
    expect(mu).toContain('[ferry-harness] stubbed: ');
    expect(mu.indexOf('ferry_stub_response')).toBeLessThan(mu.indexOf('ferry_blocked'));
  });
});

describe('uploads fallback config', () => {
  it('nginx fallback routes missing uploads to the materializing script', () => {
    const conf = generateNginxFallback();
    expect(conf).toContain('try_files $uri @ferry_fallback');
    expect(conf).toContain('/ferry-uploads-fallback.php?path=$1');
    expect(conf).not.toContain('302');
  });

  it('htaccess fallback rewrites to the materializing script', () => {
    const block = generateHtaccessFallback();
    expect(block).toContain('/ferry-uploads-fallback.php?path=$1');
    expect(block).not.toContain('R=302');
  });
});

describe('filesystem phases', () => {
  let docroot: string;

  beforeEach(() => {
    docroot = mkdtempSync(join(tmpdir(), 'ferry-docroot-'));
    mkdirSync(join(docroot, 'wp-content'), { recursive: true });
  });

  afterEach(() => rmSync(docroot, { recursive: true, force: true }));

  it('applyOverlay writes config, mu-plugin, and nginx snippet before provision', async () => {
    await applyOverlay(docroot, info(), 'https://x.ddev.site');
    expect(existsSync(join(docroot, 'wp-config.php'))).toBe(true);
    expect(existsSync(join(docroot, 'wp-content/mu-plugins/ferry-overlay.php'))).toBe(true);
    expect(existsSync(join(docroot, '.ddev/nginx/ferry-uploads.conf'))).toBe(true);
  });

  it('applyOverlay copies the stubs asset into mu-plugins', async () => {
    await applyOverlay(docroot, info(), 'https://clone.ddev.site');
    const copied = readFileSync(join(docroot, 'wp-content', 'mu-plugins', 'ferry-stubs.php'), 'utf8');
    expect(copied).toContain('function ferry_stub_response');
  });

  it('applyOverlay bakes the production origin into the fallback script', async () => {
    await applyOverlay(docroot, info(), 'https://clone.ddev.site');
    const script = readFileSync(join(docroot, 'ferry-uploads-fallback.php'), 'utf8');
    expect(script).toContain("'https://wasgeurtje.nl'"); // origin of the fixture's siteurl
    expect(script).not.toContain('__FERRY_PROD_ORIGIN__');
  });

  it('neutralizeDropIns renames known drop-ins idempotently', () => {
    writeFileSync(join(docroot, 'wp-content/object-cache.php'), '<?php // redis');
    writeFileSync(join(docroot, 'wp-content/advanced-cache.php'), '<?php // rocket');
    const renamed = neutralizeDropIns(docroot);
    expect(renamed.sort()).toEqual(['advanced-cache.php', 'object-cache.php']);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php'))).toBe(false);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(neutralizeDropIns(docroot)).toEqual([]); // second run: nothing left to do
  });

  it('neutralizeDropIns replaces a stale .ferry-disabled with a re-transferred active drop-in on re-pull', () => {
    writeFileSync(join(docroot, 'wp-content/object-cache.php'), '<?php // fresh redis');
    writeFileSync(join(docroot, 'wp-content/object-cache.php.ferry-disabled'), '<?php // stale');
    const renamed = neutralizeDropIns(docroot);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php'))).toBe(false);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(readFileSync(join(docroot, 'wp-content/object-cache.php.ferry-disabled'), 'utf8')).toBe('<?php // fresh redis');
    expect(renamed).toContain('object-cache.php');
  });

  it('finalizeClone prepends the htaccess fallback on apache and preserves pulled rules', async () => {
    writeFileSync(join(docroot, '.htaccess'), '# BEGIN WordPress\n');
    await finalizeClone(docroot, info({ server: 'apache' }));
    const htaccess = readFileSync(join(docroot, '.htaccess'), 'utf8');
    expect(htaccess).toContain('# BEGIN ferry-uploads-fallback');
    expect(htaccess.indexOf('ferry-uploads-fallback')).toBeLessThan(htaccess.indexOf('BEGIN WordPress'));
    await finalizeClone(docroot, info({ server: 'apache' })); // idempotent
    const again = readFileSync(join(docroot, '.htaccess'), 'utf8');
    expect(again.match(/# BEGIN ferry-uploads-fallback/g)).toHaveLength(1);
  });
});
