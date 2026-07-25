import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coreZipUrl, downloadZip, fetchCoreChecksums, pluginZipUrl, themeZipUrl,
} from '../src/provenance/wporg.js';
import { startMockWporg, zipOf, type MockWporg } from './helpers/mockWporg.js';

describe('wporg', () => {
  let mock: MockWporg;
  afterEach(() => mock?.close());

  it('builds the documented URL shapes', () => {
    const ep = { api: 'https://api.wordpress.org', downloads: 'https://downloads.wordpress.org' };
    expect(coreZipUrl(ep, '6.8.2', 'en_US')).toBe('https://downloads.wordpress.org/release/wordpress-6.8.2.zip');
    expect(coreZipUrl(ep, '6.8.2', 'nl_NL')).toBe('https://downloads.wordpress.org/release/nl_NL/wordpress-6.8.2-nl_NL.zip');
    expect(pluginZipUrl(ep, 'akismet', '5.3.7')).toBe('https://downloads.wordpress.org/plugin/akismet.5.3.7.zip');
    expect(themeZipUrl(ep, 'twentytwentyfive', '1.2')).toBe('https://downloads.wordpress.org/theme/twentytwentyfive.1.2.zip');
  });

  it('fetches core checksums for the requested locale', async () => {
    mock = await startMockWporg({ checksums: { '6.8.2-nl_NL': { 'wp-includes/a.php': 'abc' } } });
    const result = await fetchCoreChecksums(mock.endpoints, '6.8.2', 'nl_NL');
    expect(result).toEqual({ checksums: { 'wp-includes/a.php': 'abc' }, locale: 'nl_NL' });
  });

  it('falls back to en_US when the locale build has no checksums', async () => {
    mock = await startMockWporg({ checksums: { '6.8.2-en_US': { 'wp-includes/a.php': 'abc' } } });
    const result = await fetchCoreChecksums(mock.endpoints, '6.8.2', 'nl_NL');
    expect(result?.locale).toBe('en_US');
  });

  it('returns null when the API answers checksums:false for every locale', async () => {
    mock = await startMockWporg({ checksums: {} });
    expect(await fetchCoreChecksums(mock.endpoints, '9.9.9', 'nl_NL')).toBeNull();
  });

  it('returns null (never throws) when wp.org is unreachable', async () => {
    const ep = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };
    expect(await fetchCoreChecksums(ep, '6.8.2', 'en_US')).toBeNull();
    expect(await downloadZip('http://127.0.0.1:1/plugin/x.1.0.zip')).toBeNull();
  });

  it('downloads a zip and 404s become null', async () => {
    mock = await startMockWporg({ zips: { '/plugin/akismet.5.3.7.zip': zipOf('akismet', { 'akismet.php': '<?php' }) } });
    const buf = await downloadZip(`${mock.endpoints.downloads}/plugin/akismet.5.3.7.zip`);
    expect(buf).not.toBeNull();
    expect(Object.keys(unzipSync(new Uint8Array(buf!)))).toContain('akismet/akismet.php');
    expect(await downloadZip(`${mock.endpoints.downloads}/plugin/nope.1.0.zip`)).toBeNull();
  });
});
