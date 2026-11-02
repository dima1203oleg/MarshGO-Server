import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBinary, UnsafeUrlError } from '../server/mobility/safeFetch';

const PUBLIC_IP_URL = 'https://203.0.113.10/vehicle-positions.pb';
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

const respond = (status: number, body = new Uint8Array([1, 2, 3])) => new Response(status === 200 ? body : null, {
  status, headers: status === 200 ? { 'content-length': String(body.byteLength) } : {},
});

/** Stubs fetch in call order; a public IP literal keeps assertPublicHttpsUrl from touching DNS. */
function stubFetch(...outcomes: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push(String(input));
    void init;
    const next = outcomes.shift() ?? (() => respond(500));
    return Promise.resolve(next());
  }) as typeof globalThis.fetch;
  return calls;
}

describe('binary feed retry', () => {
  it('retries a rate limit once before reporting it', async () => {
    const calls = stubFetch(() => respond(429), () => respond(429));
    await assert.rejects(() => fetchBinary(PUBLIC_IP_URL, 1024), /HTTP 429/);
    assert.equal(calls.length, 2);
  });

  it('recovers when the provider answers on the second attempt', async () => {
    const calls = stubFetch(() => respond(503), () => respond(200));
    const { data } = await fetchBinary(PUBLIC_IP_URL, 1024);
    assert.equal(data.byteLength, 3);
    assert.equal(calls.length, 2);
  });

  it('does not retry a hard 404', async () => {
    const calls = stubFetch(() => respond(404), () => respond(200));
    await assert.rejects(() => fetchBinary(PUBLIC_IP_URL, 1024), /HTTP 404/);
    assert.equal(calls.length, 1);
  });

  it('retries a body that stops short of the declared length', async () => {
    const short = () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-length': '9' } });
    const calls = stubFetch(short, short);
    await assert.rejects(() => fetchBinary(PUBLIC_IP_URL, 1024), /incomplete \(2 of 9 bytes\)/);
    assert.equal(calls.length, 2);
  });

  it('compares content-length only for unencoded bodies', async () => {
    const gzipped = () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '9' } });
    const calls = stubFetch(gzipped);
    const { data } = await fetchBinary(PUBLIC_IP_URL, 1024);
    assert.equal(data.byteLength, 5);
    assert.equal(calls.length, 1);
  });

  it('rejects an unsafe URL before any request is made', async () => {
    const calls = stubFetch(() => respond(200));
    await assert.rejects(() => fetchBinary('https://127.0.0.1:3002/feed.pb', 1024), UnsafeUrlError);
    assert.equal(calls.length, 0);
  });
});
