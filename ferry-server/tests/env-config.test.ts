import { describe, expect, it } from 'vitest';
import { accountCap, listenHost, secureCookies } from '../src/env-config.js';

describe('listenHost', () => {
  it('defaults to loopback', () => {
    expect(listenHost({})).toBe('127.0.0.1');
  });
  it('honors FERRY_HOST', () => {
    expect(listenHost({ FERRY_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
  it('treats empty string as unset', () => {
    expect(listenHost({ FERRY_HOST: '' })).toBe('127.0.0.1');
  });
});

describe('secureCookies', () => {
  it("is on only for the exact value '1'", () => {
    expect(secureCookies({})).toBe(false);
    expect(secureCookies({ FERRY_SECURE_COOKIES: '1' })).toBe(true);
    expect(secureCookies({ FERRY_SECURE_COOKIES: '0' })).toBe(false);
    expect(secureCookies({ FERRY_SECURE_COOKIES: 'true' })).toBe(false);
  });
});

describe('accountCap', () => {
  it('unset or empty means unlimited (undefined)', () => {
    expect(accountCap({})).toBeUndefined();
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '' })).toBeUndefined();
  });
  it('parses non-negative integers, including 0 (signup fully closed)', () => {
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '2' })).toBe(2);
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '0' })).toBe(0);
  });
  it('throws on garbage so a typo cannot silently open signup', () => {
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: 'two' })).toThrow(/FERRY_MAX_ACCOUNTS/);
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: '-1' })).toThrow(/FERRY_MAX_ACCOUNTS/);
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: '2.5' })).toThrow(/FERRY_MAX_ACCOUNTS/);
  });
});
