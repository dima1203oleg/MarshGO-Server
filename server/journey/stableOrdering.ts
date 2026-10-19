/** Compare opaque journey/provider identifiers reproducibly, independent of locale. */
export function compareStableId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
