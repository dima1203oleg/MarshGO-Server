/** Unified MARSHGO mobility model: every external source (GBFS, GTFS, partner API...) is normalised into these shapes. */
export type MobilityAssetType = 'BIKE' | 'EBIKE' | 'SCOOTER' | 'MOPED' | 'CARSHARING' | 'TAXI';
export interface MobilityAsset {
  id: string;
  providerId: string;
  type: MobilityAssetType;
  location: [number, number]; // [longitude, latitude]
  available: boolean;
  batteryPercent?: number;
  rangeMeters?: number;
  stationId?: string;
  lastUpdated?: string;
}
export interface MobilityStation {
  id: string;
  providerId: string;
  name: string;
  location: [number, number];
  capacity?: number;
  availableAssets?: number;
  returnAllowed?: boolean;
}
export type ProviderHealth = 'healthy' | 'degraded' | 'offline';
export interface ConnectionReport {
  health: ProviderHealth;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  counts: Record<string, number>;
  responseMs: number;
  error?: string;
}
