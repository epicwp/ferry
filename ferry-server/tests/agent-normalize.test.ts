import { describe, expect, it } from 'vitest';
import { normalizeSdkMessage, TOOL_OUTPUT_MAX, TOOL_INPUT_MAX } from '../src/agent/normalize.js';

describe('normalizeSdkMessage', () => {
  it('maps system init to sdk_session', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'init', session_id: 's-1' }))
      .toEqual([{ type: 'sdk_session', sdkSessionId: 's-1' }]);
  });

  it('maps assistant text and tool_use blocks', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Diving in.' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'calculate_tax' } },
      ] },
    });
    expect(events).toEqual([
      { type: 'agent_text', text: 'Diving in.' },
      { type: 'tool_use', toolUseId: 't1', name: 'Grep', input: JSON.stringify({ pattern: 'calculate_tax' }) },
    ]);
  });

  it('maps tool results (string and block-array content) and truncates long output', () => {
    const long = 'x'.repeat(TOOL_OUTPUT_MAX + 50);
    const events = normalizeSdkMessage({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: long, is_error: false },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'boom' }], is_error: true },
      ] },
    });
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: false });
    expect((events[0] as { output: string }).output).toHaveLength(TOOL_OUTPUT_MAX);
    expect(events[1]).toMatchObject({ type: 'tool_result', toolUseId: 't2', output: 'boom', isError: true });
  });

  it('maps stream text deltas and ignores other stream events', () => {
    expect(normalizeSdkMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'VA' } },
    })).toEqual([{ type: 'text_delta', text: 'VA' }]);
    expect(normalizeSdkMessage({
      type: 'stream_event',
      event: { type: 'content_block_start' },
    })).toEqual([]);
  });

  it('maps result to turn_end incl. error subtypes', () => {
    expect(normalizeSdkMessage({
      type: 'result', subtype: 'success', total_cost_usd: 0.0123, num_turns: 3, duration_ms: 4500,
      usage: { input_tokens: 100, output_tokens: 50 },
    })).toEqual([{ type: 'turn_end', subtype: 'success', totalCostUsd: 0.0123, inputTokens: 100, outputTokens: 50, numTurns: 3, durationMs: 4500 }]);
    expect(normalizeSdkMessage({ type: 'result', subtype: 'error_max_budget_usd', usage: {} })[0])
      .toMatchObject({ type: 'turn_end', subtype: 'error_max_budget_usd', totalCostUsd: null });
  });

  it('returns [] for unknown message types', () => {
    expect(normalizeSdkMessage({ type: 'whatever' })).toEqual([]);
  });

  it('safely handles assistant with non-array content (object)', () => {
    expect(normalizeSdkMessage({
      type: 'assistant',
      message: { content: {} },
    })).toEqual([]);
  });

  it('safely handles assistant with non-array content (number)', () => {
    expect(normalizeSdkMessage({
      type: 'assistant',
      message: { content: 42 },
    })).toEqual([]);
  });

  it('safely handles user with non-array content (object)', () => {
    expect(normalizeSdkMessage({
      type: 'user',
      message: { content: {} },
    })).toEqual([]);
  });

  it('safely handles user with non-array content (number)', () => {
    expect(normalizeSdkMessage({
      type: 'user',
      message: { content: 42 },
    })).toEqual([]);
  });

  it('safely handles tool_use with circular input', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 't1', name: 'Test', input: circular },
      ] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use', toolUseId: 't1', name: 'Test' });
    expect((events[0] as { input: string }).input).toBe('{}');
  });

  it('truncates tool input at TOOL_INPUT_MAX', () => {
    const longStr = 'a'.repeat(TOOL_INPUT_MAX + 100);
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 't1', name: 'Test', input: { data: longStr } },
      ] },
    });
    expect(events[0]).toMatchObject({ type: 'tool_use' });
    expect((events[0] as { input: string }).input).toHaveLength(TOOL_INPUT_MAX);
  });
});
