/** Public Photon is a low-volume evaluation demo, not a production dependency. */
export function isPublicPhotonEvaluationEndpoint(endpoint: URL): boolean {
  return endpoint.hostname.replace(/\.$/, '').toLowerCase() === 'photon.komoot.io';
}

export const PUBLIC_PHOTON_PRODUCTION_ERROR =
  'The public Photon endpoint is evaluation-only; configure an approved contracted or self-hosted geocoder';
