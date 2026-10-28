export type RentalMode = 'BICYCLE' | 'SCOOTER';
export type RentalModel = 'STATION_BASED' | 'FREE_FLOATING' | 'STAFFED' | 'CONFIRMED_ONE_WAY' | 'UNKNOWN';
export type RentalReturnRule = 'SAME_LOCATION' | 'ANY_NETWORK_LOCATION' | 'FREE_FLOATING_ZONE' | 'ONE_WAY_CONFIRMED' | 'UNKNOWN';
export type RentalAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type ConfirmationLevel = 'VERIFIED' | 'CONDITIONAL' | 'UNKNOWN' | 'REJECTED';

export interface RentalLocation {
  id: string;
  providerId: string;
  networkId: string | null;
  mode: RentalMode;
  rentalModel: RentalModel;
  name: string;
  pickupAllowed: boolean | null;
  dropoffAllowed: boolean | null;
  availability: RentalAvailability;
  availableVehicles: number | null;
  availableDocks: number | null;
  vehicleTypes: string[];
  availabilityCheckedAt: Date | null;
  openingAtPickup: boolean | null;
  openingAtDropoff: boolean | null;
  geofenceAllowsPickup: boolean | null;
  geofenceAllowsDropoff: boolean | null;
}

export interface RentalNetworkRule {
  networkId: string;
  providerIds: string[];
  status: 'CONFIRMED' | 'UNKNOWN' | 'DISABLED';
  returnRule: RentalReturnRule;
  returnRuleSource: 'OWNER_ATTESTED' | 'PROVIDER_API' | 'PROVIDER_DOCUMENTATION' | 'UNKNOWN';
  crossProviderReturnConfirmed: boolean;
  maximumSnapshotAgeSeconds: number | null;
}

export interface CanRentInput {
  pickup: RentalLocation;
  dropoff: RentalLocation;
  vehicleType: string;
  departureAt: Date;
  arrivalAt: Date;
  networkRule: RentalNetworkRule | null;
  now?: Date;
  requireVerifiedReturn?: boolean;
  maximumRentalDurationSeconds?: number;
}

export interface RentalCompatibilityResult {
  allowed: boolean;
  confirmationLevel: ConfirmationLevel;
  reason: string;
  pickupLocationId: string;
  dropoffLocationId: string;
  providerId: string;
  networkId: string | null;
  returnRule: RentalReturnRule;
  returnRuleSource: 'OWNER_ATTESTED' | 'PROVIDER_API' | 'PROVIDER_DOCUMENTATION' | 'UNKNOWN';
  availabilityStatus: RentalAvailability;
  availabilityCheckedAt: string | null;
}

