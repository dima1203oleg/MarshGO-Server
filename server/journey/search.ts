import { JOURNEY_STRATEGIES, JOURNEY_TRANSPORT_TYPES, type JourneyPreferences, type JourneyStrategy } from './types';

export interface JourneySearchRequest {
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  departureAt: Date;
  passengers: number;
  strategy: JourneyStrategy;
  preferences: JourneyPreferences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlace(value: unknown, name: string): JourneySearchRequest['origin'] {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.trim().length > 160
    || !Array.isArray(value.coordinates) || value.coordinates.length !== 2) {
    throw new TypeError(`${name} must include a name and [longitude, latitude] coordinates`);
  }
  const [longitude, latitude] = value.coordinates;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new TypeError(`${name} coordinates must be valid WGS84 longitude and latitude`);
  }
  return { name: value.name.trim(), coordinates: [longitude, latitude] };
}

const preferenceBounds: Record<string, [number, number]> = {
  maxPriceMinor: [0, 100_000_000],
  maxTotalDurationSeconds: [60, 7 * 24 * 60 * 60],
  maxTransfers: [0, 20],
  maxWalkingMeters: [0, 100_000],
  minimumTransferBufferSeconds: [0, 7200],
  maxCommunityDetourSeconds: [0, 7200],
  maxCommunityDetourMeters: [0, 100_000],
};

export function parseJourneySearchRequest(value: unknown, now = new Date()): JourneySearchRequest {
  if (!isRecord(value)) throw new TypeError('request must be an object');
  const origin = parsePlace(value.origin, 'origin');
  const destination = parsePlace(value.destination, 'destination');
  if (origin.coordinates[0] === destination.coordinates[0] && origin.coordinates[1] === destination.coordinates[1]) {
    throw new TypeError('origin and destination must differ');
  }
  if (typeof value.departureAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.departureAt)) {
    throw new TypeError('departureAt must be an ISO date-time with an explicit timezone');
  }
  const departureAt = new Date(value.departureAt);
  if (!Number.isFinite(departureAt.getTime()) || departureAt <= now) throw new TypeError('departureAt must be in the future');
  if (!Number.isInteger(value.passengers) || (value.passengers as number) < 1 || (value.passengers as number) > 20) {
    throw new TypeError('passengers must be an integer from 1 to 20');
  }
  if (typeof value.strategy !== 'string' || !(JOURNEY_STRATEGIES as readonly string[]).includes(value.strategy)) {
    throw new TypeError('strategy is not supported');
  }
  const rawPreferences = value.preferences === undefined ? {} : value.preferences;
  if (!isRecord(rawPreferences)) throw new TypeError('preferences must be an object');
  const allowedPreferences = new Set([
    ...Object.keys(preferenceBounds), 'minDriverRating','preferredVehicleClass',
    'allowCommunity','allowTaxi','allowBus','allowMinibus','allowRail','allowPublicTransport','allowCarsharing','allowTransfer','allowedTransportTypes','allowedTransitProviders',
  ]);
  const unknownPreference = Object.keys(rawPreferences).find((key) => !allowedPreferences.has(key));
  if (unknownPreference) throw new TypeError(`unsupported preference: ${unknownPreference}`);
  const preferences: JourneyPreferences = {};
  for (const [key, bounds] of Object.entries(preferenceBounds)) {
    const raw = rawPreferences[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < bounds[0] || raw > bounds[1]) {
      throw new TypeError(`${key} is outside the supported range`);
    }
    if (key === 'maxPriceMinor') preferences.maxPriceMinor = raw;
    else if (key === 'maxTotalDurationSeconds') preferences.maxTotalDurationSeconds = raw;
    else if (key === 'maxTransfers') preferences.maxTransfers = raw;
    else if (key === 'maxWalkingMeters') preferences.maxWalkingMeters = raw;
    else if (key === 'minimumTransferBufferSeconds') preferences.minimumTransferBufferSeconds = raw;
    else if (key === 'maxCommunityDetourSeconds') preferences.maxCommunityDetourSeconds = raw;
    else if (key === 'maxCommunityDetourMeters') preferences.maxCommunityDetourMeters = raw;
  }
  for (const key of ['allowCommunity','allowTaxi','allowBus','allowMinibus','allowRail','allowPublicTransport','allowCarsharing','allowTransfer'] as const) {
    const raw = rawPreferences[key];
    if (raw !== undefined && typeof raw !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    if (typeof raw === 'boolean') preferences[key] = raw;
  }
  if (rawPreferences.allowedTransportTypes !== undefined) {
    const types = rawPreferences.allowedTransportTypes;
    if (!Array.isArray(types) || types.length > JOURNEY_TRANSPORT_TYPES.length
      || types.some((type) => typeof type !== 'string' || !(JOURNEY_TRANSPORT_TYPES as readonly string[]).includes(type))
      || new Set(types).size !== types.length) throw new TypeError('allowedTransportTypes is invalid');
    preferences.allowedTransportTypes = types as JourneyPreferences['allowedTransportTypes'];
  }
  if (rawPreferences.allowedTransitProviders !== undefined) {
    const providers = rawPreferences.allowedTransitProviders;
    if (!Array.isArray(providers) || providers.length > 100
      || providers.some((provider) => typeof provider !== 'string' || provider.trim().length < 2 || provider.trim().length > 120)
      || new Set(providers).size !== providers.length) throw new TypeError('allowedTransitProviders is invalid');
    preferences.allowedTransitProviders = providers as string[];
  }
  if (rawPreferences.minDriverRating !== undefined) {
    const rating = rawPreferences.minDriverRating;
    if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5) throw new TypeError('minDriverRating must be from 0 to 5');
    preferences.minDriverRating = rating;
  }
  if (rawPreferences.preferredVehicleClass !== undefined) {
    const value = rawPreferences.preferredVehicleClass;
    if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 40) throw new TypeError('preferredVehicleClass is invalid');
    preferences.preferredVehicleClass = value.trim();
  }
  return { origin, destination, departureAt, passengers: value.passengers as number, strategy: value.strategy as JourneyStrategy, preferences };
}
