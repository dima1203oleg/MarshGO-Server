import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildOsmBikeAudit, renderOsmBikeAuditCsv, renderOsmBikeAuditMarkdown } from '../server/mobility/osmAudit';
import { parseOsmFeatureSequence, parseOsmGeoJsonSequence } from '../server/mobility/osmBikeRentals';

async function main() {
  const input = process.argv[2];
  const outputDirectory = process.argv[3] ?? resolve('artifacts/osm-bike-rentals');
  const administrativeInput = process.argv[4];
  const sourceSnapshot = process.argv[5] ?? basename(input ?? 'OSM snapshot');
  if (!input) throw new Error('Usage: npm run mobility:audit-osm-bikes -- <bike-geojsonseq> [output-directory] [admin-geojsonseq] [source-snapshot]');
  const inputPath = resolve(input);
  const records = parseOsmGeoJsonSequence(await readFile(inputPath, 'utf8'));
  const administrativeFeatures = administrativeInput ? parseOsmFeatureSequence(await readFile(resolve(administrativeInput), 'utf8')) : [];
  const audit = buildOsmBikeAudit(records, new Date(), administrativeFeatures);
  await mkdir(outputDirectory, { recursive: true });
  const geoJsonSequence = audit.features.map((feature) => `${String.fromCharCode(0x1e)}${JSON.stringify(feature)}`).join('\n') + '\n';
  await Promise.all([
    writeFile(resolve(outputDirectory, 'bike-rentals.csv'), renderOsmBikeAuditCsv(audit)),
    writeFile(resolve(outputDirectory, 'bike-rentals.geojson'), JSON.stringify({ type:'FeatureCollection', attribution:'© OpenStreetMap contributors, ODbL 1.0', generatedAt:audit.generatedAt, features:audit.features })),
    writeFile(resolve(outputDirectory, 'bike-rentals.geojsonseq'), geoJsonSequence),
    writeFile(resolve(outputDirectory, 'BIKE_RENTAL_UKRAINE_AUDIT.md'), renderOsmBikeAuditMarkdown(audit, sourceSnapshot)),
  ]);
  console.log(JSON.stringify({ totalRentalLocations:audit.totalRentalLocations, byProvider:audit.byProvider, byCity:audit.byCity, byRegion:audit.byRegion, outputDirectory }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'OSM bike audit failed'); process.exitCode = 1; });
