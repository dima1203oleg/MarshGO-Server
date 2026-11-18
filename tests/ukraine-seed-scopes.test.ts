import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enabledStatusForHealth, selectUkraineSeedEntries } from '../server/mobility/seedScopes';
import { kyivOpenDataCatalog, ukraineCatalog, ukraineCatalogWave2 } from '../server/mobility/ukraineCatalog';

const catalog = [...ukraineCatalog, ...ukraineCatalogWave2, ...kyivOpenDataCatalog];

test('verified-live seed scope selects only four explicitly sourced municipal feeds', () => {
  const selected = selectUkraineSeedEntries('--verified-live', catalog);
  assert.deepEqual(selected?.map((entry) => entry.city).sort(), ['Дніпро', 'Кам’янське', 'Рівне', 'Ужгород']);
  assert.ok(selected?.every((entry) => entry.sourceType === 'json'));
});

test('verified-gtfs-rt scope selects only the exact official Ivano-Frankivsk realtime source', () => {
  const selected = selectUkraineSeedEntries('--verified-gtfs-rt', catalog);
  assert.deepEqual(selected?.map((entry) => entry.sourceRef), [
    'https://data.gov.ua/dataset/508a77c2-c233-4e09-92ba-f3976d545822',
  ]);
});

test('verified-gtfs-schedule scope selects only currently validated, licensed municipal timetables', () => {
  const selected = selectUkraineSeedEntries('--verified-gtfs-schedule', catalog);
  assert.deepEqual(selected?.map((entry) => entry.city).sort(), ['Івано-Франківськ', 'Київ', 'Львів', 'Стрий', 'Ужгород']);
  assert.ok(selected?.every((entry) => entry.sourceType === 'gtfs'));
  const lviv = selected?.find((entry) => entry.city === 'Львів');
  assert.match(lviv?.sourceRef ?? '', /data\.gov\.ua\/dataset\/lviv-public-transport-gtfs-real-time\/resource\/eb31a65b-a22b-44b1-83ce-41add24ae652/);
  const kyiv = selected?.find((entry) => entry.city === 'Київ');
  assert.equal(kyiv?.feedUrl, 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip');
  assert.match(kyiv?.sourceRef ?? '', /data\.gov\.ua\/dataset\/96128887-4f36-4c19-a96e-5d4765fade16/);
  assert.equal(selectUkraineSeedEntries('--unverified-schedule', catalog), null);
});

test('verified Lviv scope selects only the exact official, licensed static schedule', () => {
  const selected = selectUkraineSeedEntries('--verified-lviv-gtfs-schedule', catalog);
  assert.equal(selected?.length, 1);
  assert.equal(selected?.[0]?.city, 'Львів');
  assert.equal(selected?.[0]?.feedUrl, 'https://track.ua-gis.com/gtfs/lviv/static.zip');
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
});

test('verified Ivano-Frankivsk scope refreshes only its official city GTFS schedule', () => {
  const selected = selectUkraineSeedEntries('--verified-ivano-frankivsk-gtfs-schedule', catalog);
  assert.equal(selected?.length, 1);
  assert.equal(selected?.[0]?.city, 'Івано-Франківськ');
  assert.equal(selected?.[0]?.feedUrl, 'https://city.dozor.tech/iv-frankivsk/gtfs/static.zip');
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
});

test('verified Kyiv scope selects only the exact officially attributed HTTPS mirror', () => {
  const selected = selectUkraineSeedEntries('--verified-kyiv-gtfs-schedule', catalog);
  assert.equal(selected?.length, 1);
  assert.equal(selected?.[0]?.city, 'Київ');
  assert.equal(selected?.[0]?.feedUrl, 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip');
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
});

test('verified Stryi/Uzhhorod scope isolates the two exact official static schedules', () => {
  const selected = selectUkraineSeedEntries('--verified-stryi-uzhhorod-gtfs-schedule', catalog);
  assert.deepEqual(selected?.map((entry) => entry.city).sort(), ['Стрий', 'Ужгород']);
  assert.deepEqual(selected?.map((entry) => entry.feedUrl).sort(), [
    'https://track.ua-gis.com/gtfs/stryi/static.zip',
    'https://track.ua-gis.com/gtfs/uzhhorod/static.zip',
  ]);
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
});

test('candidate GTFS CSV scope never selects the rejected Zhmerinka snapshot', () => {
  const selected = selectUkraineSeedEntries('--candidate-gtfs-csv', catalog);
  assert.deepEqual(selected?.map((entry) => entry.city), []);
  assert.ok(!selectUkraineSeedEntries('all', catalog)?.some((entry) => entry.sourceRef === 'https://data.gov.ua/dataset/ea47d118-9085-4695-9202-1839acd7e0c5'));
});

test('candidate GTFS bundle scope selects only the exact three-source Horishni Plavni schedule', () => {
  const selected = selectUkraineSeedEntries('--candidate-gtfs-bundle', catalog);
  assert.deepEqual(selected?.map((entry) => entry.city), ['Горішні Плавні']);
  assert.equal(selected?.[0]?.sourceRef.split('; ').length, 3);
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
});

test('candidate live JSON scope isolates Korosten and Ivano-Frankivsk positions and never claims route schedules', () => {
  const selected = selectUkraineSeedEntries('--candidate-live-json', catalog);
  assert.deepEqual(selected?.map((entry) => entry.sourceRef).sort(), [
    'data.gov.ua:Управління транспорту Івано-Франківська',
    'https://data.gov.ua/dataset/1d0f5343-2dca-4170-9d70-6e97afbe3852',
  ]);
  const korosten = selected?.find((entry) => entry.city === 'Коростень');
  assert.equal(korosten?.sourceType, 'json');
  assert.match(korosten?.coverage ?? '', /Лише позиції автобусів/);
  assert.match(korosten?.coverage ?? '', /маршрутний пошук не заявляється/);
  const ivanoFrankivsk = selected?.find((entry) => entry.city === 'Івано-Франківськ');
  assert.equal(ivanoFrankivsk?.sourceType, 'json');
  assert.match(ivanoFrankivsk?.feedUrl ?? '', /city\.dozor\.tech\/iv-frankivsk\/devices\.json/);
  assert.equal(ivanoFrankivsk?.coverage, 'Автобуси й тролейбуси Івано-Франківська');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
});

test('verified-live scope disables sources unless the current probe is healthy', () => {
  assert.equal(enabledStatusForHealth('healthy', true), 'enabled');
  assert.equal(enabledStatusForHealth('degraded', true), 'disabled');
  assert.equal(enabledStatusForHealth('offline', true), 'disabled');
  assert.equal(enabledStatusForHealth('degraded', false), 'enabled');
});

test('existing all and Kyiv metro seed scopes remain stable', () => {
  const all = selectUkraineSeedEntries('all', catalog) ?? [];
  assert.equal(all.length, catalog.length - 2);
  assert.ok(!all.some((entry) => entry.city === 'Чорноморськ'), '2019 timetable must not be registered as current service');
  assert.ok((selectUkraineSeedEntries('--kyiv-metro', catalog)?.length ?? 0) > 0);
  assert.equal(selectUkraineSeedEntries('--unknown', catalog), null);
});
