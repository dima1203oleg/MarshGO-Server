import { strFromU8, unzipSync } from 'fflate';
import { fetchBinary, fetchJson } from './safeFetch';

const GTFS_FILES = new Set(['agency', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates', 'shapes']);
const REQUIRED_FILES = ['agency', 'stops', 'routes', 'trips', 'stop_times', 'calendar'];
const ZIP_FILE_PATTERN = /(^|\/)(agency|routes|stops|trips|stop_times|calendar|calendar_dates|shapes|transfers|pathways|levels|fare_attributes|fare_rules|fare_media|fare_products|fare_leg_rules|fare_leg_join_rules|fare_transfer_rules|rider_categories|timeframes|networks|route_networks|areas|stop_areas)\.txt$/;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export function isDataGovGtfsComponentsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'data.gov.ua'
      && url.pathname === '/api/3/action/package_show' && dataGovGtfsPackageIds(url) !== null;
  } catch { return false; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Supports one package or a small explicit bundle of exact CKAN package UUIDs. */
export function dataGovGtfsPackageIds(input: string | URL): string[] | null {
  try {
    const url = input instanceof URL ? input : new URL(input);
    const allowed = new Set(['id', 'include']);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)) || url.searchParams.getAll('id').length !== 1 || url.searchParams.getAll('include').length > 1) return null;
    const rawIds = [url.searchParams.get('id'), ...(url.searchParams.get('include')?.split(',') ?? [])].filter((id): id is string => Boolean(id));
    const ids = rawIds.map((id) => id.trim());
    if (ids.length === 0 || ids.length > 6 || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) return null;
    return ids;
  } catch { return null; }
}

export function isMatchingDataGovPackageMetadata(value: unknown, expectedId: string): value is {
  success: true;
  result: { id: string; name?: string; resources: unknown[] };
} {
  if (!value || typeof value !== 'object') return false;
  const response = value as { success?: unknown; result?: { id?: unknown; name?: unknown; resources?: unknown } };
  const result = response.result;
  // data.gov.ua's legacy public dataset URLs can retain their original UUID as
  // `name` while CKAN has assigned a different internal package UUID as `id`.
  // Accept only an exact canonical-ID match in either field; never follow an
  // unrelated package returned by a broad or aliased lookup.
  return response.success === true && Boolean(result)
    && (result?.id === expectedId || result?.name === expectedId)
    && Array.isArray(result?.resources)
    && typeof result?.id === 'string';
}

function normalizeTableName(raw: string): string | null {
  const base = raw.split(/[?#]/, 1)[0].split('/').pop()?.replace(/\.(csv|txt)$/i, '') ?? '';
  const normalized = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s.-]+/g, '_').toLocaleLowerCase('en-US');
  return GTFS_FILES.has(normalized) ? normalized : null;
}

export function isSupportedComponentFormat(format: unknown, pathname: string): boolean {
  if (typeof format !== 'string') return true;
  const normalized = format.trim().toLowerCase();
  return ['csv', 'txt'].includes(normalized)
    || (normalized === 'cvs' && pathname.toLowerCase().endsWith('.csv'));
}

export function normalizeComponentCsv(text: string): string {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(clean);
  const rows = parseDelimitedCsv(clean, delimiter);
  if (rows.length === 0) return '';
  const columns = rows[0].map((column) => column
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLocaleLowerCase('en-US'));
  return [columns, ...rows.slice(1)].map(serializeCsvRow).join('\n') + (clean.endsWith('\n') || clean.endsWith('\r') ? '\n' : '');
}

function detectCsvDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let commas = 0, semicolons = 0, quoted = false;
  for (let index = 0; index < firstLine.length; index++) {
    const character = firstLine[index];
    if (quoted && character === '"' && firstLine[index + 1] === '"') { index++; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === ',') commas++;
    else if (!quoted && character === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

function parseDelimitedCsv(text: string, delimiter: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { value += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { row.push(value); value = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      row.push(value); rows.push(row); row = []; value = '';
      if (character === '\r' && text[index + 1] === '\n') index++;
    }
    else value += character;
  }
  if (value.length > 0 || row.length > 0) { row.push(value); rows.push(row); }
  return rows;
}

function serializeCsvRow(values: string[]): string {
  return values.map((value) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(',');
}

/**
 * Load current, separately published data.gov.ua GTFS component tables into the same
 * filename→bytes contract consumed by the ZIP GTFS validator and journey planner.
 * Only exact, supported CKAN package_show URLs are accepted; each resource URL passes
 * the shared HTTPS/SSRF and response-size guards.
 */
export async function fetchGtfsFiles(feedUrl: string, maxBytes = MAX_TOTAL_BYTES): Promise<Record<string, Uint8Array>> {
  if (!isDataGovGtfsComponentsUrl(feedUrl)) {
    const { data } = await fetchBinary(feedUrl, maxBytes, 45_000);
    const unzipped = unzipSync(data, { filter: (file) => ZIP_FILE_PATTERN.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    return Object.fromEntries(Object.entries(unzipped).map(([name, content]) => [name.split('/').pop() as string, content]));
  }

  const expectedIds = dataGovGtfsPackageIds(feedUrl);
  if (!expectedIds) throw new Error('Open data GTFS package identifiers are invalid');
  const resources = new Map<string, string>();
  for (const expectedId of expectedIds) {
    const metadataUrl = new URL(feedUrl);
    metadataUrl.searchParams.set('id', expectedId);
    metadataUrl.searchParams.delete('include');
    const { data: response } = await fetchJson(metadataUrl.toString(), 15_000);
    if (!isMatchingDataGovPackageMetadata(response, expectedId)) throw new Error(`Open data GTFS package metadata is invalid for ${expectedId}`);
    for (const value of response.result.resources) {
      if (!value || typeof value !== 'object') continue;
      const resource = value as { name?: unknown; url?: unknown; format?: unknown };
      if (typeof resource.url !== 'string') continue;
      let resourceUrl: URL;
      try { resourceUrl = new URL(resource.url); } catch { continue; }
      if (resourceUrl.protocol !== 'https:' || resourceUrl.hostname !== 'data.gov.ua') continue;
      const name = normalizeTableName(typeof resource.name === 'string' ? resource.name : resource.url);
      if (!name || !isSupportedComponentFormat(resource.format, resourceUrl.pathname)) continue;
      if (resources.has(name)) throw new Error(`Open data GTFS package bundle has ambiguous ${name} tables`);
      resources.set(name, resourceUrl.toString());
    }
  }
  const missing = REQUIRED_FILES.filter((name) => !resources.has(name));
  if (missing.length) throw new Error(`Open data GTFS package is missing required tables: ${missing.join(', ')}`);

  const files: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  for (const [name, url] of resources) {
    const { data: bytes } = await fetchBinary(url, maxBytes, 45_000);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw new Error('Open data GTFS package exceeds the total size limit');
    const normalized = normalizeComponentCsv(strFromU8(bytes));
    files[`${name}.txt`] = new TextEncoder().encode(normalized);
  }
  return files;
}

