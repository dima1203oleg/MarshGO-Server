#!/usr/bin/env bash
set -euo pipefail

INPUT=${1:?usage: extract-osm-bike-rentals.sh ukraine-latest.osm.pbf [output-prefix]}
PREFIX=${2:-/tmp/marshgo-ukraine-bike-rentals}
command -v osmium >/dev/null || { echo "osmium-tool is required" >&2; exit 2; }

osmium tags-filter "$INPUT" \
  nwr/amenity=bicycle_rental \
  nwr/bicycle_rental=docking_station,dropoff_point,shop \
  nwr/shop=rental \
  nwr/shop=bicycle \
  nwr/service:bicycle:rental=yes \
  -o "$PREFIX.osm.pbf" --overwrite

# Keep OSM ids/tags and full geometry. The TypeScript normalizer applies the
# exact positive combinations and rejects ordinary bicycle_parking objects.
osmium export "$PREFIX.osm.pbf" --add-unique-id=type_id --geometry-types=point,linestring,polygon -f geojsonseq -o "$PREFIX.geojsonseq" --overwrite

# Small offline boundary index used only to assign rental coordinates to named
# OSM cities/towns and oblasts. This avoids a bulk reverse-geocoding service.
osmium tags-filter "$INPUT" \
  nwr/admin_level=4,6,8 \
  nwr/place=city,town \
  -o "$PREFIX-admin.osm.pbf" --overwrite
osmium export "$PREFIX-admin.osm.pbf" --add-unique-id=type_id --geometry-types=point,polygon -f geojsonseq -o "$PREFIX-admin.geojsonseq" --overwrite
echo "$PREFIX.geojsonseq $PREFIX-admin.geojsonseq"
