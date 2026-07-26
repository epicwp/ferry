import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEnvFile } from '../src/env-file.js';

const KEYS = ['FERRY_TEST_A', 'FERRY_TEST_B', 'FERRY_TEST_C'];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, content);
  return path;
}

describe('applyEnvFile', () => {
  it('sets variables, strips quotes, skips comments and malformed lines', () => {
    applyEnvFile(envFile('# comment\nFERRY_TEST_A=plain\nFERRY_TEST_B="sk-ant-abc=def"\n\nnot a pair\n'));
    expect(process.env.FERRY_TEST_A).toBe('plain');
    expect(process.env.FERRY_TEST_B).toBe('sk-ant-abc=def');
  });

  it('never overrides a real environment variable', () => {
    process.env.FERRY_TEST_C = 'from-shell';
    applyEnvFile(envFile('FERRY_TEST_C=from-file\n'));
    expect(process.env.FERRY_TEST_C).toBe('from-shell');
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => applyEnvFile('/nonexistent/.env')).not.toThrow();
  });
});
