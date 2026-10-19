import { strFromU8 } from 'fflate';
import { parseCsvLine } from '../mobility/gtfs';

export interface GtfsFareProduct {
  id: string;
  priceMinor: number;
  currency: string;
  transfers: number | null;
  transferDurationSeconds: number | null;
  agencyId?: string;
  providerId?: string;
}

export interface GtfsFareRule {
  fareId: string;
  routeId?: string;
  originZoneId?: string;
  destinationZoneId?: string;
  containsZoneId?: string;
}

export interface ParsedGtfsFares {
  products: Map<string, GtfsFareProduct>;
  rules: Map<string, GtfsFareRule[]>;
  /** Fares v2 takes precedence over the legacy files when both are present. */
  faresV2Present: boolean;
}

export interface GtfsFareLeg {
  providerId: string;
  routeId: string;
  agencyId?: string;
  departureAt: Date;
  arrivalAt: Date;
  originZoneId?: string;
  destinationZoneId?: string;
  traveledZoneIds: string[];
}

export interface GtfsFareAllocation {
  priceMinor: number;
  currency: string;
  fareProductId: string;
  includedByPreviousFare: boolean;
}

export interface GtfsItineraryFare {
  priceMinor: number;
  currency: string;
  allocations: GtfsFareAllocation[];
  source: 'gtfs-v1' | 'city-tariff-registry';
}

/** GTFS fares are per rider; scale them for the passenger count in a search. */
export function scaleGtfsFareForPassengers(
  fare: GtfsItineraryFare | null,
  passengerCount: number,
): GtfsItineraryFare | null {
  if (!fare) return null;
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 20) return null;
  const priceMinor = fare.priceMinor * passengerCount;
  const allocations = fare.allocations.map((allocation) => ({
    ...allocation, priceMinor: allocation.priceMinor * passengerCount,
  }));
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0
    || allocations.some((allocation) => !Number.isSafeInteger(allocation.priceMinor) || allocation.priceMinor < 0)) return null;
  return { ...fare, priceMinor, allocations };
}

const V2_FILES = [
  'fare_media.txt', 'fare_products.txt', 'fare_leg_rules.txt', 'fare_leg_join_rules.txt',
  'fare_transfer_rules.txt', 'rider_categories.txt', 'timeframes.txt', 'networks.txt',
  'route_networks.txt', 'areas.txt', 'stop_areas.txt',
];

function csvRows(bytes: Uint8Array | undefined): Array<Record<string, string>> {
  if (!bytes) return [];
  const lines = strFromU8(bytes).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((name) => name.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((name, index) => [name, values[index] ?? '']));
  });
}

function nonNegativeInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function priceToMinor(rawPrice: string | undefined, currency: string | undefined): number | null {
  if (!rawPrice || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price < 0) return null;
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const scale = 10 ** digits;
    const minor = Math.round(price * scale);
    if (!Number.isSafeInteger(minor) || Math.abs(price * scale - minor) > 1e-6) return null;
    return minor;
  } catch {
    return null;
  }
}

export function parseGtfsFares(files: Record<string, Uint8Array>): ParsedGtfsFares {
  const faresV2Present = V2_FILES.some((name) => Boolean(files[name]));
  const products = new Map<string, GtfsFareProduct>();
  const rules = new Map<string, GtfsFareRule[]>();
  const agencies = csvRows(files['agency.txt']);
  const agencyIds = new Set(agencies.map((row) => row.agency_id).filter(Boolean));

  for (const row of csvRows(files['fare_attributes.txt'])) {
    const currency = row.currency_type?.trim().toUpperCase();
    const priceMinor = priceToMinor(row.price?.trim(), currency);
    const transfersRaw = row.transfers?.trim();
    const transfers = transfersRaw === '' ? null : nonNegativeInteger(transfersRaw);
    const transferDurationSeconds = row.transfer_duration?.trim()
      ? nonNegativeInteger(row.transfer_duration.trim()) : null;
    if (!row.fare_id || priceMinor === null || transfersRaw !== '' && (transfers === null || transfers > 2)
      || row.payment_method !== '0' && row.payment_method !== '1'
      || row.transfer_duration?.trim() && transferDurationSeconds === null) continue;
    const agencyId = row.agency_id?.trim();
    // GTFS requires agency_id when a feed contains multiple agencies. Do not
    // widen an ambiguous fare to every operator in that invalid feed.
    if (agencyIds.size > 1 && !agencyId) continue;
    if (agencyId && !agencyIds.has(agencyId)) continue;
    products.set(row.fare_id, {
      id: row.fare_id, priceMinor, currency: currency!, transfers,
      transferDurationSeconds,
      ...(agencyId ? { agencyId } : {}),
    });
  }

  for (const row of csvRows(files['fare_rules.txt'])) {
    if (!products.has(row.fare_id)) continue;
    const rule: GtfsFareRule = {
      fareId: row.fare_id,
      ...(row.route_id?.trim() ? { routeId: row.route_id.trim() } : {}),
      ...(row.origin_id?.trim() ? { originZoneId: row.origin_id.trim() } : {}),
      ...(row.destination_id?.trim() ? { destinationZoneId: row.destination_id.trim() } : {}),
      ...(row.contains_id?.trim() ? { containsZoneId: row.contains_id.trim() } : {}),
    };
    const existing = rules.get(rule.fareId) ?? [];
    existing.push(rule);
    rules.set(rule.fareId, existing);
  }
  return { products, rules, faresV2Present };
}

