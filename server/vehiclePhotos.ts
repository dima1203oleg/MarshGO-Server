/** Ensure a requested photo order is an exact permutation of this vehicle's photos. */
export function isExactVehiclePhotoOrder(requested: unknown, existingIds: readonly string[], limit: number): requested is string[] {
  if (!Array.isArray(requested) || requested.length !== existingIds.length || requested.length > limit) return false;
  if (!requested.every((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) return false;
  const existing = new Set(existingIds);
  if (existing.size !== existingIds.length || new Set(requested).size !== requested.length) return false;
  return requested.every((id) => existing.has(id));
}
