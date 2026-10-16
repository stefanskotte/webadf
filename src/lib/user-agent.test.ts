import { describe, it, expect, afterEach } from 'vitest';
import { webadfUserAgent } from './user-agent';

const saved = process.env.BETTER_AUTH_URL;
afterEach(() => { if (saved === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = saved; });

describe('webadfUserAgent', () => {
  it('names the deployment when BETTER_AUTH_URL is set', () => {
    process.env.BETTER_AUTH_URL = 'https://adf.example.org';
    expect(webadfUserAgent()).toBe('webadf/1.0 (Amiga disk library; +https://adf.example.org)');
  });
  it('uses only the origin, so a trailing slash or path never changes it', () => {
    process.env.BETTER_AUTH_URL = 'https://webadf.vercel.app/';
    expect(webadfUserAgent()).toBe('webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)');
    process.env.BETTER_AUTH_URL = 'https://adf.example.org:8443/x/y';
    expect(webadfUserAgent()).toBe('webadf/1.0 (Amiga disk library; +https://adf.example.org:8443)');
  });
  it('falls back on an unparsable value', () => {
    process.env.BETTER_AUTH_URL = 'not a url';
    expect(webadfUserAgent()).toBe('webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)');
  });
  it('falls back to the public site', () => {
    delete process.env.BETTER_AUTH_URL;
    expect(webadfUserAgent()).toBe('webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)');
  });
});
