import type { JourneyLegMode } from '../journey/types';

export type ProviderAvailability = 'LIVE' | 'SEARCH_ONLY' | 'BLOCKED_EXTERNAL' | 'DISABLED';

export interface ProviderSearchContext {
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  departureWindow: { earliest: Date; latest: Date };
  passengers: number;
  currency: string;
}

export interface ProviderOption {
  id: string;
  providerId: string;
  providerType: string;
  mode: JourneyLegMode;
  /** Canonical stop/place identity; never derived by comparing display names. */
  originNodeId?: string;
  destinationNodeId?: string;
  origin: ProviderSearchContext['origin'];
  destination: ProviderSearchContext['destination'];
  departureAt: Date | null;
  arrivalAt: Date | null;
  durationSeconds: number | null;
  etaUncertaintySeconds: number;
  distanceMeters: number | null;
  priceMinor: number | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  currency: string;
  priceStatus: 'LOCKED' | 'ESTIMATED' | 'DYNAMIC' | 'UNKNOWN';
  availability: 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE' | 'UNKNOWN' | 'BLOCKED_EXTERNAL';
  reliability: number | null;
  comfort: number | null;
  sourceFreshAt: Date | null;
  dataSource: string;
  metadata: Record<string, unknown>;
}

export interface ProviderQuote {
  optionId: string;
  amountMinor: number | null;
  minimumAmountMinor: number | null;
  maximumAmountMinor: number | null;
  currency: string;
  status: 'LOCKED' | 'ESTIMATED' | 'DYNAMIC' | 'UNKNOWN';
  expiresAt: Date | null;
}

export interface ProviderBooking {
  providerBookingId: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';
  confirmationReference?: string;
}

export interface TransportProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  search(context: ProviderSearchContext): Promise<ProviderOption[]>;
  quote(option: ProviderOption): Promise<ProviderQuote>;
  availabilityFor(option: ProviderOption): Promise<ProviderOption['availability']>;
  book?(option: ProviderOption, userId: string): Promise<ProviderBooking>;
  cancel?(booking: ProviderBooking): Promise<void>;
  status?(booking: ProviderBooking): Promise<ProviderBooking['status']>;
}
