/**
 * Return a comparable journey fare only when every priced leg has a known,
 * non-negative amount in the same minor currency unit. A transit subtotal
 * cannot stand in for a complete micromobility rental quote.
 */
export function micromobilityJourneyFareMinor(
  transitFareMinor: number | null,
  rentalFareMinor: number | null,
): number | null {
  if (transitFareMinor === null || rentalFareMinor === null
    || !Number.isSafeInteger(transitFareMinor) || transitFareMinor < 0
    || !Number.isSafeInteger(rentalFareMinor) || rentalFareMinor < 0) return null;

  const total = transitFareMinor + rentalFareMinor;
  return Number.isSafeInteger(total) ? total : null;
}
