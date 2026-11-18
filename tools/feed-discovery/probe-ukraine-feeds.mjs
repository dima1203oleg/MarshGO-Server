#!/usr/bin/env node
// Feed discovery probe: given candidate GTFS URLs, report whether each one is
// actually usable by MARSHGO — reachable, parseable, five required files, a
// service window that covers the probe date, and what the feed itself says about
// attribution. No URL is trusted because a catalog lists it; each is measured.
//
// Usage: node probe-ukraine-feeds.mjs [--date YYYY-MM-DD] [--out file.json]
// Exit code is 0 even when feeds fail: this is an inventory, not a gate.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROBE_DATE = opt('date', new Date().toISOString().slice(0, 10));
const OUT = opt('out', 'feed-discovery-report.json');

// Every Ukrainian transport source found by search on 2026-11-19, with what the
// publisher says about it. `expect` records the hypothesis under test.
const CANDIDATES = [
  { id: 'uz-rail', city: 'Україна', name: 'Укрзалізниця (OSM-derived, ODbL)', url: 'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip', license: 'ODbL 1.0', commercialUse: true },
  { id: 'kyiv-pastrans', city: 'Київ', name: 'Київпастранс (офіційний, CC BY 4.0)', url: 'http://193.23.225.211:8002/export-gtfs-static', license: 'CC BY 4.0 (data.gov.ua)', commercialUse: true },
  { id: 'kyiv-jbb', city: 'Київ', name: 'Київпастранс (jbb mirror)', url: 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip', license: 'CC BY 4.0', commercialUse: true },
  { id: 'lviv', city: 'Львів', name: 'Львівавтодор (CC BY 4.0)', url: 'https://track.ua-gis.com/gtfs/lviv/static.zip', license: 'CC BY 4.0', commercialUse: true },
  { id: 'stryi', city: 'Стрий', name: 'Стрийська міська рада (CC BY 4.0)', url: 'https://track.ua-gis.com/gtfs/stryi/static.zip', license: 'CC BY 4.0', commercialUse: true },
  { id: 'uzhhorod', city: 'Ужгород', name: 'Ужгородська міська рада (CC BY 4.0)', url: 'https://track.ua-gis.com/gtfs/uzhhorod/static.zip', license: 'CC BY 4.0', commercialUse: true },
  { id: 'ivano-frankivsk', city: 'Івано-Франківськ', name: 'Івано-Франківськ (Dozor, CC BY 4.0)', url: 'https://city.dozor.tech/iv-frankivsk/gtfs/static.zip', license: 'CC BY 4.0 (data.gov.ua)', commercialUse: true },
  { id: 'rivne-dozor', city: 'Рівне', name: 'Рівне (Dozor)', url: 'https://city.dozor.tech/rivne/gtfs/static.zip', license: 'не заявлена у фіді', commercialUse: false },
  { id: 'bila-cerkva-dozor', city: 'Біла Церква', name: 'Біла Церква (Dozor)', url: 'https://city.dozor.tech/bila-cerkva/gtfs/static.zip', license: 'не заявлена у фіді', commercialUse: false },
  { id: 'odesa-x24', city: 'Одеса', name: 'Одеса (офіційний, x24 API key)', url: 'https://gw.x24.digital/api/od-all/gtfs/v1/download/static', license: 'портал open data ОМР', commercialUse: true, requiresKey: true },
  { id: 'bucha-x24', city: 'Буча', name: 'Буча (x24 API key)', url: 'https://gw.x24.digital/api/bu/gtfs/v1/download/static', license: 'невідома', commercialUse: false, requiresKey: true },
  { id: 'inbus', city: 'Україна', name: 'inbus.ua (міжміські автобуси)', url: 'https://gtfs.fsn1.your-objectstorage.com/feeds/gtfs.zip', license: 'не заявлена', commercialUse: false },
  { id: 'malyn', city: 'Малин', name: 'Малин (OwnNet Source License 1.1)', url: 'https://malin.kiev.ua/transport/gtfs.zip', license: 'OwnNet Source License 1.1 (потрібен договір)', commercialUse: false },
  { id: 'chornomorsk', city: 'Чорноморськ', name: 'Чорноморськ (архів 2019, CC BY 4.0)', url: 'https://data.gov.ua/dataset/032c23f0-dbe5-4b63-8c1f-03218758ae60/resource/d997fdbf-7a25-487b-ad47-ee5541d552be/download/chornomorsk-2019-09-05-10-24-50.zip', license: 'CC BY 4.0', commercialUse: true },
  { id: 'kyiv-metro-stage', city: 'Київ', name: 'Київський метрополітен (ESRI API, stage)', url: 'https://gisserver-stage.kyivcity.gov.ua/mayno/rest/services/KYIV_API/transport_public/MapServer/5/query?where=1%3D1&outFields=*&f=json', license: 'CC BY 4.0', commercialUse: true, notGtfs: true },
];

const unzipList = (zipPath) => execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
const unzipText = (zipPath, name) => {
  try {
    return execFileSync('unzip', ['-p', zipPath, name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
};
const readCsv = (text) => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const split = (line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.slice(0, -1).map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
  const header = split(lines[0]).map((cell) => cell.trim());
  return lines.slice(1).map((line) => Object.fromEntries(split(line).map((cell, i) => [header[i] ?? `col${i}`, cell])));
};
const compact = (date) => date.replace(/-/g, '');

async function probe(candidate) {
  const result = { ...candidate, checkedAt: new Date().toISOString(), status: 'unknown', verdict: 'UNKNOWN', reasons: [] };
  if (candidate.notGtfs) {
    try {
      const res = await fetch(candidate.url, { signal: AbortSignal.timeout(45000) });
      result.httpStatus = res.status;
      result.status = res.ok ? 'reachable' : 'unreachable';
      result.verdict = res.ok ? 'NON_GTFS_API' : 'DEAD';
      result.reasons.push(res.ok ? 'API відповідає, але це не GTFS-фід' : `HTTP ${res.status}`);
    } catch (error) {
      result.status = 'unreachable';
      result.verdict = 'DEAD';
      result.reasons.push(String(error?.name ?? error));
    }
    return result;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-probe-'));
  const zipPath = path.join(dir, 'feed.zip');
  try {
    const res = await fetch(candidate.url, { signal: AbortSignal.timeout(90000), redirect: 'follow' });
    result.httpStatus = res.status;
    if (!res.ok) {
      result.status = 'unreachable';
      result.verdict = res.status === 401 || res.status === 403 ? 'NEEDS_API_KEY' : 'DEAD';
      result.reasons.push(`HTTP ${res.status}`);
      return result;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buffer);
    result.bytes = buffer.byteLength;
    result.sha256 = createHash('sha256').update(buffer).digest('hex');
  } catch (error) {
    result.status = 'unreachable';
    result.verdict = 'DEAD';
    result.reasons.push(String(error?.name ?? error));
    return result;
  }
  let files = [];
  try { files = unzipList(zipPath); } catch {
    result.status = 'invalid';
    result.verdict = 'NOT_GTFS';
    result.reasons.push('архів не читається');
    return result;
  }
  const base = (name) => name.split('/').pop();
  const has = (name) => files.some((file) => base(file) === name);
  const missing = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].filter((name) => !has(name));
  result.files = files.length;
  result.missingFiles = missing;
  if (missing.length) result.reasons.push(`відсутні ${missing.join(', ')}`);
  const get = (name) => (has(name) ? unzipText(zipPath, files.find((file) => base(file) === name)) : '');

  const stops = readCsv(get('stops.txt'));
  const routes = readCsv(get('routes.txt'));
  const trips = readCsv(get('trips.txt'));
  const stopTimes = readCsv(get('stop_times.txt'));
  const calendar = readCsv(get('calendar.txt'));
  const calendarDates = readCsv(get('calendar_dates.txt'));
  result.stops = stops.length;
  result.routes = routes.length;
  result.trips = trips.length;
  result.stopTimeRows = stopTimes.length;
  result.routeTypes = [...new Set(routes.map((row) => row.route_type))].sort();

  const windows = [
    ...calendar.map((row) => ({ start: row.start_date, end: row.end_date })),
    ...calendarDates.filter((row) => row.exception_type === '1').map((row) => ({ start: row.date, end: row.date })),
  ].filter((window) => window.start && window.end);
  const starts = windows.map((window) => window.start).sort();
  const ends = windows.map((window) => window.end).sort();
  result.serviceWindow = windows.length ? { firstStart: starts[0], lastEnd: ends.at(-1), windows: windows.length } : null;
  const today = compact(PROBE_DATE);
  const coversProbeDate = windows.some((window) => window.start <= today && today <= window.end);
  const coversWeek = windows.some((window) => window.start <= today && compact(new Date(Date.parse(PROBE_DATE) + 7 * 86400000).toISOString().slice(0, 10)) <= window.end);
  result.coversProbeDate = coversProbeDate;
  result.coversNextSevenDays = coversWeek;
  if (!coversProbeDate) result.reasons.push(`розклад не покриває ${PROBE_DATE} (вікно ${result.serviceWindow?.firstStart ?? '—'}…${result.serviceWindow?.lastEnd ?? '—'})`);
  else if (!coversWeek) result.reasons.push('вікно послуг коротше за 7 днів — фід зламається без щоденного пересинку');

  const feedInfo = readCsv(get('feed_info.txt'))[0] ?? {};
  result.feedPublisher = feedInfo.feed_publisher_name ? `${feedInfo.feed_publisher_name} ${feedInfo.feed_publisher_url ?? ''}`.trim() : null;

  const structural = missing.length === 0 && stops.length > 0 && routes.length > 0 && trips.length > 0 && stopTimes.length > 0;
  result.status = structural ? 'parsed' : 'invalid';
  if (!structural) result.verdict = 'NOT_GTFS';
  else if (!coversProbeDate) result.verdict = 'STALE';
  else if (!candidate.commercialUse) result.verdict = 'LICENSE_REQUIRED';
  else if (!coversWeek) result.verdict = 'USABLE_WITH_DAILY_RESYNC';
  else result.verdict = 'USABLE';
  return result;
}

const report = { generatedAt: new Date().toISOString(), probeDate: PROBE_DATE, candidates: [] };
for (const candidate of CANDIDATES) {
  const result = await probe(candidate);
  report.candidates.push(result);
  console.log(`${result.verdict.padEnd(24)} ${candidate.city.padEnd(18)} ${candidate.name} — ${result.reasons.join('; ') || 'ok'}`);
}
const tally = report.candidates.reduce((acc, item) => ({ ...acc, [item.verdict]: (acc[item.verdict] ?? 0) + 1 }), {});
report.tally = tally;
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log('\n' + JSON.stringify(tally));
console.log(`report: ${OUT}`);
