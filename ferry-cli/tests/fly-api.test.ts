import { describe, expect, it } from 'vitest';
import { FlyApi, type FlyFetch } from '../src/env/fly-api.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Records every call; replays `responses` in order (last one repeats once exhausted). */
function fakeFetch(calls: Recorded[], responses: Array<{ status: number; body: unknown }>): FlyFetch {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { status: r.status, json: async () => r.body };
  };
}

const TOKEN = 'org-token-abc';

describe('FlyApi.createApp', () => {
  it('POSTs the app to the Machines API with a bearer token and the spike body shape', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi({ token: TOKEN }, fakeFetch(calls, [{ status: 200, body: { id: 'a', created_at: 1 } }]));
    await api.createApp('ferry-s-wasgeurtje-nl-abc123', 'personal');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0].body!)).toEqual({ app_name: 'ferry-s-wasgeurtje-nl-abc123', org_slug: 'personal' });
  });
});

describe('FlyApi.allocateIps', () => {
  it('issues shared_v4 then v6 GraphQL mutations; a null ipAddress on shared_v4 is success', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi(
      { token: TOKEN },
      fakeFetch(calls, [
        { status: 200, body: { data: { allocateIpAddress: { ipAddress: null } } } },
        { status: 200, body: { data: { allocateIpAddress: { ipAddress: { address: '2a09:...', type: 'v6' } } } } },
      ]),
    );
    await expect(api.allocateIps('ferry-s-x')).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('https://api.fly.io/graphql');
      expect(call.method).toBe('POST');
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const first = JSON.parse(calls[0].body!);
    expect(first.variables).toEqual({ input: { appId: 'ferry-s-x', type: 'shared_v4' } });
    expect(first.query).toContain('allocateIpAddress');
    const second = JSON.parse(calls[1].body!);
    expect(second.variables).toEqual({ input: { appId: 'ferry-s-x', type: 'v6' } });
  });

  it('throws when the GraphQL response carries an errors array, even with no ipAddress', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi(
      { token: TOKEN },
      fakeFetch(calls, [{ status: 200, body: { errors: [{ message: 'app not found' }] } }]),
    );
    await expect(api.allocateIps('ferry-s-x')).rejects.toThrow(/app not found/);
  });
});

describe('FlyApi.createVolume', () => {
  it('POSTs the volume and surfaces the returned id', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi(
      { token: TOKEN },
      fakeFetch(calls, [{ status: 200, body: { id: 'vol_abc123', name: 'data', encrypted: true } }]),
    );
    const result = await api.createVolume('ferry-s-x', 'data', 'ams', 3);
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/ferry-s-x/volumes');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'data', size_gb: 3, region: 'ams' });
    expect(result).toEqual({ id: 'vol_abc123' });
  });
});

describe('FlyApi.createMachine', () => {
  it('POSTs region + config and surfaces the returned id', async () => {
    const calls: Recorded[] = [];
    const config = { image: 'ghcr.io/epicwp/ferry-site-runtime', guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 } };
    const api = new FlyApi(
      { token: TOKEN },
      fakeFetch(calls, [{ status: 200, body: { id: 'm_123', private_ip: 'fdaa::1' } }]),
    );
    const result = await api.createMachine('ferry-s-x', 'ams', config);
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/ferry-s-x/machines');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ region: 'ams', config });
    expect(result).toEqual({ id: 'm_123' });
  });
});

describe('FlyApi.waitStarted', () => {
  it('GETs the wait endpoint with state=started&timeout=60', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi({ token: TOKEN }, fakeFetch(calls, [{ status: 200, body: { ok: true, state: 'started' } }]));
    await api.waitStarted('ferry-s-x', 'm_123');
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/ferry-s-x/machines/m_123/wait?state=started&timeout=60');
    expect(calls[0].method).toBe('GET');
  });
});

describe('FlyApi.destroyApp', () => {
  it('DELETEs the app with force=true', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi({ token: TOKEN }, fakeFetch(calls, [{ status: 202, body: {} }]));
    await api.destroyApp('ferry-s-x');
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/ferry-s-x?force=true');
    expect(calls[0].method).toBe('DELETE');
  });
});

describe('non-2xx responses', () => {
  it('throws an Error naming the method, URL, and status', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi({ token: TOKEN }, fakeFetch(calls, [{ status: 422, body: { error: 'nope' } }]));
    await expect(api.createApp('x', 'personal')).rejects.toThrow(/POST.*https:\/\/api\.machines\.dev\/v1\/apps.*422/);
  });
});

describe('config overrides', () => {
  it('uses custom apiBase/graphqlBase when provided', async () => {
    const calls: Recorded[] = [];
    const api = new FlyApi(
      { token: TOKEN, apiBase: 'https://custom.example/v1', graphqlBase: 'https://custom.example/graphql' },
      fakeFetch(calls, [{ status: 202, body: {} }]),
    );
    await api.destroyApp('x');
    expect(calls[0].url).toBe('https://custom.example/v1/apps/x?force=true');
  });
});