function fareRulesMatch(rules: readonly GtfsFareRule[], legs: readonly GtfsFareLeg[]): boolean {
  if (rules.length === 0) return true;
  const routeRules = rules.filter((rule) => rule.routeId);
  if (routeRules.length > 0) {
    const permittedRoutes = new Set(routeRules.map((rule) => rule.routeId));
    if (legs.some((leg) => !permittedRoutes.has(leg.routeId))) return false;
  }

  const zoneRules = rules.filter((rule) => rule.originZoneId || rule.destinationZoneId || rule.containsZoneId);
  if (zoneRules.length === 0) return true;
  const originZone = legs[0].originZoneId;
  const destinationZone = legs.at(-1)!.destinationZoneId;
  const traveledZones = new Set(legs.flatMap((leg) => leg.traveledZoneIds));

  // Each zone rule row is an alternative endpoint/contains combination;
  // repeated contains IDs for the same endpoints are all required.
  const endpointGroups = new Map<string, GtfsFareRule[]>();
  for (const rule of zoneRules) {
    const key = `${rule.originZoneId ?? ''}\u0000${rule.destinationZoneId ?? ''}`;
    const group = endpointGroups.get(key) ?? [];
    group.push(rule);
    endpointGroups.set(key, group);
  }
  return [...endpointGroups.values()].some((group) => {
    const first = group[0];
    if (first.originZoneId && first.originZoneId !== originZone) return false;
    if (first.destinationZoneId && first.destinationZoneId !== destinationZone) return false;
    return group.every((rule) => !rule.containsZoneId || traveledZones.has(rule.containsZoneId));
  });
}

/**
 * Price an itinerary from legacy GTFS fares only when every boarded segment is
 * covered by a published fare. A ticket may cover subsequent legs when its
 * transfer count and validity window permit it. Unknown or Fares-v2-only data
 * stays unknown rather than turning into a zero fare.
 */
export function calculateGtfsItineraryFare(
  fares: ParsedGtfsFares,
  legs: readonly GtfsFareLeg[],
): GtfsItineraryFare | null {
  if (!legs.length || fares.faresV2Present || fares.products.size === 0) return null;
  if (legs.some((leg, index) => !Number.isFinite(leg.departureAt.getTime())
    || !Number.isFinite(leg.arrivalAt.getTime()) || leg.arrivalAt < leg.departureAt
    || index > 0 && leg.departureAt < legs[index - 1].arrivalAt)) return null;
  const productList = [...fares.products.values()];
  const memo = new Map<number, Array<{ priceMinor: number; currency: string; allocations: GtfsFareAllocation[] }>>();

  const solve = (start: number) => {
    const cached = memo.get(start);
    if (cached) return cached;
    if (start === legs.length) return [{ priceMinor: 0, currency: '', allocations: [] as GtfsFareAllocation[] }];
    const options: Array<{ priceMinor: number; currency: string; allocations: GtfsFareAllocation[] }> = [];
    const firstLeg = legs[start];
    for (const product of productList) {
      if (product.providerId && product.providerId !== firstLeg.providerId) continue;
      if (product.agencyId && product.agencyId !== firstLeg.agencyId) continue;
      const applicableRules = fares.rules.get(product.id) ?? [];
      const maxLegsByTransfers = product.transfers === null ? legs.length : product.transfers + 1;
      const maxEnd = Math.min(legs.length, start + maxLegsByTransfers);
      for (let end = start + 1; end <= maxEnd; end++) {
        const covered = legs.slice(start, end);
        if (covered.some((leg) => leg.providerId !== firstLeg.providerId
          || product.agencyId && leg.agencyId !== product.agencyId)) break;
        if (product.transferDurationSeconds !== null
          && (covered.at(-1)!.arrivalAt.getTime() - firstLeg.departureAt.getTime()) / 1000 > product.transferDurationSeconds) break;
        if (!fareRulesMatch(applicableRules, covered)) continue;
        for (const suffix of solve(end)) {
          if (suffix.currency && suffix.currency !== product.currency) continue;
          const allocations = covered.map((_, index) => ({
            priceMinor: index === 0 ? product.priceMinor : 0,
            currency: product.currency,
            fareProductId: product.id,
            includedByPreviousFare: index > 0,
          }));
          options.push({
            priceMinor: product.priceMinor + suffix.priceMinor,
            currency: suffix.currency || product.currency,
            allocations: [...allocations, ...suffix.allocations],
          });
        }
      }
    }
    const bestByCurrency = new Map<string, typeof options[number]>();
    for (const option of options) {
      const current = bestByCurrency.get(option.currency);
      if (!current || option.priceMinor < current.priceMinor) bestByCurrency.set(option.currency, option);
    }
    const result = [...bestByCurrency.values()];
    memo.set(start, result);
    return result;
  };

  const result = solve(0).sort((a, b) => a.priceMinor - b.priceMinor || a.currency.localeCompare(b.currency))[0];
  return result?.currency ? { ...result, source: 'gtfs-v1' } : null;
}
