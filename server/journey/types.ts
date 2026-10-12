export const JOURNEY_STRATEGIES = ['FASTEST', 'CHEAPEST', 'BALANCED', 'PREMIUM', 'RELIABLE', 'CUSTOM'] as const;
export type JourneyStrategy = typeof JOURNEY_STRATEGIES[number];

export type JourneyLegMode =
  | 'WALK' | 'COMMUNITY' | 'COMMUNITY_DEMAND' | 'TAXI' | 'TRANSFER' | 'BUS' | 'MINIBUS'
  | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'URBAN_BUS' | 'CARSHARING' | 'FERRY' | 'FUNICULAR';

/** Public selection categories. Feed-specific aliases belong to Journey segments, never to user preferences. */
export const JOURNEY_TRANSPORT_TYPES = ['bus','marshrutka','trolleybus','tram','metro','carpool','taxi','train','bike','scooter','carsharing','transfer'] as const;
export type JourneyTransportType = typeof JOURNEY_TRANSPORT_TYPES[number];

const journeyTransportAliases: Partial<Record<JourneyTransportType, readonly string[]>> = {
  bus: ['intercity_bus'],
  train: ['suburban_train', 'city_train'],
};

/** Map a feed-specific segment type or accepted legacy preference to its public category. */
export function canonicalJourneyTransportType(value: string): JourneyTransportType | null {
  if ((JOURNEY_TRANSPORT_TYPES as readonly string[]).includes(value)) return value as JourneyTransportType;
  return JOURNEY_TRANSPORT_TYPES.find((type) => journeyTransportAliases[type]?.includes(value)) ?? null;
}

export function journeyTransportTypeSelected(
  actual: string,
  selected?: readonly JourneyTransportType[],
): boolean {
  if (!selected) return true;
  const category = canonicalJourneyTransportType(actual);
  return category !== null && selected.includes(category);
}

export interface JourneyOption {
  id: string;
  durationSeconds: number;
  priceMinor: number | null;
  transfers: number;
  walkingMeters: number;
  reliability: number | null;
  transferRisk: number;
  comfort: number | null;
  /** Stable grouping key used to avoid filling the result list with near-identical runs. */
  diversityKey?: string | null;
  legs: Array<{ mode: JourneyLegMode; providerId?: string | null }>;
}

export interface JourneyPreferences {
  maxPriceMinor?: number;
  maxTotalDurationSeconds?: number;
  maxTransfers?: number;
  maxWalkingMeters?: number;
  minDriverRating?: number;
  minimumTransferBufferSeconds?: number;
  maxCommunityDetourSeconds?: number;
  maxCommunityDetourMeters?: number;
  allowCommunity?: boolean;
  allowTaxi?: boolean;
  allowBus?: boolean;
  allowMinibus?: boolean;
  allowRail?: boolean;
  allowPublicTransport?: boolean;
  allowCarsharing?: boolean;
  allowTransfer?: boolean;
  preferredVehicleClass?: string;
  allowedTransportTypes?: JourneyTransportType[];
  allowedTransitProviders?: string[];
  allowedTransitProvidersByType?: Partial<Record<JourneyTransportType, string[]>>;
}
