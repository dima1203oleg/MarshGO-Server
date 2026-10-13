import { parseKiwitaxiTsv, type KiwitaxiRow } from './kiwitaxiTsv';

export const KIWITAXI_CATALOG_METHODS = ['countries','regions','places','place_types','routes','transfer_types','transfers','currencies','url_domains'] as const;
export type KiwitaxiCatalogMethod = typeof KIWITAXI_CATALOG_METHODS[number];

export interface TransferAdapterStatus {
  providerId: 'kiwitaxi' | 'intui_travel';
  status: 'CATALOG_ONLY' | 'AFFILIATE_LINK_ONLY' | 'AWAITING_CREDENTIALS' | 'AWAITING_AGREEMENT' | 'ERROR';
  catalogAvailable: boolean;
  bookingAvailable: boolean;
  affiliateAvailable: boolean;
  message: string;
}

export function kiwitaxiStatus(env: NodeJS.ProcessEnv = process.env): TransferAdapterStatus {
  const catalogAvailable = Boolean(env.KIWITAXI_SECURITY_TOKEN?.trim());
  const affiliateAvailable = Boolean(env.KIWITAXI_PAP?.trim());
  return {
    providerId: 'kiwitaxi', status: catalogAvailable ? 'CATALOG_ONLY' : affiliateAvailable ? 'AFFILIATE_LINK_ONLY' : 'AWAITING_CREDENTIALS',
    // Credentials enable an explicit catalog sync; only imported, validated rows count as a catalog.
    catalogAvailable: false, affiliateAvailable, bookingAvailable: false,
    message: catalogAvailable ? 'Catalog sync credentials are configured; the response still needs to be fetched and validated. MARSHGO booking is not confirmed.' : affiliateAvailable ? 'Only a partner redirect ID is configured; there is no verified route catalog or MARSHGO booking.' : 'Assigned Kiwitaxi security token and affiliate ID are not configured.',
  };
}

export function intuiTravelStatus(env: NodeJS.ProcessEnv = process.env): TransferAdapterStatus {
  const apiLightConfigured = Boolean(env.INTUI_API_LIGHT_CREDENTIALS?.trim());
  const apiWideAgreement = env.INTUI_API_WIDE_AGREEMENT === 'true';
  return {
    providerId: 'intui_travel', status: apiLightConfigured ? apiWideAgreement ? 'ERROR' : 'AWAITING_AGREEMENT' : 'AWAITING_CREDENTIALS',
    catalogAvailable: false, affiliateAvailable: false, bookingAvailable: false,
    message: apiLightConfigured ? apiWideAgreement ? 'API credentials are present but the partner endpoint contract must be supplied before calls are enabled.' : 'API Light access may be available; API Wide/partner-side payments still need the separate agreement.' : 'Partner API Light credentials are not configured; do not fabricate endpoints or offers.',
  };
}

/**
 * Pulls an allowlisted legacy Kiwitaxi catalog as an explicit sync operation.
 * Never call from a per-user route search: these endpoints return whole tables.
 */
export async function fetchKiwitaxiCatalog(method: KiwitaxiCatalogMethod, env: NodeJS.ProcessEnv = process.env): Promise<{ rows: KiwitaxiRow[]; rejectedRows: number; fetchedAt: Date }> {
  const token = env.KIWITAXI_SECURITY_TOKEN?.trim();
  if (!token) throw new Error('KIWITAXI_SECURITY_TOKEN is not configured');
  if (!(KIWITAXI_CATALOG_METHODS as readonly string[]).includes(method)) throw new TypeError('Unsupported Kiwitaxi catalog method');
  const url = new URL(`/services/data/csv/${method}`, 'https://kiwitaxi.com');
  url.searchParams.set('security_token', token);
  if (method === 'transfers') url.searchParams.set('payment_type', 'partial');
  const response = await fetch(url, { headers: { accept: 'text/csv,text/tab-separated-values', 'user-agent': 'MARSHGO-TransferCatalog/1.0' }, signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Kiwitaxi catalog request failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > 25 * 1024 * 1024) throw new Error('Kiwitaxi catalog response exceeds the 25 MiB sync limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Kiwitaxi catalog response exceeds the 25 MiB sync limit');
  const parsed = parseKiwitaxiTsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return { ...parsed, fetchedAt: new Date() };
}

export function buildKiwitaxiAffiliateUrl(destination: string, env: NodeJS.ProcessEnv = process.env): string {
  const pap = env.KIWITAXI_PAP?.trim();
  if (!pap) throw new Error('KIWITAXI_PAP is not configured');
  const url = new URL(destination);
  if (url.protocol !== 'https:' || !['kiwitaxi.com','www.kiwitaxi.com'].includes(url.hostname)) throw new TypeError('Kiwitaxi deeplink must use the official Kiwitaxi domain');
  url.searchParams.set('pap', pap);
  return url.toString();
}
