/** Latin look-alikes of the Cyrillic letters used on Ukrainian plates (А В Е І К М Н О Р С Т Х). */
const cyrillicToLatin: Record<string, string> = { 'А': 'A', 'В': 'B', 'Е': 'E', 'І': 'I', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X' };

/** Returns the canonical plate (uppercase Latin, no spaces/dashes) or null when the format is not plausible. */
export function normalizePlate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.toUpperCase().replace(/[\s\-_.]/g, '');
  const latin = [...compact].map((char) => cyrillicToLatin[char] ?? char).join('');
  if (/^[A-Z]{2}\d{4}[A-Z]{2}$/.test(latin)) return latin; // standard: AA1234BB
  if (/^[A-Z0-9]{3,8}$/.test(latin) && /[A-Z]/.test(latin) && /\d|[A-Z]{3,}/.test(latin)) return latin; // personalised / older formats
  return null;
}
