export type SmokeItinerarySegment = {
  transportType: string;
};

export type SmokeItinerary = {
  segments: readonly SmokeItinerarySegment[];
};

export function withOptionalSourceFingerprint<T extends object>(
  value: T,
  field: 'sourceVersion' | 'staticFeedSha256',
  fingerprint?: string,
) {
  return fingerprint ? { ...value, [field]: fingerprint } : value;
}

type SmokeJourneySegment = {
  providerId: string;
  routeId: string;
  routeName: string;
  tripId: string;
  serviceDate: string;
  staticFeedSha256?: string;
  transportType: string;
  scheduleSemantics: string;
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  departureAt: Date;
  arrivalAt: Date;
  originStop: { id: string; name: string; coordinates: [number, number] };
  destinationStop: { id: string; name: string; coordinates: [number, number] };
};

type SmokeJourneyEvidence = {
  id: string;
  segments: readonly SmokeJourneySegment[];
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  walkingMeters: number;
  waitingSeconds: number;
  transfers: number;
  transferWalkingMeters: readonly number[];
  transferWalkingSeconds: readonly number[];
  transferMinimumBufferSeconds: readonly number[];
  transferRuleMinimumSeconds: readonly (number | null)[];
  transferInSeat: readonly boolean[];
};

export function serializeSmokeJourney(journey: SmokeJourneyEvidence) {
  return {
    id: journey.id,
    departureAt: journey.departureAt.toISOString(),
    arrivalAt: journey.arrivalAt.toISOString(),
    durationSeconds: journey.durationSeconds,
    walkingMeters: journey.walkingMeters,
    waitingSeconds: journey.waitingSeconds,
    transfers: journey.transfers,
    transferWalkingMeters: journey.transferWalkingMeters,
    transferWalkingSeconds: journey.transferWalkingSeconds,
    transferMinimumBufferSeconds: journey.transferMinimumBufferSeconds,
    transferRuleMinimumSeconds: journey.transferRuleMinimumSeconds,
    transferInSeat: journey.transferInSeat,
    segments: journey.segments.map((segment) => ({
      providerId: segment.providerId,
      routeId: segment.routeId,
      routeName: segment.routeName,
      tripId: segment.tripId,
      serviceDate: segment.serviceDate,
      ...(segment.staticFeedSha256 ? { staticFeedSha256: segment.staticFeedSha256 } : {}),
      transportType: segment.transportType,
      scheduleSemantics: segment.scheduleSemantics,
      scheduledDepartureAt: segment.scheduledDepartureAt.toISOString(),
      scheduledArrivalAt: segment.scheduledArrivalAt.toISOString(),
      departureAt: segment.departureAt.toISOString(),
      arrivalAt: segment.arrivalAt.toISOString(),
      originStop: segment.originStop,
      destinationStop: segment.destinationStop,
    })),
  };
}

export function summarizeSmokeItineraries(itineraries: readonly SmokeItinerary[]) {
  const modeChains = new Map<string, { modes: string[]; count: number }>();
  let multiLegCount = 0;
  let maximumLegCount = 0;

  for (const itinerary of itineraries) {
    const modes = itinerary.segments.map((segment) => segment.transportType);
    if (modes.length > 1) multiLegCount += 1;
    maximumLegCount = Math.max(maximumLegCount, modes.length);

    const key = JSON.stringify(modes);
    const existing = modeChains.get(key);
    if (existing) existing.count += 1;
    else modeChains.set(key, { modes, count: 1 });
  }

  return {
    returnedItineraryCount: itineraries.length,
    multiLegCount,
    maximumLegCount,
    modeChainCounts: [...modeChains.values()].sort((a, b) => {
      const left = a.modes.join('\u0000');
      const right = b.modes.join('\u0000');
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}
