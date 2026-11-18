import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ukraineCatalog, ukraineCatalogWave2 } from '../server/mobility/ukraineCatalog';
import { commercialUseFromLicense } from '../server/mobility/licensePolicy';

test('municipal realtime feeds carry dataset-specific open-license evidence', () => {
  const catalog = [...ukraineCatalog, ...ukraineCatalogWave2];
  for (const [city, datasetId] of [
    ['Рівне', 'a41488fb-bf97-4f12-8ee3-87817a4c50bd'],
    ['Ужгород', '00d2939e-fe96-4099-9b0d-b8f6f9ce1399'],
    ['Кам’янське', '1ba10dca-79f2-4dc1-92c4-2e92ee61df12'],
  ]) {
    const entry = catalog.find((item) => item.city === city && (city === 'Рівне' ? item.feedUrl.endsWith('/devices.json') : item.sourceType === 'json'));
    assert.ok(entry, `${city} live feed is registered`);
    assert.match(entry.sourceRef, new RegExp(datasetId));
    assert.equal(commercialUseFromLicense(entry.license), true);
  }
  const ivanoFrankivskRt = catalog.find((item) => item.city === 'Івано-Франківськ'
    && item.sourceRef.endsWith('/508a77c2-c233-4e09-92ba-f3976d545822'));
  assert.ok(ivanoFrankivskRt, 'official Ivano-Frankivsk GTFS-RT source is registered');
  assert.equal(ivanoFrankivskRt.sourceType, 'gtfs_rt');
  assert.equal(commercialUseFromLicense(ivanoFrankivskRt.license), true);
  assert.match(ivanoFrankivskRt.updateFrequency ?? '', /більше не оновлюється/i,
    'official portal update status remains visible alongside live endpoint health checks');
  const ivanoFrankivskJson = catalog.find((item) => item.city === 'Івано-Франківськ'
    && item.sourceType === 'json' && item.feedUrl === 'https://city.dozor.tech/iv-frankivsk/devices.json');
  assert.ok(ivanoFrankivskJson, 'officially attributed Ivano-Frankivsk JSON positions are registered separately from timetable data');
  assert.equal(ivanoFrankivskJson.name, 'Івано-Франківськ — позиції (Dozor JSON)', 'JSON live vehicles share the operator prefix of their city GTFS route source');
  assert.equal(ivanoFrankivskJson.sourceRef, 'data.gov.ua:Управління транспорту Івано-Франківська');
  assert.equal(commercialUseFromLicense(ivanoFrankivskJson.license), true);
  const dnipro = catalog.find((item) => item.city === 'Дніпро' && item.feedUrl === 'https://api-t900.icity.com.ua/api/gps_data/');
  assert.ok(dnipro, 'Dnipro live JSON feed is registered');
  assert.equal(dnipro.sourceRef, 'https://data.gov.ua/dataset/real-transport-dnipro');
  assert.equal(commercialUseFromLicense(dnipro.license), true);
  const korosten = catalog.find((item) => item.city === 'Коростень' && item.feedUrl === 'https://www.korosten-rada.gov.ua/transport_korosten.json');
  assert.ok(korosten, 'Korosten live positions are registered separately from its incomplete timetable');
  assert.equal(korosten.sourceRef, 'https://data.gov.ua/dataset/1d0f5343-2dca-4170-9d70-6e97afbe3852');
  assert.equal(commercialUseFromLicense(korosten.license), true);
  assert.match(korosten.coverage, /маршрутний пошук не заявляється/);
  const rivneSchedule = catalog.find((item) => item.city === 'Рівне' && item.sourceType === 'gtfs');
  assert.ok(rivneSchedule);
  assert.equal(rivneSchedule.license, undefined, 'Dozor GTFS license must remain unverified until the license is tied to this feed');
  const uzhhorodSchedule = catalog.find((item) => item.city === 'Ужгород' && item.sourceType === 'gtfs'
    && item.feedUrl === 'https://track.ua-gis.com/gtfs/uzhhorod/static.zip');
  assert.ok(uzhhorodSchedule);
  assert.match(uzhhorodSchedule.sourceRef, /data\.gov\.ua\/dataset\/37-111/);
  assert.match(uzhhorodSchedule.sourceRef, /mobilitydatabase\.org\/feeds\/gtfs\/mdb-2931/);
  assert.equal(commercialUseFromLicense(uzhhorodSchedule.license), true);
  const ivanoFrankivskSchedule = catalog.find((item) => item.city === 'Івано-Франківськ'
    && item.sourceType === 'gtfs' && item.feedUrl === 'https://city.dozor.tech/iv-frankivsk/gtfs/static.zip');
  assert.ok(ivanoFrankivskSchedule);
  assert.match(ivanoFrankivskSchedule.sourceRef, /data\.gov\.ua\/dataset\/ac81e2c1-5ea9-4512-811f-2b3d377fd527/);
  assert.equal(commercialUseFromLicense(ivanoFrankivskSchedule.license), true);
  assert.match(ivanoFrankivskSchedule.coverage, /не публікує shapes\.txt/);
  const stryiSchedule = catalog.find((item) => item.city === 'Стрий'
    && item.sourceType === 'gtfs' && item.feedUrl === 'https://track.ua-gis.com/gtfs/stryi/static.zip');
  assert.ok(stryiSchedule);
  assert.match(stryiSchedule.sourceRef, /data\.loda\.gov\.ua\/dataset\/7b9ddbc6-df4b-4d2e-9567-af66ede840cc/);
  assert.match(stryiSchedule.sourceRef, /mobilitydatabase\.org\/feeds\/gtfs\/mdb-2932/);
  assert.equal(commercialUseFromLicense(stryiSchedule.license), true);
  assert.match(stryiSchedule.coverage, /34 маршрути з геометрією/);
  const kyivSchedule = catalog.find((item) => item.city === 'Київ' && item.feedUrl === 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip');
  assert.ok(kyivSchedule, 'Kyivpastrans HTTPS mirror is registered');
  assert.match(kyivSchedule.sourceRef, /data\.gov\.ua\/dataset\/96128887-4f36-4c19-a96e-5d4765fade16/);
  assert.match(kyivSchedule.sourceRef, /mobilitydatabase\.org\/feeds\/gtfs\/mdb-3230/);
  assert.equal(commercialUseFromLicense(kyivSchedule.license), true);
  assert.match(kyivSchedule.coverage, /неузгоджені часи/);
  const zhmerinkaSchedule = catalog.find((item) => item.city === 'Жмеринка' && item.sourceType === 'gtfs');
  assert.ok(zhmerinkaSchedule);
  assert.equal(zhmerinkaSchedule.feedUrl, 'https://data.gov.ua/api/3/action/package_show?id=ea47d118-9085-4695-9202-1839acd7e0c5');
  assert.equal(commercialUseFromLicense(zhmerinkaSchedule.license), true);
  assert.match(zhmerinkaSchedule.coverage, /не використовувати для пошуку маршрутів до виправлення/i);
});

test('a generic platform name does not grant commercial feed rights', () => {
  assert.equal(commercialUseFromLicense('Платформа Dozor; дані з відкритого порталу data.gov.ua'), null);
  assert.equal(commercialUseFromLicense('EasyWay; дані з відкритого порталу data.gov.ua'), null);
});
