import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataGovGtfsPackageIds, isDataGovGtfsComponentsUrl, isMatchingDataGovPackageMetadata, isSupportedComponentFormat, normalizeComponentCsv } from '../server/mobility/gtfsComponents';

test('data.gov.ua component importer only accepts its explicit public package_show endpoint', () => {
  assert.equal(isDataGovGtfsComponentsUrl('https://data.gov.ua/api/3/action/package_show?id=ea47d118-9085-4695-9202-1839acd7e0c5'), true);
  assert.equal(isDataGovGtfsComponentsUrl('http://data.gov.ua/api/3/action/package_show?id=abc'), false);
  assert.equal(isDataGovGtfsComponentsUrl('https://example.org/api/3/action/package_show?id=abc'), false);
  assert.equal(isDataGovGtfsComponentsUrl('https://data.gov.ua/dataset/abc'), false);
  const bundle = 'https://data.gov.ua/api/3/action/package_show?id=3d741a97-1876-4edf-90e2-0a5eff85026e&include=99a26b8f-263f-492f-9302-c41ff9bc950f,09ed4f56-a119-43eb-8b98-bad814ade8d4';
  assert.equal(isDataGovGtfsComponentsUrl(bundle), true);
  assert.deepEqual(dataGovGtfsPackageIds(bundle), [
    '3d741a97-1876-4edf-90e2-0a5eff85026e',
    '99a26b8f-263f-492f-9302-c41ff9bc950f',
    '09ed4f56-a119-43eb-8b98-bad814ade8d4',
  ]);
  assert.equal(dataGovGtfsPackageIds(`${bundle}&next=https://example.org/`), null);
  assert.equal(dataGovGtfsPackageIds('https://data.gov.ua/api/3/action/package_show?id=3d741a97-1876-4edf-90e2-0a5eff85026e&include=3d741a97-1876-4edf-90e2-0a5eff85026e'), null);
});

test('component CSV headers normalize GTFS camelCase and preserve row values', () => {
  const input = 'agencyId,agencyName,agencyTimezone\n"A1","Жмеринська, МР","Europe/Kyiv"\n';
  assert.equal(normalizeComponentCsv(input), 'agency_id,agency_name,agency_timezone\nA1,"Жмеринська, МР",Europe/Kyiv\n');
});

test('component CSV normalizes semicolon exports while preserving commas and quoted separators in values', () => {
  const input = 'agencyId;agencyName;agencyTimezone\r\nA1;Жмеринська, МР;Europe/Kyiv\r\nA2;"Оператор; міський";Europe/Kyiv\r\n';
  assert.equal(normalizeComponentCsv(input), 'agency_id,agency_name,agency_timezone\nA1,"Жмеринська, МР",Europe/Kyiv\nA2,Оператор; міський,Europe/Kyiv\n');
});

test('component table accepts the portal’s CVS typo only for a .csv resource', () => {
  assert.equal(isSupportedComponentFormat('CVS', '/resource/calendar.csv'), true);
  assert.equal(isSupportedComponentFormat('CVS', '/resource/calendar.xlsx'), false);
  assert.equal(isSupportedComponentFormat('XLSX', '/resource/calendar.csv'), false);
  assert.equal(isSupportedComponentFormat('CSV', '/resource/calendar.csv'), true);
});

test('legacy data.gov.ua page UUID accepts only its exact CKAN package-name alias', () => {
  const metadata = { success: true, result: {
    id: 'a627ab4f-e4f2-4836-b975-c0132ae25a9a',
    name: 'ea47d118-9085-4695-9202-1839acd7e0c5',
    resources: [],
  } };
  assert.equal(isMatchingDataGovPackageMetadata(metadata, 'ea47d118-9085-4695-9202-1839acd7e0c5'), true);
  assert.equal(isMatchingDataGovPackageMetadata(metadata, 'a-different-dataset'), false);
  assert.equal(isMatchingDataGovPackageMetadata({ ...metadata, success: false }, 'ea47d118-9085-4695-9202-1839acd7e0c5'), false);
});
