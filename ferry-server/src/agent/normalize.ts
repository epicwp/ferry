import type { RunnerEvent } from './types.js';

export const TOOL_INPUT_MAX = 2000;
export const TOOL_OUTPUT_MAX = 4000;

/* eslint-disable @typescript-eslint/no-explicit-any */
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

function safeStringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}).slice(0, TOOL_INPUT_MAX);
  } catch {
    return '{}';
  }
}

/** Pure mapping from raw SDK messages to our RunnerEvent vocabulary. Field names
 *  follow docs/superpowers/specs/2026-07-26-agent-sdk-pins.md — keep in sync. */
export function normalizeSdkMessage(msg: unknown): RunnerEvent[] {
  const m = msg as any;
  if (!m || typeof m.type !== 'string') return [];
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return [{ type: 'sdk_session', sdkSessionId: m.session_id }];
  }
  if (m.type === 'assistant') {
    const out: RunnerEvent[] = [];
    const content = m.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          out.push({ type: 'agent_text', text: block.text });
        } else if (block?.type === 'tool_use') {
          out.push({
            type: 'tool_use', toolUseId: String(block.id ?? ''), name: String(block.name ?? ''),
            input: safeStringifyInput(block.input),
          });
        }
      }
    }
    return out;
  }
  if (m.type === 'user') {
    const out: RunnerEvent[] = [];
    const content = m.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          out.push({
            type: 'tool_result', toolUseId: String(block.tool_use_id ?? ''),
            output: flattenResultContent(block.content).slice(0, TOOL_OUTPUT_MAX),
            isError: Boolean(block.is_error),
          });
        }
      }
    }
    return out;
  }
  if (m.type === 'stream_event') {
    const delta = m.event?.delta;
    if (m.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ type: 'text_delta', text: delta.text }];
    }
    return [];
  }
  if (m.type === 'result') {
    return [{
      type: 'turn_end', subtype: String(m.subtype ?? 'success'),
      totalCostUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      inputTokens: Number(m.usage?.input_tokens ?? 0), outputTokens: Number(m.usage?.output_tokens ?? 0),
      numTurns: Number(m.num_turns ?? 0), durationMs: Number(m.duration_ms ?? 0),
    }];
  }
  return [];
}
