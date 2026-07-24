import { createHmac } from 'node:crypto';

// RFC3986 percent-encoding, byte-identical to PHP's rawurlencode.
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function canonical(
  method: string,
  route: string,
  query: Record<string, string>,
  body: string,
  timestamp: number,
): string {
  const pairs = Object.keys(query)
    .filter((k) => k !== 'rest_route' && k !== '_locale')
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`);
  return `${method.toUpperCase()}\n${route}\n${pairs.join('&')}\n${body}\n${timestamp}`;
}

export function sign(
  secret: string,
  method: string,
  route: string,
  query: Record<string, string>,
  body: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(canonical(method, route, query, body, timestamp))
    .digest('hex');
}
