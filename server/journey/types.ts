export const JOURNEY_STRATEGIES = ['FASTEST', 'CHEAPEST', 'BALANCED', 'PREMIUM', 'RELIABLE', 'CUSTOM'] as const;
export type JourneyStrategy = typeof JOURNEY_STRATEGIES[number];

export type JourneyLegMode =
  | 'WALK' | 'COMMUNITY' | 'COMMUNITY_DEMAND' | 'TAXI' | 'TRANSFER' | 'BUS' | 'MINIBUS'
  | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'URBAN_BUS' | 'CARSHARING';

export interface JourneyOption {
  id: string;
  durationSeconds: number;
  priceMinor: number | null;
  transfers: number;
  walkingMeters: number;
  reliability: number | null;
  transferRisk: number;
  comfort: number | null;
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
}
