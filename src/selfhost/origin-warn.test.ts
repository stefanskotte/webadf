import { describe, it, expect } from 'vitest';
import { originWarner } from './origin-warn';

const req = (u: string, headers: Record<string, string> = {}) => new Request(u, { headers });

describe('originWarner', () => {
  it('warns once per unexpected host, never for the expected one', () => {
    const lines: string[] = [];
    const w = originWarner('https://192.168.1.10', (l) => lines.push(l));
    w(req('http://app:3000/api/auth/get-session', { host: '192.168.1.10', 'x-forwarded-proto': 'https' }));
    w(req('http://app:3000/x', { host: 'nas.lan', 'x-forwarded-proto': 'https' }));
    w(req('http://app:3000/y', { host: 'nas.lan', 'x-forwarded-proto': 'https' }));
    expect(lines).toEqual([
      'requests arrive as https://nas.lan but WEBADF_URL is https://192.168.1.10 -- uploads and sign-in will fail; set WEBADF_URL to the address you open',
    ]);
  });
  it('is inert without an expected url', () => {
    const lines: string[] = [];
    originWarner(undefined, (l) => lines.push(l))(req('http://x/'));
    expect(lines).toEqual([]);
  });
  it('caps the distinct hosts it remembers and says so once', () => {
    const lines: string[] = [];
    const w = originWarner('https://a.lan', (l) => lines.push(l));
    for (let i = 0; i < 25; i++) w(req('http://app/', { host: `h${i}.lan`, 'x-forwarded-proto': 'https' }));
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('further hosts that are not WEBADF_URL will not be logged');
  });
  it('uses the first element of comma-separated forwarded headers', () => {
    const lines: string[] = [];
    const w = originWarner('https://a.lan', (l) => lines.push(l));
    w(req('http://app/', { host: 'x', 'x-forwarded-host': 'a.lan, proxy.lan', 'x-forwarded-proto': 'https, http' }));
    expect(lines).toEqual([]);
  });
});
