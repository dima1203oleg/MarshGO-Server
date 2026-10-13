import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { normalizeOsmBikeRental, type OsmBikeRentalFeature } from '../server/mobility/osmBikeRentals';

const UPSERT_SQL = `
  INSERT INTO rental_locations(
    provider_id,network_id,mode,rental_model,source,external_id,object_type,name,operator_name,network_name,brand,reference,
    city,region,address,opening_hours,access,website,phone,capacity,vehicle_types,pickup_allowed,dropoff_allowed,
    one_way_return,availability,source_quality,geom,attributes
  )
  SELECT p.provider_id,p.network_id,'BICYCLE',p.rental_model,'OSM',p.external_id,p.object_type,p.name,p.operator_name,p.network_name,p.brand,p.reference,
         p.city,p.region,p.address,p.opening_hours,p.access,p.website,p.phone,p.capacity,'{}',NULL,NULL,
         'UNKNOWN','UNKNOWN','UNVERIFIED',ST_SetSRID(ST_GeomFromGeoJSON(p.geometry::text),4326),p.attributes
    FROM jsonb_to_recordset($1::jsonb) AS p(
      provider_id text,network_id text,rental_model text,external_id text,object_type text,name text,operator_name text,network_name text,
      brand text,reference text,city text,region text,address text,opening_hours text,access text,website text,phone text,
      capacity integer,geometry jsonb,attributes jsonb
    )
  ON CONFLICT(source,external_id) DO UPDATE SET
    provider_id=CASE WHEN rental_locations.source_quality='VERIFIED' THEN rental_locations.provider_id ELSE EXCLUDED.provider_id END,
    network_id=COALESCE(EXCLUDED.network_id,rental_locations.network_id),
    rental_model=EXCLUDED.rental_model,object_type=EXCLUDED.object_type,name=EXCLUDED.name,operator_name=EXCLUDED.operator_name,
    network_name=EXCLUDED.network_name,brand=EXCLUDED.brand,reference=EXCLUDED.reference,city=EXCLUDED.city,region=EXCLUDED.region,
    address=EXCLUDED.address,opening_hours=EXCLUDED.opening_hours,access=EXCLUDED.access,website=EXCLUDED.website,phone=EXCLUDED.phone,
    capacity=EXCLUDED.capacity,geom=CASE WHEN rental_locations.source_quality='VERIFIED' THEN rental_locations.geom ELSE EXCLUDED.geom END,
    attributes=EXCLUDED.attributes,source_imported_at=now(),updated_at=now()
  WHERE rental_locations.source_quality <> 'VERIFIED'
`;

const SOURCE_SQL = `
  INSERT INTO rental_location_sources(rental_location_id,source,external_id,source_url,attributes)
  SELECT r.id,'OSM',r.external_id,'https://www.openstreetmap.org/' || r.external_id,
         jsonb_build_object('object_type',r.object_type,'imported_by','MARSHGO OSM bike rental importer')
    FROM rental_locations r WHERE r.source='OSM' AND r.external_id=ANY($1::text[])
  ON CONFLICT(source,external_id) DO UPDATE SET rental_location_id=EXCLUDED.rental_location_id,source_url=EXCLUDED.source_url,
    observed_at=now(),attributes=EXCLUDED.attributes
`;

type NormalizedRental = NonNullable<ReturnType<typeof normalizeOsmBikeRental>> & {
  cityAssignmentMethod?: string;
  cityDistanceMeters?: number | null;
  regionAssignmentMethod?: string;
};

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: npm run mobility:import-osm-bikes -- <osmium-geojsonseq>');
  if (process.env.MOBILITY_OSM_IMPORT_CONFIRM !== 'true') throw new Error('Set MOBILITY_OSM_IMPORT_CONFIRM=true to authorize database writes.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const lines = createInterface({ input: createReadStream(resolve(input)), crlfDelay: Infinity });
  const counts = new Map<string, number>();
  let batch: NormalizedRental[] = [];
  let seen = 0, rejected = 0, imported = 0;
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload = rows.map((row) => ({
        provider_id: row.providerId, network_id: row.networkId, rental_model: row.rentalModel, external_id: row.externalId,
        object_type: row.objectType, name: row.name, operator_name: row.operator, network_name: row.network, brand: row.brand,
        reference: row.reference, city: row.city, region: row.region, address: row.address, opening_hours: row.openingHours,
        access: row.access, website: row.website, phone: row.phone, capacity: row.capacity, geometry: row.geometry,
        attributes: {
          rental_type: row.rentalType, ref_gbfs: row.refGbfs, postcode: row.postcode, raw_tags: row.rawTags,
          city_assignment_method: row.cityAssignmentMethod ?? null, city_distance_meters: row.cityDistanceMeters ?? null,
          region_assignment_method: row.regionAssignmentMethod ?? null,
        },
      }));
      await client.query(UPSERT_SQL, [JSON.stringify(payload)]);
      await client.query(SOURCE_SQL, [rows.map((row) => row.externalId)]);
      await client.query('COMMIT');
      for (const row of rows) counts.set(row.providerId, (counts.get(row.providerId) ?? 0) + 1);
      imported += rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    batch = [];
  };

  try {
    for await (const line of lines) {
      const value = line.replace(/^\u001e/, '').trim();
      if (!value) continue;
      seen++;
      let feature: unknown;
      try { feature = JSON.parse(value); } catch { rejected++; continue; }
      if (!feature || typeof feature !== 'object' || (feature as OsmBikeRentalFeature).type !== 'Feature') { rejected++; continue; }
      const parsedFeature = feature as OsmBikeRentalFeature;
      const importProperties = parsedFeature.properties ?? {};
      const rawTags = importProperties.rawTags && typeof importProperties.rawTags === 'object' && !Array.isArray(importProperties.rawTags)
        ? importProperties.rawTags as Record<string,unknown> : importProperties;
      const normalized = normalizeOsmBikeRental({ ...parsedFeature, properties: rawTags });
      if (!normalized) { rejected++; continue; }
      batch.push({
        ...normalized,
        city: typeof importProperties.city === 'string' ? importProperties.city : normalized.city,
        region: typeof importProperties.region === 'string' ? importProperties.region : normalized.region,
        cityAssignmentMethod: typeof importProperties.cityAssignmentMethod === 'string' ? importProperties.cityAssignmentMethod : undefined,
        cityDistanceMeters: typeof importProperties.cityDistanceMeters === 'number' ? importProperties.cityDistanceMeters : null,
        regionAssignmentMethod: typeof importProperties.regionAssignmentMethod === 'string' ? importProperties.regionAssignmentMethod : undefined,
      });
      if (batch.length >= 250) await flush();
      if (seen % 100_000 === 0) console.log(JSON.stringify({ seen, imported, rejected }));
    }
    await flush();
    console.log(JSON.stringify({ input: resolve(input), seen, imported, rejected, byProvider: Object.fromEntries(counts), source: 'OSM / ODbL 1.0' }, null, 2));
  } finally { lines.close(); await pool.end(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'OSM import failed'); process.exitCode = 1; });
