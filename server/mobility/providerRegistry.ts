/** Canonical operator registry. Feed records describe sources; these records describe who provides the actual mobility service. */
export type IntegrationStatus = 'ACTIVE_LIVE' | 'ACTIVE_STATIC' | 'CATALOG_ONLY' | 'AFFILIATE_LINK_ONLY' | 'SANDBOX_ONLY' | 'AWAITING_CREDENTIALS' | 'AWAITING_AGREEMENT' | 'DISABLED' | 'ERROR';
export type ProviderGroup = 'TAXI' | 'TRANSFER' | 'SCOOTER' | 'BICYCLE' | 'CARSHARING' | 'PUBLIC_TRANSPORT';
export type MobilitySource = 'GBFS' | 'OSM' | 'REST' | 'CSV' | 'MANUAL' | 'PARTNER_API';

export interface MobilityOperator {
  providerId: string;
  providerName: string;
  providerGroup: ProviderGroup;
  dataSource: MobilitySource;
  sourceUrl: string;
  integrationStatus: IntegrationStatus;
  dataFreshnessSeconds: number | null;
  bookingMethod: 'DEEPLINK' | 'PARTNER_API' | 'IN_APP' | 'NONE' | 'UNKNOWN';
  pricingCapability: 'LIVE' | 'CATALOG' | 'STATIC' | 'UNKNOWN' | 'NONE';
  liveAvailabilityCapability: boolean;
  commercialPermissions: 'CONFIRMED' | 'ATTRIBUTION_REQUIRED' | 'PARTNER_ONLY' | 'UNKNOWN';
  attributionRequirements: string | null;
  enabled: boolean;
}

/** Explicitly conservative starting states; no partner credentials or return terms are inferred. */
export const initialMobilityOperators: readonly MobilityOperator[] = [
  { providerId: 'kiwitaxi', providerName: 'Kiwitaxi', providerGroup: 'TRANSFER', dataSource: 'CSV', sourceUrl: 'https://kiwitaxi.com/en/partner/webmaster/instructions/api/', integrationStatus: 'AWAITING_CREDENTIALS', dataFreshnessSeconds: null, bookingMethod: 'UNKNOWN', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'PARTNER_ONLY', attributionRequirements: 'Partner security token, affiliate ID (pap), and current partner terms must be supplied.', enabled: false },
  { providerId: 'intui_travel', providerName: 'Intui.travel', providerGroup: 'TRANSFER', dataSource: 'PARTNER_API', sourceUrl: 'https://partner.intui.travel/en/auth/', integrationStatus: 'AWAITING_CREDENTIALS', dataFreshnessSeconds: null, bookingMethod: 'PARTNER_API', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'PARTNER_ONLY', attributionRequirements: 'API Light credentials and partner agreement required; API Wide requires additional agreement.', enabled: false },
  { providerId: 'zelectra', providerName: 'Zelectra', providerGroup: 'SCOOTER', dataSource: 'GBFS', sourceUrl: 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs', integrationStatus: 'ACTIVE_LIVE', dataFreshnessSeconds: 0, bookingMethod: 'DEEPLINK', pricingCapability: 'CATALOG', liveAvailabilityCapability: true, commercialPermissions: 'ATTRIBUTION_REQUIRED', attributionRequirements: 'Live feed contains Kyiv and out-of-country coordinates; filter by the requested Ukraine viewport. Rental return rules remain unverified. Recheck source terms before release.', enabled: true },
  { providerId: 'nextbike_ua', providerName: 'Nextbike', providerGroup: 'BICYCLE', dataSource: 'OSM', sourceUrl: 'https://www.openstreetmap.org/copyright', integrationStatus: 'ACTIVE_STATIC', dataFreshnessSeconds: null, bookingMethod: 'UNKNOWN', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'ATTRIBUTION_REQUIRED', attributionRequirements: 'OSM locations only; © OpenStreetMap contributors, ODbL 1.0. No live stock or inter-station return rules are confirmed.', enabled: true },
  { providerId: 'bikenow', providerName: 'BikeNow', providerGroup: 'BICYCLE', dataSource: 'PARTNER_API', sourceUrl: 'https://bikenow.com.ua/', integrationStatus: 'AWAITING_AGREEMENT', dataFreshnessSeconds: null, bookingMethod: 'UNKNOWN', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'PARTNER_ONLY', attributionRequirements: 'Written display/data permission and network return rules required.', enabled: false },
  { providerId: 'veliki_ua', providerName: 'Veliki.ua', providerGroup: 'BICYCLE', dataSource: 'MANUAL', sourceUrl: 'https://veliki.ua/vsi-punkti-prokatu.html', integrationStatus: 'ACTIVE_STATIC', dataFreshnessSeconds: null, bookingMethod: 'UNKNOWN', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'UNKNOWN', attributionRequirements: 'Source attribution; confirm terms before commercial reuse.', enabled: true },
  { providerId: 'bicycle_operator_unknown', providerName: 'Непідтверджений велопрокат', providerGroup: 'BICYCLE', dataSource: 'OSM', sourceUrl: 'https://www.openstreetmap.org/copyright', integrationStatus: 'ACTIVE_STATIC', dataFreshnessSeconds: null, bookingMethod: 'UNKNOWN', pricingCapability: 'UNKNOWN', liveAvailabilityCapability: false, commercialPermissions: 'ATTRIBUTION_REQUIRED', attributionRequirements: '© OpenStreetMap contributors, ODbL 1.0.', enabled: true },
];

export function getMobilityOperator(providerId: string): MobilityOperator | undefined {
  return initialMobilityOperators.find((operator) => operator.providerId === providerId);
}
