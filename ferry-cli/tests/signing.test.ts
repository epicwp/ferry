import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sign } from '../src/signing.js';

const here = dirname(fileURLToPath(import.meta.url));
const { secret, vectors } = JSON.parse(
  readFileSync(join(here, '../../contracts/hmac-vectors.json'), 'utf8'),
);

describe('sign', () => {
  for (const v of vectors) {
    it(`matches vector: ${v.name}`, () => {
      expect(sign(secret, v.method, v.route, v.query, v.body, v.timestamp, v.nonce)).toBe(v.expected);
    });
  }

  it('strips rest_route and _locale from the query', () => {
    const v = vectors[2];
    const polluted = { ...v.query, rest_route: '/ferry/v1/db', _locale: 'user' };
    expect(sign(secret, v.method, v.route, polluted, v.body, v.timestamp, v.nonce)).toBe(v.expected);
  });

  // Cross-parity vector: ferry-plugin/tests/AuthTest.php asserts the identical hex signature for these same inputs.
  it('matches the cross-parity vector shared with the plugin', () => {
    const sig = sign(
      's3cret',
      'POST',
      '/ferry/v1/commit',
      { a: 'b' },
      '{"x":1}',
      1753500000,
      'aabbccddeeff00112233445566778899',
    );
    expect(sig).toBe('6727de63de27fc264a3fa94e0541012e32271c739d1d74f1dde3969c8a57575c');
  });
});