const result = (input: CanRentInput, allowed: boolean, confirmationLevel: ConfirmationLevel, reason: string): RentalCompatibilityResult => ({
  allowed,
  confirmationLevel,
  reason,
  pickupLocationId: input.pickup.id,
  dropoffLocationId: input.dropoff.id,
  providerId: input.pickup.providerId,
  networkId: input.networkRule?.networkId ?? null,
  returnRule: input.networkRule?.returnRule ?? 'UNKNOWN',
  returnRuleSource: input.networkRule?.returnRuleSource ?? 'UNKNOWN',
  availabilityStatus: input.pickup.availability === 'AVAILABLE' && input.dropoff.availability === 'AVAILABLE' ? 'AVAILABLE'
    : input.pickup.availability === 'UNAVAILABLE' || input.dropoff.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN',
  availabilityCheckedAt: [input.pickup.availabilityCheckedAt, input.dropoff.availabilityCheckedAt]
    .filter((date): date is Date => date instanceof Date && Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
});

/** Fail-closed check: a map point alone never proves a rental or a legal return. */
export function canRent(input: CanRentInput): RentalCompatibilityResult {
  const { pickup, dropoff, networkRule } = input;
  const no = (reason: string, level: ConfirmationLevel = 'REJECTED') => result(input, false, level, reason);
  if (!pickup.id || !dropoff.id || pickup.id === dropoff.id) return no('Pickup and drop-off must be distinct identified locations.');
  if (pickup.mode !== dropoff.mode || (pickup.mode !== 'BICYCLE' && pickup.mode !== 'SCOOTER')) return no('Pickup and drop-off must support the same rental mode.');
  if (!Number.isFinite(input.departureAt.getTime()) || !Number.isFinite(input.arrivalAt.getTime()) || input.arrivalAt <= input.departureAt) return no('Rental times are invalid.');
  const duration = (input.arrivalAt.getTime() - input.departureAt.getTime()) / 1000;
  if (input.maximumRentalDurationSeconds !== undefined && duration > input.maximumRentalDurationSeconds) return no('Rental duration exceeds the configured limit.');
  if (!pickup.vehicleTypes.includes(input.vehicleType) || !dropoff.vehicleTypes.includes(input.vehicleType)) return no('This vehicle type is not supported at both locations.');
  if (!networkRule || networkRule.status !== 'CONFIRMED' || pickup.networkId !== networkRule.networkId || dropoff.networkId !== networkRule.networkId) return no('A shared, confirmed rental network has not been established.', 'UNKNOWN');
  const sameProvider = pickup.providerId === dropoff.providerId;
  if (!sameProvider && !(networkRule.crossProviderReturnConfirmed && networkRule.providerIds.includes(pickup.providerId) && networkRule.providerIds.includes(dropoff.providerId))) return no('Different operators cannot share one rental session without a confirmed interoperability agreement.');
  if (!networkRule.providerIds.includes(pickup.providerId) || !networkRule.providerIds.includes(dropoff.providerId)) return no('One or both locations are outside this network.');
  if (networkRule.returnRule === 'UNKNOWN' || networkRule.returnRule === 'ONE_WAY_CONFIRMED' && pickup.rentalModel !== 'CONFIRMED_ONE_WAY') return no('The operator has not confirmed this return rule.', 'UNKNOWN');
  if (pickup.pickupAllowed !== true) return no('Pickup is not confirmed at the selected point.', pickup.pickupAllowed === null ? 'UNKNOWN' : 'REJECTED');
  if (dropoff.dropoffAllowed !== true) return no('Drop-off is not confirmed at the selected point.', dropoff.dropoffAllowed === null ? 'UNKNOWN' : 'REJECTED');
  if (pickup.availability !== 'AVAILABLE' || (pickup.availableVehicles !== null && pickup.availableVehicles < 1)) return no('A currently available vehicle is not confirmed at pickup.', pickup.availability === 'UNKNOWN' ? 'UNKNOWN' : 'REJECTED');
  if (dropoff.rentalModel === 'STATION_BASED' && dropoff.availableDocks === null) return no('Available return docks are unknown for this station.', 'UNKNOWN');
  if (dropoff.availability !== 'AVAILABLE' || (dropoff.availableDocks !== null && dropoff.availableDocks < 1)) return no('A currently available return space is not confirmed.', dropoff.availability === 'UNKNOWN' ? 'UNKNOWN' : 'REJECTED');
  if (pickup.openingAtPickup !== true || dropoff.openingAtDropoff !== true) return no('Opening hours do not confirm service at both rental times.', 'UNKNOWN');
  if (pickup.rentalModel === 'FREE_FLOATING' && (pickup.geofenceAllowsPickup !== true || dropoff.geofenceAllowsDropoff !== true)) return no('The operator geofence does not confirm pickup and return at these coordinates.');
  if (networkRule.returnRule === 'SAME_LOCATION' && pickup.id !== dropoff.id) return no('This staffed rental must be returned to the pickup location.');
  const checkedAtValues = [pickup.availabilityCheckedAt, dropoff.availabilityCheckedAt]
    .map((date) => date?.getTime()).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const maxAge = networkRule.maximumSnapshotAgeSeconds;
  const now = (input.now ?? new Date()).getTime();
  if (checkedAtValues.length !== 2 || maxAge === null || checkedAtValues.some((checkedAt) => checkedAt > now || now - checkedAt > maxAge * 1000)) {
    return no('Availability data is missing or stale; the route cannot guarantee a rental.', 'UNKNOWN');
  }
  return result(input, true, 'VERIFIED', 'Operator, network, pickup, availability, and return rule are confirmed.');
}
