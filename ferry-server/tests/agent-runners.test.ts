import { describe, expect, it } from 'vitest';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import { buildFerryTools } from '../src/agent/sdk-runner.js';
import type { RunnerEvent } from '../src/agent/types.js';

async function drain(events: RunnerEvent[], until: RunnerEvent['type'], timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!events.some((e) => e.type === until)) {
    if (Date.now() - start > timeoutMs) throw new Error(`no ${until} event`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('scriptedRunner', () => {
  it('emits a full canned turn for every send, echoing the user text', async () => {
    const events: RunnerEvent[] = [];
    const handle = scriptedRunner().start({
      cloneDir: '/tmp/x', slug: 's', onEvent: (e) => events.push(e),
    });
    handle.send('Why is VAT wrong?');
    await drain(events, 'turn_end');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('sdk_session');
    expect(types).toEqual(expect.arrayContaining(['text_delta', 'tool_use', 'tool_result', 'agent_text', 'turn_end']));
    const text = events.find((e) => e.type === 'agent_text') as { text: string };
    expect(text.text).toContain('Why is VAT wrong?');
    const turn = events.find((e) => e.type === 'turn_end') as { totalCostUsd: number | null };
    expect(turn.totalCostUsd).not.toBeNull();
    await handle.close();
  });

  it('resumes with the same sdk session id and interrupts quietly', async () => {
    const events: RunnerEvent[] = [];
    const runner = scriptedRunner();
    const h1 = runner.start({ cloneDir: '/tmp/x', slug: 's', onEvent: (e) => events.push(e) });
    h1.send('a');
    await drain(events, 'turn_end');
    await h1.interrupt();
    await h1.close();
    const sdk1 = events.find((e) => e.type === 'sdk_session') as { sdkSessionId: string };
    events.length = 0;
    const h2 = runner.start({
      cloneDir: '/tmp/x', slug: 's', resumeSdkSessionId: sdk1.sdkSessionId, onEvent: (e) => events.push(e),
    });
    h2.send('b');
    await drain(events, 'sdk_session');
    expect((events[0] as { sdkSessionId: string }).sdkSessionId).toBe(sdk1.sdkSessionId);
    await h2.close();
  });
});

describe('buildFerryTools handlers', () => {
  it('fetch_uploads calls the engine with slug and args', async () => {
    const calls: unknown[] = [];
    const tools = buildFerryTools('klant-nl', {
      fetchUploads: async (slug, opts) => { calls.push([slug, opts]); return { fetched: 3 }; },
      loadProfile: () => ({ url: 'https://klant.nl' }),
    });
    // tool() wraps { name, handler } — invoke the handler directly (shape per pins doc)
    const fetchTool = (tools as { name: string; handler: (a: unknown) => Promise<unknown> }[])
      .find((t) => t.name === 'fetch_uploads')!;
    await fetchTool.handler({ prefix: '2026/07' });
    expect(calls).toEqual([['klant-nl', { prefix: '2026/07', all: undefined }]]);
  });

  it('site_info reports profile facts without secrets', async () => {
    const tools = buildFerryTools('klant-nl', {
      fetchUploads: async () => ({}),
      loadProfile: () => ({
        url: 'https://klant.nl',
        info: { wp: '6.5', php: { version: '8.2' }, db: { server: 'mariadb', version: '10.6' }, multisite: false, prefix: 'wp_' },
      }),
    });
    const infoTool = (tools as { name: string; handler: (a: unknown) => Promise<{ content: { type: string; text: string }[] }> }[])
      .find((t) => t.name === 'site_info')!;
    const result = await infoTool.handler({});
    const text = result.content[0]!.text;
    expect(text).toContain('6.5');
    expect(text).not.toContain('secret');
  });
});
