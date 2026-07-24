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
      expect(sign(secret, v.method, v.route, v.query, v.body, v.timestamp)).toBe(v.expected);
    });
  }

  it('strips rest_route and _locale from the query', () => {
    const v = vectors[2];
    const polluted = { ...v.query, rest_route: '/ferry/v1/db', _locale: 'user' };
    expect(sign(secret, v.method, v.route, polluted, v.body, v.timestamp)).toBe(v.expected);
  });
});
