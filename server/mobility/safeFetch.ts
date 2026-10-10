import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.');
}

export class UnsafeUrlError extends Error {}

/** Admin-supplied feed URLs are fetched server-side, so they must be public HTTPS hosts (SSRF guard). */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new UnsafeUrlError('Only public https URLs without credentials are allowed');
  if (net.isIP(url.hostname)) { if (isPrivateAddress(url.hostname)) throw new UnsafeUrlError('Private addresses are not allowed'); return url; }
  const records = await dns.lookup(url.hostname, { all: true }).catch(() => { throw new UnsafeUrlError('Host cannot be resolved'); });
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) throw new UnsafeUrlError('Host resolves to a private address');
  return url;
}

/** Follow only a small number of HTTPS redirects, re-running the SSRF guard on every destination. */
async function fetchPublic(raw: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let url = await assertPublicHttpsUrl(raw);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects >= 3) throw new Error('Feed redirect limit exceeded or missing Location header');
    url = await assertPublicHttpsUrl(new URL(location, url).toString());
  }
}

export async function fetchJson(raw: string, timeoutMs = 8000): Promise<{ data: unknown; ms: number }> {
  const started = Date.now();
  const response = await fetchPublic(raw, { headers: { accept: 'application/json', 'user-agent': 'MARSHGO-Mobility/1.0' } }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('Feed is too large');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Feed is too large');
  try { return { data: JSON.parse(text), ms: Date.now() - started }; } catch { throw new Error('Response is not valid JSON'); }
}

/** Reachability probe for non-JSON feeds (GTFS zip, CSV, ...): checks status and content type without downloading the body. */
export async function probeUrl(raw: string, timeoutMs = 8000): Promise<{ status: number; contentType: string | null; ms: number }> {
  const started = Date.now();
  const response = await fetchPublic(raw, { headers: { 'user-agent': 'MARSHGO-Mobility/1.0' } }, timeoutMs);
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, contentType: response.headers.get('content-type'), ms: Date.now() - started };
}

/** Downloads a binary feed (GTFS zip, GTFS-RT protobuf) with the same SSRF guard and a hard size cap. */
export async function fetchBinary(raw: string, maxBytes: number, timeoutMs = 20000): Promise<{ data: Uint8Array; ms: number }> {
  const started = Date.now();
  const response = await fetchPublic(raw, { headers: { 'user-agent': 'MARSHGO-Mobility/1.0' } }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('Feed is too large');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new Error('Feed is too large');
  return { data, ms: Date.now() - started };
}
