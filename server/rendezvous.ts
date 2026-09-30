export type RendezvousState =
  | 'SCHEDULED' | 'ACTIVATING' | 'ACTIVE' | 'DRIVER_APPROACHING' | 'PASSENGER_APPROACHING'
  | 'DRIVER_WAITING' | 'PASSENGER_WAITING' | 'BOTH_NEARBY' | 'BOARDING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export type RendezvousActor = 'driver' | 'passenger';
export type RendezvousAction = 'approaching' | 'arrived' | 'delayed' | 'will_arrive' | 'cannot_make_it';

export interface RendezvousTransition {
  state: RendezvousState;
  eventType: string;
  arrivalField?: 'driver_arrived_at' | 'passenger_arrived_at';
  terminal: boolean;
}

const terminalStates = new Set<RendezvousState>(['COMPLETED', 'CANCELLED', 'EXPIRED']);

export function resolveRendezvousAction(
  actor: RendezvousActor,
  action: RendezvousAction,
  currentState: RendezvousState,
): RendezvousTransition {
  if (terminalStates.has(currentState) || currentState === 'BOARDING') {
    throw new Error('rendezvous is no longer accepting status updates');
  }
  const actorAlreadyArrived = actor === 'driver'
    ? currentState === 'DRIVER_WAITING' || currentState === 'BOTH_NEARBY'
    : currentState === 'PASSENGER_WAITING' || currentState === 'BOTH_NEARBY';
  if (actorAlreadyArrived && action !== 'arrived') {
    throw new Error('an arrived participant cannot move back to an approaching state');
  }
  if (action === 'cannot_make_it') {
    return { state: 'CANCELLED', eventType: `rendezvous.${actor}.cannot-make-it`, terminal: true };
  }
  if (action === 'delayed') {
    return { state: currentState, eventType: `rendezvous.${actor}.delayed`, terminal: false };
  }
  if (action === 'will_arrive') {
    return { state: actor === 'driver' ? 'DRIVER_APPROACHING' : 'PASSENGER_APPROACHING', eventType: `rendezvous.${actor}.will-arrive`, terminal: false };
  }
  if (action === 'approaching') {
    return { state: actor === 'driver' ? 'DRIVER_APPROACHING' : 'PASSENGER_APPROACHING', eventType: `rendezvous.${actor}.approaching`, terminal: false };
  }
  const driverHere = actor === 'driver' || currentState === 'DRIVER_WAITING' || currentState === 'BOTH_NEARBY';
  const passengerHere = actor === 'passenger' || currentState === 'PASSENGER_WAITING' || currentState === 'BOTH_NEARBY';
  return {
    state: driverHere && passengerHere ? 'BOTH_NEARBY' : actor === 'driver' ? 'DRIVER_WAITING' : 'PASSENGER_WAITING',
    eventType: `rendezvous.${actor}.arrived`,
    arrivalField: actor === 'driver' ? 'driver_arrived_at' : 'passenger_arrived_at',
    terminal: false,
  };
}

export function isWithinPickupGeofence(distanceMeters: number, accuracyMeters: number, radiusMeters = 75): boolean {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || !Number.isFinite(accuracyMeters)
    || accuracyMeters < 0 || accuracyMeters > 100 || !Number.isFinite(radiusMeters) || radiusMeters < 50 || radiusMeters > 100) return false;
  // Conservative: the reported accuracy circle must fit inside the geofence.
  return distanceMeters + accuracyMeters <= radiusMeters;
}

export function rendezvousActivationAt(pickupAt: Date, leadMinutes = 15): Date {
  if (!Number.isFinite(pickupAt.getTime()) || !Number.isInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 60) {
    throw new TypeError('pickup time and rendezvous activation lead must be valid');
  }
  return new Date(pickupAt.getTime() - leadMinutes * 60_000);
}

export function getRendezvousSettings(environment: Record<string, string | undefined>) {
  const geofenceMeters = Number(environment.RENDEZVOUS_GEOFENCE_METERS ?? '75');
  const leadMinutes = Number(environment.RENDEZVOUS_LEAD_MINUTES ?? '15');
  if (!Number.isInteger(geofenceMeters) || geofenceMeters < 50 || geofenceMeters > 100) {
    throw new Error('RENDEZVOUS_GEOFENCE_METERS must be an integer between 50 and 100');
  }
  if (!Number.isInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 60) {
    throw new Error('RENDEZVOUS_LEAD_MINUTES must be an integer between 1 and 60');
  }
  return { geofenceMeters, leadMinutes } as const;
}
