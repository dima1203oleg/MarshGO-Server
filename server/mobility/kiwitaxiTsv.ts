/** Parser for the documented legacy Kiwitaxi TSV format (`\\N` is SQL NULL). */
export type KiwitaxiValue = string | null;
export type KiwitaxiRow = Record<string, KiwitaxiValue>;

function splitTsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === '\t') { fields.push(field); field = ''; }
    else field += char;
  }
  fields.push(field);
  return fields;
}

export function parseKiwitaxiTsv(text: string): { rows: KiwitaxiRow[]; rejectedRows: number } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  if (lines.length < 1 || !lines[0]?.trim()) return { rows: [], rejectedRows: 0 };
  const headers = splitTsvRow(lines[0]!).map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new TypeError('Kiwitaxi TSV header is empty or duplicated');
  const rows: KiwitaxiRow[] = [];
  let rejectedRows = 0;
  for (const line of lines.slice(1)) {
    const values = splitTsvRow(line);
    if (values.length !== headers.length) { rejectedRows++; continue; }
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] === '\\N' ? null : values[index]!] )));
  }
  return { rows, rejectedRows };
}

export function kiwitaxiConfigured(env: NodeJS.ProcessEnv = process.env): { catalogEnabled: boolean; affiliateEnabled: boolean } {
  return { catalogEnabled: Boolean(env.KIWITAXI_SECURITY_TOKEN?.trim()), affiliateEnabled: Boolean(env.KIWITAXI_PAP?.trim()) };
}
