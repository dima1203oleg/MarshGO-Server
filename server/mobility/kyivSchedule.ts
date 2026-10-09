import { fetchJson } from './safeFetch';

export type KyivScheduleKind = 'city_train' | 'metro' | 'funicular';
export interface KyivScheduleSource { id: string; name: string; feed_url: string; source_ref: string | null }
interface ArcGisFeatureCollection { features?: Array<{ attributes?: Record<string, unknown> }> }
interface CachedRows { expiresAt: number; rows: Array<Record<string, unknown>> }
type KyivScheduleRow = Record<string, unknown> & {
  dataKind: 'stop_times' | 'headways' | 'station_hours';
  source: string;
  sourceRef: string | null;
};

const cache = new Map<string, CachedRows>();
const CACHE_MS = 5 * 60_000;
const MAX_ROWS = 20_000;
const sourceConfig: Record<KyivScheduleKind, { phrase: string }> = {
  city_train: { phrase: 'міська електричка (розклад)' },
  metro: { phrase: 'метро' },
  funicular: { phrase: 'фунікулер' },
};
const dataKindFor = (name: string): 'stop_times' | 'headways' | 'station_hours' => name.includes('інтервали') ? 'headways' : name.includes('години роботи') ? 'station_hours' : 'stop_times';

async function fetchRows(source: KyivScheduleSource): Promise<Array<Record<string, unknown>>> {
  const cached = cache.get(source.id);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const { data } = await fetchJson(source.feed_url, 15_000);
  const features = (data as ArcGisFeatureCollection | null)?.features;
  if (!Array.isArray(features)) throw new Error('Kyiv schedule API did not return ArcGIS features');
  const rows = features.flatMap((feature) => feature?.attributes && typeof feature.attributes === 'object' ? [feature.attributes] : []);
  if (rows.length === 0 || rows.length > MAX_ROWS) throw new Error('Kyiv schedule API returned an invalid row count');
  cache.set(source.id, { expiresAt: Date.now() + CACHE_MS, rows });
  return rows;
}

export async function loadKyivSchedules(sources: KyivScheduleSource[], kind: KyivScheduleKind, station?: string) {
  const config = sourceConfig[kind];
  const eligible = sources.filter((source) => source.name.toLocaleLowerCase('uk').includes(config.phrase));
  const settled = await Promise.all(eligible.map(async (source) => {
    try { return { source, rows: await fetchRows(source), error: null as string | null }; }
    catch (error) { return { source, rows: [] as Array<Record<string, unknown>>, error: error instanceof Error ? error.message : 'Feed unavailable' }; }
  }));
  const data: KyivScheduleRow[] = settled.flatMap(({ source, rows }) => rows.map((row) => ({
    ...row,
    dataKind: dataKindFor(source.name),
    source: source.name,
    sourceRef: source.source_ref,
  })));
  const filtered = station ? data.filter((row) => String(row.name ?? '').toLocaleLowerCase('uk').includes(station.toLocaleLowerCase('uk'))) : data;
  return { data: filtered, meta: { city: 'Київ', kind, timezone: 'Europe/Kyiv', sourceCount: eligible.length,
    failedSources: settled.filter((item) => item.error).map(({ source, error }) => ({ name: source.name, error })),
    updatedAt: new Date().toISOString(), cacheTtlSeconds: CACHE_MS / 1000,
    scheduleSemantics: kind === 'city_train' ? 'published_station_passage_times' : 'published_first_last_service_and_headway_intervals' } };
}

/** Validate the city's public schedule REST response during provider discovery/refresh. */
export async function testKyivScheduleConnection(feedUrl: string) {
  const started = Date.now();
  const { data, ms } = await fetchJson(feedUrl, 15_000);
  const features = (data as ArcGisFeatureCollection | null)?.features;
  const rows = Array.isArray(features) ? features.flatMap((feature) => feature?.attributes ? [feature.attributes] : []) : [];
  if (rows.length === 0) throw new Error('Kyiv schedule API returned no ArcGIS feature records');
  const fieldCount = Object.keys(rows[0]).length;
  return { health: 'healthy' as const, checks: [
    { name: 'Kyiv Open Data schedule API', ok: true, detail: `ArcGIS JSON; ${rows.length} records, ${fieldCount} fields` },
  ], counts: { schedule_records: rows.length }, responseMs: ms || Date.now() - started };
}
