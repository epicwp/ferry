import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPluginZip } from '../src/plugin-zip.js';
import { makeApp, signup } from './helpers/testApp.js';

const PLUGIN_DIR = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));

describe('plugin zip', () => {
  it('packs the plugin under ferry-connect/ without dev files', () => {
    const zip = buildPluginZip(PLUGIN_DIR);
    const entries = Object.keys(unzipSync(new Uint8Array(zip)));
    expect(entries).toContain('ferry-connect/ferry.php');
    expect(entries.some((e) => e.startsWith('ferry-connect/src/'))).toBe(true);
    expect(entries.some((e) => e.includes('/vendor/') || e.includes('/tests/'))).toBe(false);
    expect(entries.every((e) => e.startsWith('ferry-connect/'))).toBe(true);
    expect(entries.some((e) => e.split('/').some((part) => part.startsWith('.')))).toBe(false);
  });

  it('serves the zip to signed-in users only', async () => {
    const { app } = makeApp({ pluginZip: buildPluginZip(PLUGIN_DIR) });
    let res = await app.inject({ method: 'GET', url: '/api/plugin.zip' });
    expect(res.statusCode).toBe(401);
    const cookie = await signup(app);
    res = await app.inject({ method: 'GET', url: '/api/plugin.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('ferry-connect.zip');
  });
});
